import path from 'path';
import { transcribeAudio } from '../engine/transcription.js';

/**
 * Build the message content for an inbound message that carried media.
 *
 * Non-audio files keep the existing `[Attached files: type: path]` note so the
 * agent can reference/attach them. Audio files are transcribed to text when
 * voice transcription is enabled in the workspace config, so the agent reads a
 * voice note exactly like a typed message. The original file path is preserved
 * in the line so the agent can still attach the recording to a transaction.
 *
 * Never throws — if transcription is off or fails, it falls back to the plain
 * file-reference note so a voice message is never silently dropped.
 *
 * @param {object} engine        The engine (provides .config and .workspace).
 * @param {string} baseText      The text/caption that came with the message.
 * @param {Array}  savedFiles    [{ type, path }] from a connector's _downloadMedia.
 * @returns {Promise<string>}
 */
export async function buildInboundContent(engine, baseText, savedFiles) {
  const parts = baseText ? [baseText] : [];
  if (!Array.isArray(savedFiles) || savedFiles.length === 0) {
    return parts.join('\n\n');
  }

  const voice = engine?.config?.voice || {};
  const voiceOn = voice.enabled && (voice.provider || voice.endpoint);
  const others = [];

  for (const f of savedFiles) {
    if (f?.type === 'audio' && voiceOn) {
      try {
        const text = await transcribeAudio({
          filePath: path.join(engine.workspace, f.path),
          provider: voice.provider,
          model: voice.model,
          language: voice.language,
          endpoint: voice.endpoint,
          workspace: engine.workspace,
        });
        if (text) {
          parts.push(`🎤 Customer voice message [${f.path}]: "${text}"`);
        } else {
          parts.push(`🎤 Customer sent a voice message [${f.path}] but no speech was detected.`);
        }
        continue;
      } catch (err) {
        console.warn(`[voice] transcription failed for ${f.path}: ${err.message}`);
        // fall through to the plain file reference below
      }
    }
    others.push(f);
  }

  if (others.length > 0) {
    const list = others.map(f => `${f.type}: ${f.path}`).join(', ');
    parts.push(`[Attached files: ${list}]`);
  }
  return parts.join('\n\n');
}
