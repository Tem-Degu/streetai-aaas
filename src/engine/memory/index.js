import fs from 'fs';
import path from 'path';
import { readJson, writeJson } from '../../utils/workspace.js';

const FACTS_FILE = 'facts.json';
const ACTIVITY_FILE = 'activity.jsonl';

const VALID_ACTIVITY_TYPES = new Set([
  'transaction_created',
  'transaction_updated',
  'transaction_completed',
  'transaction_disputed',
  'alert_sent',
  'alert_response',
  'extension_called',
  'note',
]);

const EXTRACT_PROMPT = `Based on this conversation, extract any facts worth remembering for future conversations.
Only extract genuinely useful information like:
- User preferences, requirements, or personal details they shared
- Decisions made or commitments agreed upon
- Important observations about the service context

DO NOT extract:
- Temporary technical errors, failures, or limitations (e.g., "unable to send images", "reached daily limit")
- Apologies or statements about current inability to do something
- Troubleshooting status or debugging observations
These are transient states, not facts. Only extract enduring truths.

Return a JSON array of objects: [{ "key": "short_label", "value": "the fact" }]
If nothing worth remembering, return an empty array: []
Return ONLY valid JSON, no markdown or explanation.`;

export class MemoryManager {
  constructor(workspace) {
    this.factsPath = path.join(workspace, 'memory', FACTS_FILE);
    this.activityPath = path.join(workspace, 'memory', ACTIVITY_FILE);
  }

  getAllFacts() {
    return readJson(this.factsPath) || [];
  }

  /**
   * Get facts relevant to a query, scored by keyword overlap.
   * Returns facts that fit within the token budget.
   */
  getRelevantFacts(query, maxTokens = 2000) {
    const facts = this.getAllFacts();
    if (facts.length === 0 || !query) return [];

    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    if (queryWords.length === 0) return facts.slice(-10); // return recent if no meaningful query

    // Score each fact by keyword overlap + recency + access frequency
    const scored = facts.map((f, idx) => {
      const text = `${f.key} ${f.value}`.toLowerCase();
      const wordMatches = queryWords.filter(w => text.includes(w)).length;
      const recencyBonus = idx / facts.length; // newer = higher index = higher bonus
      const accessBonus = Math.min((f.accessCount || 0) / 10, 1);

      return {
        ...f,
        score: wordMatches * 3 + recencyBonus + accessBonus,
      };
    });

    // Sort by score descending, take top results within budget
    scored.sort((a, b) => b.score - a.score);

    const selected = [];
    let tokens = 0;
    for (const fact of scored) {
      if (fact.score <= 0) break;
      const factTokens = Math.ceil((`${fact.key}: ${fact.value}`).length / 4);
      if (tokens + factTokens > maxTokens) break;
      selected.push(fact);
      tokens += factTokens;
    }

    // Bump access counts
    if (selected.length > 0) {
      const allFacts = this.getAllFacts();
      for (const sel of selected) {
        const match = allFacts.find(f => f.key === sel.key);
        if (match) match.accessCount = (match.accessCount || 0) + 1;
      }
      this._save(allFacts);
    }

    return selected;
  }

  addFact(key, value) {
    const facts = this.getAllFacts();
    const existing = facts.findIndex(f => f.key === key);

    if (existing >= 0) {
      facts[existing].value = value;
      facts[existing].updatedAt = new Date().toISOString();
    } else {
      facts.push({
        key,
        value,
        createdAt: new Date().toISOString(),
        accessCount: 0,
      });
    }

    this._save(facts);
  }

  removeFact(key) {
    const facts = this.getAllFacts();
    const idx = facts.findIndex(f => f.key === key);
    if (idx >= 0) {
      facts.splice(idx, 1);
      this._save(facts);
      return true;
    }
    return false;
  }

  pruneOldest(maxFacts = 200) {
    const facts = this.getAllFacts();
    if (facts.length <= maxFacts) return;

    // Sort by accessCount ascending (least accessed first), then by age
    facts.sort((a, b) => (a.accessCount || 0) - (b.accessCount || 0));
    const pruned = facts.slice(-(maxFacts));
    this._save(pruned);
  }

