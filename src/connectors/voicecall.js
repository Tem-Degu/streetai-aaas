import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { BaseConnector } from './index.js';
import { VoicePipeline } from '../engine/voice-pipeline.js';
import { base64ToBuf, bufToBase64, makeVoiceCodec } from '../engine/audio-utils.js';

/**
 * Real-time Voice Call connector (streaming + barge-in).
 *
 * One transport-agnostic core (VoicePipeline) behind a generic media-streams
 * WebSocket protocol, so the SAME endpoint serves a browser widget AND an SBC
 * (FreeSWITCH / Asterisk) as long as they speak the protocol. Provider choices
 * (STT/TTS) come from the workspace voice config, nothing is hardcoded.
 *
 * This is separate from the Telnyx connector (which is request/response and
 * stays untouched) and from the batch Web Call connector.
 *
 * Media-streams protocol (JSON over WebSocket at /ws):
 *   client -> server:
 *     { event: "start", start: { userId?, format?: { encoding, sampleRate } } }
 *     { event: "media", media: { payload: <base64 PCM16 16k mono> } }
 *     { event: "stop" }
 *   server -> client:
 *     { event: "ready" }
 *     { event: "media", media: { payload: <base64 PCM16 16k mono> } }
 *     { event: "clear" }            // barge-in: flush your playout buffer now
 *
 * Audio defaults to 16 kHz / 16-bit / mono PCM both ways (the browser). A
 * non-browser transport can declare a different codec via `start.format`
 * (or a `?format=` query param) — e.g. `pcmu` for 8 kHz mulaw from PSTN — and
 * the connector transcodes both directions at this edge. Inside, the pipeline
 * is always PCM16/16k.
 *
 * Config:
 *   - port:   local port (default 3304). Serves the test widget at "/".
 *   - apiKey: optional Bearer/query token to gate the WebSocket.
 */
export default class VoiceCallConnector extends BaseConnector {
  constructor(config, engine) {
    super(config, engine);
    this.apiKey = config.apiKey || null;
    this.port = config.port || 3304;
    this.server = null;
    this.wss = null;
  }

  get platformName() { return 'voicecall'; }

  async connect() {
    this.status = 'connecting';
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const app = express();

    // Browser test widget (the harness you can talk to without an SBC).
    app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'voice-widget.html')));
    app.get('/health', (_req, res) => res.json({ status: 'ok', platform: 'voicecall' }));

    this.server = createServer(app);
    this.wss = new WebSocketServer({ server: this.server, path: '/ws' });
    this.wss.on('connection', (ws, req) => this._onConnection(ws, req));

    return new Promise((resolve, reject) => {
      this.server.on('error', (err) => {
        this.status = 'error';
        this.error = err.code === 'EADDRINUSE' ? `Port ${this.port} is in use` : err.message;
        reject(new Error(this.error));
      });
      this.server.listen(this.port, () => {
        this.status = 'connected';
        this.error = null;
        console.log(`[voicecall] Real-time voice listening on port ${this.port}`);
        console.log(`[voicecall] Open the test widget:  http://localhost:${this.port}/`);
        console.log(`[voicecall] SBC/clients connect WS: ws://<host>:${this.port}/ws`);
        resolve();
      });
    });
  }

  _onConnection(ws, req) {
    // Optional gate: ?key=... must match config.apiKey when set.
    if (this.apiKey) {
      const url = new URL(req.url, 'http://localhost');
      if (url.searchParams.get('key') !== this.apiKey) {
        try { ws.close(4001, 'unauthorized'); } catch { /* ignore */ }
        return;
      }
    }

    // Optional codec hint in the URL (?format=pcmu) — a start.format overrides it.
    let qFormat = null;
    try { qFormat = new URL(req.url, 'http://localhost').searchParams.get('format'); } catch { /* none */ }

    let pipeline = null;
    let codec = makeVoiceCodec(null); // identity (PCM16/16k) until start declares otherwise
    const sendMedia = (payload) => {
      if (ws.readyState !== ws.OPEN) return;
      let out = payload;
      if (!codec.identity) { try { out = bufToBase64(codec.encodeOut(base64ToBuf(payload))); } catch { /* as-is */ } }
      ws.send(JSON.stringify({ event: 'media', media: { payload: out } }));
    };
    const sendClear = () => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ event: 'clear' }));
    };

    ws.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      if (msg.event === 'start') {
        if (pipeline) return; // already started
        codec = makeVoiceCodec((msg.start && msg.start.format) || qFormat);
        const userId = (msg.start && msg.start.userId)
          || `voice_${Math.random().toString(36).slice(2, 10)}`;
        pipeline = new VoicePipeline({ engine: this.engine, sendMedia, sendClear, userId });
        try {
          await pipeline.start();
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ event: 'ready' }));
        } catch (err) {
          console.error('[voicecall] start error:', err.message);
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ event: 'error', error: err.message }));
            ws.close(1011, 'start failed');
          }
        }
      } else if (msg.event === 'media' && pipeline) {
        let buf = base64ToBuf(msg.media && msg.media.payload);
        if (buf.length) {
          try { buf = codec.decodeIn(buf); } catch { return; } // wire codec → PCM16/16k
          pipeline.onAudio(buf);
        }
      } else if (msg.event === 'stop') {
        if (pipeline) { pipeline.close(); pipeline = null; }
      }
    });

    ws.on('close', () => { if (pipeline) { pipeline.close(); pipeline = null; } });
    ws.on('error', () => { if (pipeline) { pipeline.close(); pipeline = null; } });
  }

  async send() { /* push not used: replies stream over the call's own socket */ }

  async disconnect() {
    try { this.wss && this.wss.close(); } catch { /* ignore */ }
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
    this.wss = null;
    await super.disconnect();
  }

  getStatus() {
    return {
      ...super.getStatus(),
      port: this.port,
      url: this.status === 'connected' ? `http://localhost:${this.port}/` : null,
    };
  }
}
