import express from 'express';
import { createServer } from 'http';
import { BaseConnector } from './index.js';
import { extractFiles } from './media.js';
import { formatForVoice } from './voice-format.js';
import { transcribeAudio, sttDefaultModel } from '../engine/transcription.js';
import { synthesizeSpeech, ttsDefaultModel, ttsDefaultVoice } from '../engine/tts.js';

/**
 * Web Call connector (audio-in / audio-out).
 *
 * Unlike Telnyx (where Telnyx does speech and hands us text), the browser sends
 * raw audio and expects audio back, so the AGENT does the speech: STT → brain →
 * TTS. STT/TTS run on the operator's own Groq key (Settings → Voice), so
 * StreetAI never touches speech keys.
 *
 * This is the **direct** path — the workspace exposes the endpoint itself
 * (behind a tunnel / public host) for local dev. The production path for
 * relay-deployed agents is bridged through streetai.org (see relay.js
 * `webcall:audio`), and both share `runWebcallTurn`.
 *
 * Optional config:
 * - apiKey: Bearer token gate (direct mode only).
 * - port:   local port to listen on (default 3303).
 */
export default class WebCallConnector extends BaseConnector {
  constructor(config, engine) {
    super(config, engine);
    this.apiKey = config.apiKey || null;
    this.port = config.port || 3303;
    this.server = null;
  }

  get platformName() { return 'webcall'; }

  async connect() {
    this.status = 'connecting';

    const app = express();
    // Base64 audio inflates ~33%; allow generous headroom for short clips.
    app.use(express.json({ limit: '12mb' }));

    app.post('/webcall/turn', async (req, res) => {
      if (this.apiKey) {
        const auth = req.headers.authorization || '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
        if (token !== this.apiKey) {
          return res.status(401).json({ error: 'Invalid API key' });
        }
      }
      const { audio_base64, mime, userId, language, text } = req.body || {};
      if (!audio_base64 && !text) return res.status(400).json({ error: 'audio_base64 or text required' });
      const out = await runWebcallTurn(this.engine, {
        userId: userId || 'web_anonymous',
        audioBuffer: audio_base64 ? Buffer.from(audio_base64, 'base64') : null,
        mime: mime || 'audio/webm',
        language: language || null,
        text: text || null,
      });
      res.json(out);
    });

    app.get('/health', (req, res) => {
      res.json({ status: 'ok', platform: 'webcall' });
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
        console.log(`[webcall] Voice endpoint listening on port ${this.port}`);
        console.log(`[webcall] POST audio to http://<your-public-host>:${this.port}/webcall/turn`);
        resolve();
      });
    });
  }

  // Request/response — the reply is the HTTP response, not a push.
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
      url: this.status === 'connected' ? `http://localhost:${this.port}/webcall/turn` : null,
    };
  }
}

/** Map an audio MIME type to a filename extension Whisper recognises. */
function extForMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('webm')) return 'webm';
  if (m.includes('ogg') || m.includes('opus')) return 'ogg';
  if (m.includes('wav')) return 'wav';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  if (m.includes('flac')) return 'flac';
  return 'webm';
}

/**
 * Run one web-call turn: STT → brain (voice mode) → formatForVoice → TTS.
 * Shared by the direct connector and the relay client's `webcall:audio` handler.
 * Never throws — returns a spoken-fallback text (audio may be null) on error.
 *
 * Voice settings come from `engine.config.voice`:
 *   { provider, model }                    ← STT (shared with voice notes)
 *   { tts: { provider, model, voice } }     ← TTS
 *
 * @returns {Promise<{ transcript, reply, audio_base64: string|null, mime: string|null }>}
 */
export async function runWebcallTurn(engine, { userId, audioBuffer, mime, language, text }) {
  const voice = engine?.config?.voice || {};
  const sttProvider = voice.provider || 'groq';
  const sttModel = voice.model || sttDefaultModel(sttProvider);
  const tts = voice.tts || {};
  const ttsProvider = tts.provider || 'groq';
  // Synthesize options, shaped for synthesizeSpeech(). Carries per-provider
  // knobs (Azure rate/pitch/region; ElevenLabs stability/style/speed); each
  // provider ignores the ones it doesn't use.
  const ttsOpts = {
    provider: ttsProvider,
    model: tts.model || ttsDefaultModel(ttsProvider),
    voice: tts.voice || ttsDefaultVoice(ttsProvider),
    region: tts.region, rate: tts.rate, pitch: tts.pitch,
    stability: tts.stability, style: tts.style, speed: tts.speed, similarityBoost: tts.similarity_boost,
    workspace: engine?.workspace,
  };

  // 1. Get the caller's words. A `text` turn (e.g. the opening greeting trigger
  // from a web client) skips STT; otherwise transcribe the audio.
  let transcript = '';
  if (text && String(text).trim()) {
    transcript = String(text).trim();
  } else {
    try {
      transcript = await transcribeAudio({
        buffer: audioBuffer,
        filename: `audio.${extForMime(mime)}`,
        provider: sttProvider,
        model: sttModel,
        // Auto-detect the spoken language (no hint) so the agent can mirror a
        // caller who switches languages. `language` is left for the LLM context.
        language: undefined,
        workspace: engine?.workspace,
      });
    } catch (err) {
      console.error('[webcall] STT error:', err.message);
      return speakFallback('Sorry, I had trouble hearing you. Could you try again?', ttsOpts);
    }

    if (!transcript) {
      return speakFallback('Sorry, I did not catch that. Could you say it again?', ttsOpts);
    }
  }

  // 2. Run the brain in voice mode.
  let reply = '';
  try {
    const result = await engine.processEvent({
      platform: 'webcall',
      userId,
      userName: userId,
      type: 'message',
      content: transcript,
      metadata: { mode: 'customer', channel: 'voice', language },
    });
    reply = result.response || '';
    const workspace = engine?.workspace;
    if (workspace && reply) reply = extractFiles(workspace, reply).cleanText;
    reply = formatForVoice(reply);
  } catch (err) {
    console.error('[webcall] turn error:', err.message);
    reply = 'Sorry, I ran into a problem. Could you say that again?';
  }
  if (!reply) reply = 'Sorry, could you say that again?';

  // 3. Speak the reply with the single voice configured in Settings → Voice,
  // regardless of the reply's language (this voice reads both Arabic and
  // English). No per-language voice switching.
  const spoken = await tryTts(reply, ttsOpts);
  return { transcript, reply, audio_base64: spoken.audio_base64, mime: spoken.mime };
}

/** Synthesize text, returning base64 audio or nulls on failure (never throws). */
async function tryTts(text, ttsOpts) {
  try {
    const { buffer, mime } = await synthesizeSpeech({ text, ...ttsOpts });
    return { audio_base64: buffer.toString('base64'), mime };
  } catch (err) {
    console.error('[webcall] TTS error:', err.message);
    return { audio_base64: null, mime: null };
  }
}

/** Build a fallback turn result (no brain call), still spoken when possible. */
async function speakFallback(text, ttsOpts) {
  const spoken = await tryTts(text, ttsOpts);
  return { transcript: '', reply: text, audio_base64: spoken.audio_base64, mime: spoken.mime };
}
