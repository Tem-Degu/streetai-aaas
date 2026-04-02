import path from 'path';
import { readJson, writeJson } from '../../utils/workspace.js';

const FACTS_FILE = 'facts.json';

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
}
