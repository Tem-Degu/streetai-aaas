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
import { runVoiceTurn, detectLang, normalizeSttLang } from '../connectors/telnyx.js';
import { resolveVoiceForLang } from './voice-table.js';

export class VoicePipeline {
  /**
   * @param {object} o
   * @param {object} o.engine     The AaaS engine (provides config.voice + processEvent).
   * @param {(b64:string)=>void} o.sendMedia  Send a base64 PCM16 frame to the transport.
   * @param {()=>void} o.sendClear            Tell the transport to flush its playout buffer.
   * @param {string} o.userId      Stable per-call id (caller number / web session).
   */
  constructor({ engine, sendMedia, sendClear, userId, greetLang, direction, purpose, agentName, onHangup, callerNumber }) {
    this.engine = engine;
    this.sendMedia = sendMedia;
    this.sendClear = sendClear;
    this.userId = userId;
    // Inbound caller's phone number (digits, from the network), for the agent's
    // caller-identity tools. Null when withheld or on outbound/browser calls.
    this.callerNumber = callerNumber || null;
    this.greetLang = greetLang || null;   // caller-selected opening language (optional)
    // Outbound calls (the agent placed the call): open with a purposeful AI
    // self-introduction and allow the agent to hang up when done. Inbound leaves
    // these unset and behaves exactly as before.
    this.direction = direction || 'inbound';
    this.purpose = purpose || null;
    this.agentName = agentName || (engine && engine.agentName) || null;
    this.onHangup = typeof onHangup === 'function' ? onHangup : null;
    this._pendingHangup = false;
    this.voice = (engine && engine.config && engine.config.voice) || {};

    // Sticky reply language. Once a language is committed, we keep replying in it
    // and only switch when the caller's utterance both resolves to a different
    // language AND is long enough to be a real switch (not a short "ok"/"نعم").
    // Seeded from the widget's opening language. minChars is tunable per agent.
    this.currentLang = greetLang || null;
    this.langMinChars = (this.voice.langStick && this.voice.langStick.minChars) || 5;

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

  // Count letters in any script — the "is this utterance substantial enough to
  // switch languages" measure for the sticky-language guard. Excludes digits,
  // spaces and punctuation so a short "ok" / "نعم" stays below the threshold.
  _letters(text) {
    const m = String(text || '').match(/\p{L}/gu);
    return m ? m.length : 0;
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
      onFinal: (text, sttLang) => this._onTranscript(text, sttLang),
      workspace: this.engine.workspace,
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

  _onTranscript(text, sttLang) {
    const t = String(text || '').trim();
    if (!t) return;
    // Defense-in-depth: ignore transcripts that land while we're thinking or
    // within the speech window (STT isn't fed then, so this should be rare).
    if (this.thinking || this._isSpeaking() || this._inSpeechWindow()) return;
    this._respond(t, false, sttLang).catch((e) => console.error('[voice] respond error:', e.message));
  }

  async _respond(text, isGreeting, sttLang) {
    const myTurn = ++this.turnId;
    this.thinking = true;

    // Update the sticky reply language for this turn. Candidate = STT's own
    // decision first (most reliable), script detection as fallback. We commit to
    // it only if there's no language yet, it matches the current one, or the
    // utterance is long enough to be a genuine switch — so a short "ok"/"نعم"
    // spoken mid-conversation never flips the language.
    if (isGreeting) {
      if (this.greetLang) this.currentLang = this.greetLang;
    } else {
      const cand = normalizeSttLang(sttLang) || detectLang(text);
      if (cand && (!this.currentLang || cand === this.currentLang || this._letters(text) >= this.langMinChars)) {
        this.currentLang = cand;
      }
    }

    let reply;
    try {
      reply = await runVoiceTurn(this.engine, {
        userId: this.userId,
        content: text,
        language: this.voice.language || null,
        isGreeting,
        // Caller-selected language applies to the OPENING line only; later turns
        // omit it so the agent follows the customer's language.
        greetLang: isGreeting ? this.greetLang : undefined,
        // Pass the STICKY committed language (not the raw per-turn tag) so a short
        // opposing utterance can't flip the reply. runVoiceTurn treats it as the
        // primary signal; on the greeting we pass none and let greetLang drive.
        sttLang: isGreeting ? undefined : (this.currentLang || undefined),
        // Inbound caller's number, so the agent's identity tools can use it.
        callerNumber: this.callerNumber || undefined,
        // Outbound: replace the generic greeting with a purposeful AI intro.
        opening: isGreeting && this.direction === 'outbound' ? this._outboundOpening() : undefined,
        // Let the agent end an outbound call via the end_call tool. Inbound omits
        // this, so nothing changes for calls the agent didn't place.
        onControl: this.direction === 'outbound' ? (c) => { if (c && c.hangup) this._pendingHangup = true; } : undefined,
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
    // Per-language voice: when enabled, speak this turn with a same-gender voice
    // for the committed language on the same provider; fall back to the main
    // voice when the provider/voice/language isn't in the table.
    let ttsVoice = tts.voice;
    if (tts.perLanguage && this.currentLang) {
      const matched = resolveVoiceForLang(tts.provider || 'azure_speech', tts.voice, this.currentLang);
      if (matched) ttsVoice = matched;
    }
    try {
      await synthesizeStream({
        provider: tts.provider || 'azure_speech',
        model: tts.model,
        voice: ttsVoice,
        region: tts.region || this.voice.region,
        rate: tts.rate,
        pitch: tts.pitch,
        style: tts.style,
        styleDegree: tts.styleDegree,
        text: reply,
        signal: ac.signal,
        workspace: this.engine.workspace,
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

    // Agent asked to end the call this turn (outbound only): once its closing
    // line has finished playing, hang up. Wait out the audio we just queued so
    // the caller actually hears the sign-off before the line drops.
    if (this._pendingHangup && myTurn === this.turnId && this.onHangup) {
      this._pendingHangup = false;
      const waitMs = Math.max(0, this.playEndAt - Date.now()) + 400;
      setTimeout(() => { try { this.onHangup(); } catch { /* ignore */ } }, waitMs);
    }
  }

  /**
   * The opening instruction for an outbound call — the agent's first words when
   * the callee picks up. It must introduce itself by name, make clear it's an AI
   * agent (not a human), and state why it's calling. The agent's own persona
   * supplies the name; we pass it explicitly too when we have it.
   */
  _outboundOpening() {
    const who = this.agentName ? `You are ${this.agentName}.` : '';
    const why = this.purpose ? ` Your reason for calling: ${this.purpose}.` : '';
    return (
      `You have just PLACED an outbound phone call and the person has answered. ${who} `.trim() +
      ` This is the very first thing you say. Introduce yourself by your name and clearly state that you are an AI agent (not a human) calling on behalf of your owner.${why} ` +
      `Be warm, natural and brief — one or two sentences — then let them respond. When your questions are answered, thank them and use the end_call tool to hang up.`
    );
  }

  close() {
    try { this.stt && this.stt.close(); } catch { /* ignore */ }
    if (this.ttsAbort) { try { this.ttsAbort.abort(); } catch { /* ignore */ } }
    this.stt = null;
    this.segment = [];
  }
}
