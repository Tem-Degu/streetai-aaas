/**
 * Layered context assembly with token budgets.
 * Ensures LLM calls stay within budget while including the most relevant context.
 */

const DEFAULT_BUDGETS = {
  base: 4000,
  system: 16000,
  platformSkill: 16000,
  session: 16000,
  memory: 2000,
  data: 4000,
  response: 4000,
};

export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export class ContextAssembler {
  constructor(budgets = {}) {
    this.budgets = { ...DEFAULT_BUDGETS, ...budgets };
  }

  /**
   * Assemble messages array for the LLM call.
   * @param {Object} params
   * @param {string} params.basePrompt - Base AaaS prompt (always injected)
   * @param {string} params.skill - SKILL.md content (service definition)
   * @param {string} params.platformSkill - Platform-specific SKILL.md content (e.g. Truuze API docs)
   * @param {string} params.soul - SOUL.md content
   * @param {Array} params.sessionMessages - Conversation history [{role, content}]
   * @param {string} params.sessionSummary - Compressed summary of older messages
   * @param {Array} params.memoryFacts - Relevant facts [{key, value}]
   * @param {string} params.event - Current user message/event
   * @param {string} params.agentName - Agent name for system prompt
   * @param {Array} params.platformContext - Extra context about the platform/event type
   * @param {string} [params.replyLanguage] - Optional per-turn language lock ('ar'|'en').
   *   When set, a just-in-time directive is injected right before the user message
   *   forcing the reply into that language. Absent → no change (default behavior).
   * @returns {{ messages: Array, estimatedTokens: number }}
   */
  assemble({ basePrompt, skill, platformSkill, soul, sessionMessages = [], sessionSummary, memoryFacts = [], event, agentName, platformContext, replyLanguage }) {
    const messages = [];
    let totalTokens = 0;

    // Layer 0: Base prompt (AaaS fundamentals + workspace state — always present)
    let systemContent = '';
    if (basePrompt) {
      systemContent += this.truncateToFit(basePrompt, this.budgets.base) + '\n\n---\n\n';
    }

    // Layer 1: SKILL.md (user-defined service knowledge)
    systemContent += `You are ${agentName || 'an AaaS agent'}.\n\n`;

    if (skill) {
      const skillBudget = this.budgets.system - estimateTokens(systemContent);
      systemContent += this.truncateToFit(skill, skillBudget);
    }

    // Layer 1b: Platform SKILL.md (how to interact with the platform this request came from)
    if (platformSkill) {
      const platformSkillBudget = this.budgets.platformSkill;
      systemContent += '\n\n---\n\n## Platform Guide\nThe following is the skill/guide for the platform this request came from. Use it to understand how to interact with the platform.\n\n';
      systemContent += '**IMPORTANT:** Use the `platform_request` tool to call any platform API. Authentication headers (API keys, agent keys) are injected automatically — do NOT include them in your request. Just provide the URL, method, and body.\n\n';
      systemContent += '**FILES:** To share images, audio, video, or documents with users, you MUST use the `platform_request` tool with media fields (e.g., image_0_1, file_0_1). Provide a URL or workspace file path as the value — the file will be downloaded and uploaded automatically. Do NOT use markdown image syntax (![]()), links, or text descriptions of files — the platform does not render markdown. The only way to share a file is to attach it via `platform_request`.\n\n';
      systemContent += this.truncateToFit(platformSkill, platformSkillBudget);
    }

    // Layer 1c: SOUL.md (personality)
    if (soul) {
      const remainingBudget = this.budgets.system + this.budgets.base - estimateTokens(systemContent);
      if (remainingBudget > 100) {
        systemContent += '\n\n---\n\n' + this.truncateToFit(soul, remainingBudget);
      }
    }

    // Add memory facts to system if any
    if (memoryFacts.length > 0) {
      const factsText = memoryFacts.map(f => `- ${f.key}: ${f.value}`).join('\n');
      const truncatedFacts = this.truncateToFit(factsText, this.budgets.memory);
      if (truncatedFacts) {
        systemContent += '\n\n---\n\n## Relevant Memory\n' + truncatedFacts;
      }
    }

    // Add platform context if any
    if (platformContext) {
      systemContent += '\n\n---\n\n## Current Context\n' + platformContext;
    }

    messages.push({ role: 'system', content: systemContent });
    totalTokens += estimateTokens(systemContent);

    // Layer 2: Session (conversation history)
    if (sessionSummary) {
      const summaryMsg = `[Previous conversation summary: ${sessionSummary}]`;
      messages.push({ role: 'system', content: summaryMsg });
      totalTokens += estimateTokens(summaryMsg);
    }

    let recentMessages = this.selectRecentMessages(sessionMessages, this.budgets.session);
    // The recent window (after budget truncation / compression) must never
    // contain a tool result without its assistant tool-call, or an assistant
    // tool-call without its result — providers reject dangling pairs. This is a
    // no-op for plain text-only history.
    recentMessages = this.sanitizeToolMessages(recentMessages);
    for (const msg of recentMessages) {
      messages.push(msg);
      totalTokens += estimateTokens(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content));
    }

    // Layer 4b: Per-turn language lock (just-in-time, highest salience). Only
    // when a caller-language was resolved (currently the voice path). This is the
    // last instruction before the user message, so it overrides any example /
    // template language baked into the SKILL above.
    const LANG_NAMES = { ar: 'Arabic', en: 'English', hi: 'Hindi', ml: 'Malayalam', fil: 'Filipino', ru: 'Russian' };
    if (LANG_NAMES[replyLanguage]) {
      const langName = LANG_NAMES[replyLanguage];
      const directive = `IMPORTANT — for THIS reply only: the caller's most recent message is in ${langName}. Respond ENTIRELY in ${langName}, including any read-back or booking confirmation. Do not switch or mix languages. This overrides the language of any example or template in the instructions above.`;
      messages.push({ role: 'system', content: directive });
      totalTokens += estimateTokens(directive);
    }

    // Layer 5: Current event
    if (event) {
      messages.push({ role: 'user', content: event });
      totalTokens += estimateTokens(event);
    }

    return { messages, estimatedTokens: totalTokens };
  }

  /**
   * Truncate text to fit within a token budget, preserving complete sentences.
   */
  truncateToFit(text, maxTokens) {
    if (!text) return '';
    if (estimateTokens(text) <= maxTokens) return text;

    const maxChars = maxTokens * 4;
    let truncated = text.slice(0, maxChars);

    // Try to end at a sentence boundary
    const lastPeriod = truncated.lastIndexOf('.');
    const lastNewline = truncated.lastIndexOf('\n');
    const cutPoint = Math.max(lastPeriod, lastNewline);

    if (cutPoint > maxChars * 0.5) {
      truncated = truncated.slice(0, cutPoint + 1);
    }

    return truncated;
  }

  /**
   * Guarantee tool-call/tool-result pairing integrity in a message window.
   * Drops tool results whose assistant tool-call isn't present, and strips
   * tool-calls from an assistant message whose results aren't present. This
   * protects against budget truncation or compression slicing a pair apart.
   * No-op for messages without tool calls.
   */
  sanitizeToolMessages(msgs) {
    if (!msgs || msgs.length === 0) return msgs || [];
    const hasToolStuff = msgs.some(m => m.role === 'tool' || (Array.isArray(m.toolCalls) && m.toolCalls.length));
    if (!hasToolStuff) return msgs; // common case: plain text history

    const resultIds = new Set();
    for (const m of msgs) if (m.role === 'tool' && m.toolCallId) resultIds.add(m.toolCallId);

    const out = [];
    for (const m of msgs) {
      if (m.role === 'tool') {
        const hasCall = out.some(x =>
          x.role === 'assistant' && Array.isArray(x.toolCalls) &&
          x.toolCalls.some(tc => tc.id === m.toolCallId));
        if (hasCall) out.push(m); // else: orphan result — drop
      } else if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
        const kept = m.toolCalls.filter(tc => resultIds.has(tc.id));
        if (kept.length === m.toolCalls.length) out.push(m);
        else if (kept.length > 0) out.push({ ...m, toolCalls: kept });
        else { const { toolCalls, ...rest } = m; out.push(rest); } // no results → plain text
      } else {
        out.push(m);
      }
    }
    return out;
  }

  /**
   * Select the most recent messages that fit within a token budget.
   */
  selectRecentMessages(messages, maxTokens) {
    if (!messages || messages.length === 0) return [];

    const selected = [];
    let tokens = 0;

    // Work backwards from most recent
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      const msgTokens = estimateTokens(content);

      if (tokens + msgTokens > maxTokens) break;

      selected.unshift(msg);
      tokens += msgTokens;
    }

    return selected;
  }
}
