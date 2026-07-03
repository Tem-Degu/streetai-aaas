// Real-time voice orchestrator. Transport-agnostic: a browser widget and an SBC
// both feed it PCM16 frames and receive PCM16 frames + a `clear` signal. It owns
// the per-call state machine and the barge-in logic.
//
// Flow per call:
//   start() -> greet -> listening
//   inbound audio -> VAD + STT
//   STT final transcript -> thinking -> runVoiceTurn (the brain) -> speaking
//   streaming TTS -> outbound audio
//   caller speaks while speaking -> barge-in: abort TTS, clear the transport's
//   playout, bump the turn id so stale audio is dropped, back to listening.
//
// The brain is the SAME runVoiceTurn the Telnyx connector uses (imported, not
// modified): full transcript in, voice-cleaned reply out.

import { EnergyVAD } from './voice-vad.js';
import { createSttStream } from './stt-stream.js';
import { synthesizeStream } from './tts-stream.js';
import { int16View } from './audio-utils.js';
import { runVoiceTurn } from '../connectors/telnyx.js';

export class VoicePipeline {
  /**
   * @param {object} o
   * @param {object} o.engine     The AaaS engine (provides config.voice + processEvent).
   * @param {(b64:string)=>void} o.sendMedia  Send a base64 PCM16 frame to the transport.
   * @param {()=>void} o.sendClear            Tell the transport to flush its playout buffer.
   * @param {string} o.userId      Stable per-call id (caller number / web session).
   */
  constructor({ engine, sendMedia, sendClear, userId }) {
    this.engine = engine;
    this.sendMedia = sendMedia;
    this.sendClear = sendClear;
    this.userId = userId;
    this.voice = (engine && engine.config && engine.config.voice) || {};

    this.vad = new EnergyVAD(this.voice.vad || {});
    this.thinking = false;      // true while the LLM is producing a reply
    this.playEndAt = 0;         // epoch ms when the audio we've SENT will finish PLAYING
    this.turnId = 0;            // bumped on every new turn + every barge-in
    this.stt = null;
    this.segment = [];          // buffered frames for the segmented STT path
    this.ttsAbort = null;

    // Half-duplex + barge-in guard. While the agent is speaking, the mic is
    // mostly our own audio echoing back (a phone/softphone without perfect echo
    // cancellation), so we do NOT transcribe it — otherwise the agent hears
    // itself, barges on its own voice (mid-speech silence) and answers its own
    // words (responding with no caller input). Only a LOUD, SUSTAINED interruption
    // after a short grace counts as a real barge-in. All tunable via voice.barge.
    const b = this.voice.barge || {};
    this.bargeTailMs = b.tailMs ?? 300;         // keep suppressing this long past playback end (covers network + jitter lag)
    this.bargeThresholdAbs = b.threshold ?? 0.04; // absolute RMS floor: never barge below this (quiet-line guard)
    this.bargeMargin = b.margin ?? 2.2;         // barge when the caller is this many× above the tracked echo floor
    this.bargeSustainMs = b.sustainMs ?? 200;   // loud speech must persist this long to interrupt
    this.bargeGraceMs = b.graceMs ?? 300;       // no barge in the first part of a reply (protects its start)
    this.speakStartAt = 0;      // when the current reply began playing (for the grace window)
    this._bargeLoudSince = 0;   // start of the current run of loud frames
    this._echoFloor = 0.02;     // adaptive estimate of the echo level while we speak
  }

  // "Speaking" means audio we've sent is still playing in the client. We track
  // the real playback end (from audio duration), NOT when the bytes left the
  // socket — the client buffers seconds of audio ahead, and barge-in must work
  // for that whole window.
  _isSpeaking() { return Date.now() < this.playEndAt; }

  // We stay "half-duplex" (mic suppressed) for a tail past the real playback end,
  // covering the network + jitter-buffer delay before the caller's line goes
  // quiet again. playEndAt === 0 (a barge) ends the tail immediately.
  _inSpeechWindow() {
    return this.playEndAt > 0 && Date.now() < this.playEndAt + this.bargeTailMs;
  }

