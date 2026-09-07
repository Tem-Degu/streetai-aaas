import express from 'express';
import { createServer } from 'http';
import crypto from 'crypto';
import { BaseConnector } from './index.js';
import { extractFiles } from './media.js';
import { formatForVoice } from './voice-format.js';

/**
 * Telnyx voice connector (DIRECT / prototype mode).
 *
 * Telnyx's Voice AI Assistant owns the phone call (PSTN + STT + TTS +
 * turn-taking). It calls this endpoint like an OpenAI LLM ("Use Custom LLM"):
 * each caller turn arrives as an OpenAI chat-completions request, and we return
 * the agent's reply for Telnyx to speak.
 *
 * This is the **direct** path — the workspace exposes the endpoint itself
 * (behind a tunnel or a public host). The production path for relay-deployed
 * agents is bridged through streetai.org instead (see relay.js `telnyx:chat`),
 * but both share `extractTelnyxEvent` and `formatForVoice`.
 *
 * Required config:
 * - apiKey: the integration secret we generate; Telnyx sends it as Bearer.
 * - model:  echoed back in responses (default "aaas").
 * - port:   local port to listen on (default 3302).
 */
export default class TelnyxConnector extends BaseConnector {
  constructor(config, engine) {
    super(config, engine);
    this.apiKey = config.apiKey || null;
    this.model = config.model || 'aaas';
    this.port = config.port || 3302;
    this.server = null;
  }

  get platformName() { return 'telnyx'; }

  async connect() {
    this.status = 'connecting';

    const app = express();
    app.use(express.json());

    // OpenAI-compatible chat completions — the Telnyx custom-LLM hook.
    app.post('/v1/chat/completions', async (req, res) => {
      // Auth: Telnyx sends the integration secret as a Bearer token.
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
      if (this.apiKey && token !== this.apiKey) {
        return res.status(401).json({ error: { message: 'Invalid API key', type: 'invalid_request_error' } });
      }

      const body = req.body || {};
      const { userId, content, language, isGreeting } = extractTelnyxEvent(body);
      const text = await runVoiceTurn(this.engine, { userId, content, language, isGreeting });

      if (body.stream) {
        writeOpenAISSE(res, text, this.model);
      } else {
        res.json(buildOpenAICompletion(text, this.model));
      }
    });

    // Lets Telnyx auto-populate the model name.
    app.get('/v1/models', (req, res) => {
      res.json({
        object: 'list',
        data: [{ id: this.model, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'aaas' }],
      });
    });

    app.get('/health', (req, res) => {
      res.json({ status: 'ok', platform: 'telnyx', model: this.model });
    });

    return new Promise((resolve, reject) => {
      this.server = createServer(app);
      this.server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          this.error = `Port ${this.port} is in use`;
          this.status = 'error';
          reject(new Error(this.error));
        } else {
          this.error = err.message;
          this.status = 'error';
          reject(err);
        }
      });
      this.server.listen(this.port, () => {
        this.status = 'connected';
        this.error = null;
        console.log(`[telnyx] Voice endpoint listening on port ${this.port}`);
        console.log(`[telnyx] Set the Telnyx assistant's custom-LLM Base URL to: http://<your-public-host>:${this.port}/v1`);
        resolve();
      });
    });
  }

  // Telnyx is request/response — the reply is the HTTP response, not a push.
  async send() { /* no-op */ }

  async disconnect() {
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
    await super.disconnect();
  }

  getStatus() {
    return {
      ...super.getStatus(),
      port: this.port,
      url: this.status === 'connected' ? `http://localhost:${this.port}/v1` : null,
    };
  }
}

/**
 * Map an OpenAI chat-completions request body (as Telnyx sends it) to an AaaS
 * event. Shared by this connector and the relay client's `telnyx:chat` handler.
 *
 * - userId  ← extra_metadata.telnyx_end_user_target (caller E.164). Falls back
 *   to the call session id, then a generated id, so a missing field never
 *   crashes — it just starts a fresh session.
 * - content ← the last user message (string or OpenAI content-parts array).
 * - language ← optional extra_metadata.language (for per-language assistants).
 * - isGreeting ← true when the call just started and the assistant is expected
 *   to speak first ("model-generated greeting"): no user message yet AND no
 *   prior assistant turn. Lets the caller wire an opening line instead of the
 *   empty-input fallback. A mid-call empty turn (assistant already spoke) is
 *   NOT a greeting — it keeps the normal "didn't catch that" fallback.
 */
export function extractTelnyxEvent(body) {
  const meta = (body && body.extra_metadata) || {};
  const userId = String(
    meta.telnyx_end_user_target || meta.telnyx_call_session_id || `caller_${crypto.randomBytes(6).toString('hex')}`,
  );

  const messages = Array.isArray(body?.messages) ? body.messages : [];
  let content = '';
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      const c = messages[i].content;
      content = typeof c === 'string'
        ? c
        : Array.isArray(c) ? c.map((p) => (typeof p === 'string' ? p : p?.text || '')).join(' ').trim() : '';
      break;
    }
  }

  const hasAssistant = messages.some((m) => m?.role === 'assistant');
  const isGreeting = !content.trim() && !hasAssistant;

  return { userId, content, language: meta.language || null, isGreeting };
}

// Per-turn language lock for voice. The reply must follow the language of the
// caller's latest words — small/fast models otherwise copy a SKILL template's
// language (e.g. an Arabic confirmation) even mid-English call. We detect the
// script deterministically and pass it to the engine, which injects a
// just-in-time directive. Arabic vs Latin only (Arabic/English); good for voice
// where STT yields native script.
//
// Only lock when THIS message is unambiguously Arabic or English. If it's
// neither (digits/punctuation/empty, another script, or a roughly balanced
// Arabic+English mix), we return undefined and the engine does nothing —
// falling back to the original behavior of letting the agent decide. No
// carry-forward, no guessing.
const ARABIC_G = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/g;
const LATIN_G = /[A-Za-z]/g;
const DOMINANT = 0.7; // one script must be ≥70% of the letters to lock that language

