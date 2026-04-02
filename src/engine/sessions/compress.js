import { estimateTokens } from '../context.js';

const COMPRESS_PROMPT = `Summarize this conversation concisely. Preserve all:
- Decisions made and preferences expressed
- Names, dates, numbers, and specific commitments
- Service requests and transaction details
- Any facts the user shared about themselves

Return ONLY the summary, no preamble.`;

/**
 * Compress a session's older messages into a summary using the LLM.
 * Keeps the most recent messages verbatim.
 */
export async function compressSession(provider, session, { maxTokens = 4000, keepLast = 3 } = {}) {
  const totalTokens = session.messages.reduce(
    (sum, m) => sum + estimateTokens(m.content || ''), 0
  );

  // No compression needed
  if (totalTokens <= maxTokens) return null;

  // Split: older messages to compress, recent to keep
  const toCompress = session.messages.slice(0, -keepLast);
  if (toCompress.length === 0) return null;

  // Build conversation text for summarization
  const conversationText = toCompress
    .map(m => `${m.role}: ${m.content}`)
    .join('\n');

  // Include existing summary if any
  const fullText = session.summary
    ? `Previous summary: ${session.summary}\n\nContinuation:\n${conversationText}`
    : conversationText;

  try {
    const result = await provider.chat([
      { role: 'system', content: COMPRESS_PROMPT },
      { role: 'user', content: fullText },
    ], { maxTokens: 500, temperature: 0 });

    return result.content;
  } catch {
    // Fallback: simple truncation — keep last sentence of each old message
    return toCompress
      .map(m => `${m.role}: ${(m.content || '').slice(0, 100)}`)
      .join('; ');
  }
}