  _rms(frame) {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) { const s = frame[i] / 32768; sum += s * s; }
    return frame.length ? Math.sqrt(sum / frame.length) : 0;
  }

  // Barge-in during our own speech. The bar is ADAPTIVE: barge only when the
  // caller's audio rises clearly above the current echo level (tracked from the
  // quiet frames while we speak), sustained past bargeSustainMs and after the
  // opening grace. This stays responsive on a quiet line (handset) yet rejects
  // echo on a loud one (speakerphone) — without a hand-picked fixed threshold.
  _detectBarge(frame) {
    const rms = this._rms(frame);

    // Grace window: the caller is still listening as our reply starts, so this
    // audio IS our echo level — calibrate the floor to it (fast) and never barge.
    // This also protects the start of the reply from an instant interruption.
    if (Date.now() - this.speakStartAt < this.bargeGraceMs) {
      this._echoFloor = 0.8 * this._echoFloor + 0.2 * rms;
      this._bargeLoudSince = 0;
      return;
    }

    const level = Math.max(this.bargeThresholdAbs, this._echoFloor * this.bargeMargin);
    if (rms < level) {
      // At/near the echo floor: track it slowly, no barge.
      this._echoFloor = 0.98 * this._echoFloor + 0.02 * rms;
      if (this._echoFloor < 0.004) this._echoFloor = 0.004;
      if (this._echoFloor > 0.2) this._echoFloor = 0.2;
      this._bargeLoudSince = 0;
    } else {
      // Clearly above the echo floor = a real interruption; don't pollute the floor.
      if (!this._bargeLoudSince) this._bargeLoudSince = Date.now();
      if (Date.now() - this._bargeLoudSince >= this.bargeSustainMs) this._barge();
    }
  }

  async start() {
    const sttProvider = this.voice.provider || 'azure_speech';
    this.stt = await createSttStream({
      provider: sttProvider,
      model: this.voice.model,
      region: this.voice.region || (this.voice.tts && this.voice.tts.region),
      endpointSilenceMs: this.voice.endpointSilenceMs,
      segmentation: this.voice.segmentation,     // defaults to 'semantic' in stt-stream
      onPartial: () => {},                       // reserved (interim display)
      onFinal: (text) => this._onTranscript(text),
    });
    // Opening line: agent speaks first (isGreeting) before the caller says anything.
    await this._respond('', true);
  }

  /** Inbound audio frame: PCM16 mono 16 kHz Buffer. */
  onAudio(buf) {
    if (!this.stt) return;
    const frame = int16View(buf);

    // Half-duplex while the agent is speaking (and for a short tail after): don't
    // transcribe — the mic is mostly our own echo. Only a loud, sustained
    // interruption barges. Keep the VAD/segment buffer clean for when we resume.
    if (this._isSpeaking() || this._inSpeechWindow()) {
      this._detectBarge(frame);
      this.vad.reset();
      if (this.segment.length) this.segment = [];
      return;
    }

    // Normal listening (agent silent).
    this._bargeLoudSince = 0;
    const ev = this.vad.process(frame);
    if (this.stt.mode === 'stream') {
      // Continuous STT: forward; the SDK finalises on its own endpoint.
      this.stt.pushFrame(buf);
    } else {
      // Segmented STT: buffer while speaking, transcribe on end-of-speech.
      if (this.vad.speaking) this.segment.push(buf);
      if (ev === 'end' && this.segment.length) {
        const seg = Buffer.concat(this.segment);
        this.segment = [];
        this.stt.transcribeSegment(seg);
      }
    }
  }

  _barge() {
    this.turnId++;                 // invalidate any in-flight reply/TTS
    if (this.ttsAbort) { try { this.ttsAbort.abort(); } catch { /* ignore */ } this.ttsAbort = null; }
    this.playEndAt = 0;            // we are no longer speaking (also ends the tail)
    this._bargeLoudSince = 0;
    this.vad.reset();
    try { this.sendClear(); } catch { /* ignore */ } // flush the client's playout
  }

  _onTranscript(text) {
    const t = String(text || '').trim();
    if (!t) return;
    // Defense-in-depth: ignore transcripts that land while we're thinking or
    // within the speech window (STT isn't fed then, so this should be rare).
    if (this.thinking || this._isSpeaking() || this._inSpeechWindow()) return;
    this._respond(t, false).catch((e) => console.error('[voice] respond error:', e.message));
  }

  async _respond(text, isGreeting) {
    const myTurn = ++this.turnId;
    this.thinking = true;

    let reply;
    try {
      reply = await runVoiceTurn(this.engine, {
        userId: this.userId,
        content: text,
        language: this.voice.language || null,
        isGreeting,
      });
    } catch (e) {
      reply = 'Sorry, could you say that again?';
    }
    this.thinking = false;
    if (myTurn !== this.turnId) return; // superseded (barge-in or newer turn)

    const ac = new AbortController();
    this.ttsAbort = ac;
    this.speakStartAt = Date.now(); // opens the barge grace window for this reply
    this._echoFloor = 0.02;         // recalibrate the echo estimate for this reply
    this._bargeLoudSince = 0;
    const tts = this.voice.tts || {};
    try {
      await synthesizeStream({
        provider: tts.provider || 'azure_speech',
        model: tts.model,
        voice: tts.voice,
        region: tts.region || this.voice.region,
        text: reply,
        signal: ac.signal,
        onAudio: (pcm) => {
          if (myTurn !== this.turnId) return;
          // Advance the playback clock by this chunk's real duration so
          // _isSpeaking() stays true until the client actually finishes it.
          // PCM16 mono 16 kHz => 32 bytes per millisecond.
          this.playEndAt = Math.max(this.playEndAt, Date.now()) + pcm.length / 32;
          try { this.sendMedia(Buffer.from(pcm).toString('base64')); } catch { /* socket gone */ }
        },
      });
    } catch (e) {
      if (!ac.signal.aborted) console.error('[voice] tts error:', e.message);
    }
    if (myTurn === this.turnId) this.ttsAbort = null;
  }

  close() {
    try { this.stt && this.stt.close(); } catch { /* ignore */ }
    if (this.ttsAbort) { try { this.ttsAbort.abort(); } catch { /* ignore */ } }
    this.stt = null;
    this.segment = [];
  }
}