/** Detect 'ar' | 'en' from text; undefined when not clearly either (→ agent decides). */
export function detectLang(text) {
  const s = String(text || '');
  const ar = (s.match(ARABIC_G) || []).length;
  const la = (s.match(LATIN_G) || []).length;
  if (!ar && !la) return undefined;          // no letters → agent decides
  if (ar && !la) return 'ar';                 // pure Arabic
  if (la && !ar) return 'en';                 // pure Latin/English
  // Both scripts present (e.g. Arabic sentence with an English brand word, or
  // genuine code-switching). Lock only if one clearly dominates; otherwise the
  // message is genuinely mixed → let the agent decide.
  const total = ar + la;
  if (ar / total >= DOMINANT) return 'ar';
  if (la / total >= DOMINANT) return 'en';
  return undefined;
}

// Reply-language codes we can inject a directive for (must stay in sync with
// context.js LANG_NAMES). Anything else → undefined → fall back to detection.
const SUPPORTED_REPLY_LANGS = new Set(['ar', 'en', 'hi', 'ml', 'fil', 'ru']);

/**
 * Normalize an STT-provided BCP-47 tag ("ar-AE", "en-US", "hi-IN") to a supported
 * reply-language code ('ar'|'en'|'hi'). Returns undefined for an absent or
 * unsupported tag so the caller falls back to script detection. This is the
 * PRIMARY signal: the STT engine judged the language from the audio itself, which
 * is more reliable than inferring it from the transcript's script (and it works
 * for same-script languages and numeric/short utterances where script can't).
 */
export function normalizeSttLang(tag) {
  if (!tag) return undefined;
  const base = String(tag).toLowerCase().split(/[-_]/)[0];
  return SUPPORTED_REPLY_LANGS.has(base) ? base : undefined;
}

/**
 * Run one voice turn through the engine and sanitise the reply for speech.
 * Shared shape used by the direct connector; the relay client mirrors this
 * inline so it can `_respond` over the WebSocket.
 *
 * On the greeting turn (`isGreeting`, no caller words yet) we feed the agent a
 * greeting trigger so it speaks its own opening line — instead of returning the
 * empty-input fallback. The trigger is configurable per agent via
 * `config.voice.greeting` (or `config.greeting`); defaults to "Hello", which the
 * agent's own SKILL turns into its branded/localized greeting.
 */
export async function runVoiceTurn(engine, { userId, content, language, isGreeting, greetLang, sttLang, opening, onControl, callerNumber }) {
  try {
    let greeting = false;
    if (!String(content || '').trim() && isGreeting) {
      const cfg = engine?.config || {};
      // `opening` (an outbound-call instruction) overrides the generic greeting
      // so the agent opens by naming itself as an AI and stating why it's calling.
      content = opening || (cfg.voice && cfg.voice.greeting) || cfg.greeting || 'Hello';
      greeting = true;
    }
    // Resolve the reply language, best signal first:
    //  1) greeting turn + caller-selected greetLang → open in the chosen language;
    //  2) the STT engine's own per-utterance language decision (sttLang) — the most
    //     reliable source, since it judged the audio, not just the resulting script;
    //  3) fallback: deterministic Arabic-vs-Latin script detection on the text.
    // Undefined at every level → the agent decides. Telnyx (and the relay's
    // telnyx:chat) pass neither greetLang nor sttLang, so their behavior is
    // unchanged — still script detection only.
    const replyLanguage = (greeting && greetLang) || normalizeSttLang(sttLang) || detectLang(content);
    const result = await engine.processEvent({
      platform: 'telnyx',
      userId,
      userName: userId,
      type: 'message',
      content,
      metadata: { mode: 'customer', channel: 'voice', language, greeting, replyLanguage, callerNumber },
    });
    // If the agent invoked end_call this turn, let the caller (the voice pipeline)
    // hang up after it finishes speaking this reply. Telnyx passes no onControl,
    // so its behavior is unchanged.
    if (onControl) {
      const used = (result.toolsUsed || []).some((t) => (typeof t === 'string' ? t : t?.name) === 'end_call');
      if (used) onControl({ hangup: true });
    }
    let text = result.response || '';
    const workspace = engine?.workspace;
    if (workspace && text) text = extractFiles(workspace, text).cleanText;
    text = formatForVoice(text);
    return text || 'Sorry, I did not catch that. Could you say it again?';
  } catch (err) {
    console.error('[telnyx] turn error:', err.message);
    return 'Sorry, I ran into a problem. Could you say that again?';
  }
}

/** Build a single (non-streaming) OpenAI chat.completion response object. */
export function buildOpenAICompletion(text, model) {
  return {
    id: `chatcmpl-${crypto.randomBytes(8).toString('hex')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || 'aaas',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/**
 * Stream `text` back as OpenAI SSE chunks. We run the engine to completion
 * first, then emit the result as delta chunks — this satisfies Telnyx's SSE
 * contract without needing mid-generation streaming from the engine.
 */
export function writeOpenAISSE(res, text, model) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const base = {
    id: `chatcmpl-${crypto.randomBytes(8).toString('hex')}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model || 'aaas',
  };
  const send = (choices) => res.write(`data: ${JSON.stringify({ ...base, choices })}\n\n`);

  send([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]);
  send([{ index: 0, delta: { content: text }, finish_reason: null }]);
  send([{ index: 0, delta: {}, finish_reason: 'stop' }]);
  res.write('data: [DONE]\n\n');
  res.end();
}