  /**
   * After a conversation, ask the LLM to extract facts worth remembering.
   */
  async extractFacts(provider, messages) {
    if (!messages || messages.length < 2) return;

    const conversationText = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .slice(-10) // only look at recent messages
      .map(m => `${m.role}: ${m.content}`)
      .join('\n');

    try {
      const result = await provider.chat([
        { role: 'system', content: EXTRACT_PROMPT },
        { role: 'user', content: conversationText },
      ], { maxTokens: 500, temperature: 0 });

      const parsed = JSON.parse(result.content);
      if (Array.isArray(parsed)) {
        for (const { key, value } of parsed) {
          if (key && value) this.addFact(key, value);
        }
      }
    } catch {
      // Extraction failed — not critical, skip silently
    }
  }

  _save(facts) {
    writeJson(this.factsPath, facts);
  }

  // ─── Activity log ─────────────────────────────────────────────
  // Append-only JSON-lines journal of notable things the agent has done.
  // Used to answer questions like "what have you been doing for the last
  // 24 hours?" without scanning sessions.

  /**
   * Append one activity entry. `entry` shape:
   *   { type, summary, context?, session_id? }
   * `ts` is set automatically. Returns the persisted entry, or null if
   * the entry was rejected (missing required fields).
   */
  appendActivity(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const { type, summary, context, session_id } = entry;
    if (!summary || typeof summary !== 'string') return null;
    const safeType = VALID_ACTIVITY_TYPES.has(type) ? type : 'note';

    const record = {
      ts: new Date().toISOString(),
      type: safeType,
      summary: summary.trim().slice(0, 500),
    };
    if (context && typeof context === 'object') record.context = context;
    if (session_id) record.session_id = session_id;

    try {
      fs.mkdirSync(path.dirname(this.activityPath), { recursive: true });
      fs.appendFileSync(this.activityPath, JSON.stringify(record) + '\n');
    } catch {
      return null;
    }
    return record;
  }

  /**
   * Read activity entries with filters. Newest-first.
   *   since_hours: only return entries newer than N hours (default 24)
   *   type:        filter by entry type
   *   contains:    substring match against summary (case-insensitive)
   *   limit:       cap result count (default 100, max 500)
   */
  getActivity({ since_hours = 24, type, contains, limit = 100 } = {}) {
    if (!fs.existsSync(this.activityPath)) return [];
    const cutoff = since_hours != null
      ? Date.now() - Number(since_hours) * 60 * 60 * 1000
      : 0;
    const cap = Math.min(Math.max(1, Number(limit) || 100), 500);
    const lcContains = contains ? String(contains).toLowerCase() : null;

    const lines = fs.readFileSync(this.activityPath, 'utf-8').split('\n');
    const results = [];
    // Walk from newest to oldest by reading the array in reverse.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry?.ts) continue;
      const ts = new Date(entry.ts).getTime();
      if (cutoff && ts < cutoff) {
        // Once we hit something older than the cutoff, all earlier entries
        // are also older — file is append-only chronological. Stop.
        break;
      }
      if (type && entry.type !== type) continue;
      if (lcContains && !(entry.summary || '').toLowerCase().includes(lcContains)) continue;
      results.push(entry);
      if (results.length >= cap) break;
    }
    return results;
  }

  /**
   * Aggregate counts by type within a window. Useful for quick summaries.
   */
  getActivityStats({ since_hours = 24 } = {}) {
    const entries = this.getActivity({ since_hours, limit: 500 });
    const byType = {};
    for (const e of entries) {
      byType[e.type] = (byType[e.type] || 0) + 1;
    }
    return {
      total: entries.length,
      by_type: byType,
      since_hours,
      first_ts: entries[entries.length - 1]?.ts || null,
      last_ts: entries[0]?.ts || null,
    };
  }
}
