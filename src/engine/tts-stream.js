// Streaming text-to-speech for the real-time voice pipeline.
//
// Provider comes from the workspace voice config (voice.tts.*), nothing is
// hardcoded. Output is always 16 kHz, 16-bit, mono PCM, delivered chunk-by-chunk
// to onAudio(buf) as it is produced, so playback starts early.
//
// Two integration styles:
//   - azure_speech: the Azure Speech SDK (callback events), which emits raw
//     16 kHz PCM directly. Kept on its own path because it is not HTTP.
//   - every other provider: a shared HTTP core that fetches the audio, normalises
//     it to PCM16/16 kHz (strip a WAV header if present, resample to 16 kHz), and
//     delivers frames. Providers only differ in the request they make + whether
//     the body streams (openai/groq/elevenlabs/aimlapi) or is one shot (streetai).
//
// No MP3 decoding is ever needed: each provider is asked for PCM or WAV.
//
// synthesizeStream(...) resolves when synthesis finishes OR is aborted via the
// AbortSignal (barge-in).

import { getProviderCredential } from '../auth/credentials.js';

const OUT_RATE = 16000;
const ELEVEN_DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM'; // "Rachel"

export async function synthesizeStream({ provider = 'azure_speech', model, voice, region, text, onAudio, signal, workspace } = {}) {
  const clean = String(text || '').trim();
  if (!clean) return;
  switch (provider) {
    case 'azure_speech': return azureTtsStream({ region, voice, text: clean, onAudio, signal, workspace });
    case 'elevenlabs':   return elevenTtsStream({ model, voice, text: clean, onAudio, signal, workspace });
    case 'openai':       return openaiTtsStream({ model, voice, text: clean, onAudio, signal, workspace });
    case 'groq':         return groqTtsStream({ model, voice, text: clean, onAudio, signal, workspace });
    case 'aimlapi':      return aimlapiTtsStream({ model, voice, text: clean, onAudio, signal, workspace });
    case 'streetai':     return streetaiTtsStream({ model, voice, text: clean, onAudio, signal, workspace });
    default:
      throw new Error(`Streaming TTS not implemented for provider "${provider}".`);
  }
}

// ─── PCM16/16 kHz normalization core (shared by every HTTP provider) ────────

/**
 * Parse a RIFF/WAVE header. Returns { sampleRate, channels, bitsPerSample,
 * dataOffset, dataLen } or null if the buffer isn't (yet) a complete WAV header.
 */
export function parseWav(buf) {
  if (buf.length < 12) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let off = 12, sampleRate = OUT_RATE, channels = 1, bits = 16, dataOffset = -1, dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const sz = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      dataOffset = body; dataLen = sz; break;
    }
    off = body + sz + (sz & 1); // chunks are word-aligned
  }
  if (dataOffset < 0) return null;
  return { sampleRate, channels, bitsPerSample: bits, dataOffset, dataLen };
}

/**
 * Stateful linear resampler, mono PCM16, srcRate → 16 kHz. Carries the boundary
 * sample + fractional cursor across chunks so a streamed signal has no clicks at
 * chunk seams. srcRate === 16000 is a pass-through.
 */
export class Resampler {
  constructor(srcRate) {
    this.ratio = srcRate / OUT_RATE;   // input samples advanced per output sample
    this.carry = 0;                    // previous chunk's last sample
    this.cursor = 0;                   // fractional read pos in [carry, ...chunk]
    this.primed = false;
  }
  process(int16) {
    if (this.ratio === 1) return int16;
    const N = int16.length;
    if (N === 0) return new Int16Array(0);
    if (!this.primed) { this.carry = int16[0]; this.primed = true; } // avoid a leading zero
    // conceptual buffer b (length N+1): b[0] = carry, b[k] = int16[k-1]
    const b = (k) => (k === 0 ? this.carry : int16[k - 1]);
    const out = [];
    let c = this.cursor;
    while (Math.floor(c) < N) {           // need b[floor(c)] and b[floor(c)+1] (≤ N)
      const i = Math.floor(c), frac = c - i;
      const s = b(i) * (1 - frac) + b(i + 1) * frac;
      out.push(s < 0 ? (s - 0.5) | 0 : (s + 0.5) | 0);
      c += this.ratio;
    }
    this.carry = int16[N - 1];
    this.cursor = c - N;                  // rebase to the next chunk's origin
    return Int16Array.from(out);
  }
}

function int16FromBytes(buf, usable) {
  const n = usable >> 1;
  const a = new Int16Array(n);
  for (let i = 0; i < n; i++) a[i] = buf.readInt16LE(i * 2);
  return a;
}
function emit(int16, onAudio) {
  if (int16.length && onAudio) onAudio(Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength));
}

/** Stream an HTTP audio body → normalized PCM16/16 kHz frames on onAudio. */
export async function streamBodyToPcm16(res, { isWav, srcRate, onAudio, signal }) {
  const reader = res.body.getReader();
  let headerDone = !isWav;
  let headerBuf = Buffer.alloc(0);
  let resampler = isWav ? null : new Resampler(srcRate);
  let odd = Buffer.alloc(0); // trailing byte that split a sample across chunks
  for (;;) {
    if (signal?.aborted) return;
    let r;
    try { r = await reader.read(); } catch { return; } // aborted / socket gone
    if (r.done) break;
    let buf = Buffer.from(r.value);
    if (!headerDone) {
      headerBuf = headerBuf.length ? Buffer.concat([headerBuf, buf]) : buf;
      const wav = parseWav(headerBuf);
      if (!wav) continue;                 // wait for the rest of the header
      resampler = new Resampler(wav.sampleRate);
      buf = headerBuf.subarray(wav.dataOffset);
      headerDone = true;
    }
    if (odd.length) buf = Buffer.concat([odd, buf]);
    const usable = buf.length - (buf.length % 2);
    odd = usable < buf.length ? Buffer.from(buf.subarray(usable)) : Buffer.alloc(0);
    if (usable <= 0) continue;
    emit(resampler.process(int16FromBytes(buf, usable)), onAudio);
  }
}

/** One-shot audio buffer → normalized PCM16/16 kHz on onAudio. */
export function bufferToPcm16(audio, { isWav, srcRate, onAudio, signal }) {
  if (signal?.aborted) return;
  let buf = audio, rate = srcRate;
  if (isWav) {
    const wav = parseWav(audio);
    if (!wav) throw new Error('TTS: expected WAV audio but got something else.');
    const end = (wav.dataLen > 0 && wav.dataOffset + wav.dataLen <= audio.length)
      ? wav.dataOffset + wav.dataLen : audio.length;
    buf = audio.subarray(wav.dataOffset, end);
    rate = wav.sampleRate;
  }
  const usable = buf.length - (buf.length % 2);
  if (usable <= 0) return;
  emit(new Resampler(rate).process(int16FromBytes(buf, usable)), onAudio);
}

// Reject a decodeless-unfriendly body (MP3) with a clear message instead of noise.
function assertNotMp3(audio, provider) {
  if (audio.length >= 3 && audio.toString('ascii', 0, 3) === 'ID3') throw mp3Err(provider);
  if (audio.length >= 2 && audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0) throw mp3Err(provider);
}
function mp3Err(provider) {
  return new Error(`${provider} returned MP3, which the voice pipeline can't decode. A PCM/WAV output format is required for this provider.`);
}

// ─── Azure Speech SDK (its own transport; emits raw 16 kHz PCM) ─────────────
async function azureTtsStream({ region, voice, text, onAudio, signal, workspace }) {
  const cred = getProviderCredential('azure_speech', workspace);
  const key = cred?.apiKey;
  const reg = String(region || cred?.region || cred?.endpoint || cred?.baseUrl || '').trim();
  if (!key) throw new Error('No "azure_speech" API key.');
  if (!reg) throw new Error('No Azure region (e.g. "uaenorth").');

  const sdk = (await import('microsoft-cognitiveservices-speech-sdk')).default;
  const speechConfig = sdk.SpeechConfig.fromSubscription(key, reg);
  speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Raw16Khz16BitMonoPcm;
  speechConfig.speechSynthesisVoiceName = voice || 'ar-AE-FatimaNeural';

  const synth = new sdk.SpeechSynthesizer(speechConfig, null);
  let done = false;
  const finish = () => { if (!done) { done = true; try { synth.close(); } catch { /* ignore */ } } };
  if (signal) {
    if (signal.aborted) { finish(); return; }
    signal.addEventListener('abort', finish, { once: true });
  }
  synth.synthesizing = (_s, e) => {
    const ad = e?.result?.audioData;
    if (ad && ad.byteLength && !done && onAudio) onAudio(Buffer.from(ad));
  };
  await new Promise((resolve) => {
    synth.speakTextAsync(
      text,
      () => { finish(); resolve(); },
      (err) => { console.error('[tts:azure] error:', err); finish(); resolve(); },
    );
  });
}

// ─── HTTP providers (all via the shared normalization core) ─────────────────

// ElevenLabs streams raw pcm_16000 → no header, no resample.
async function elevenTtsStream({ model, voice, text, onAudio, signal, workspace }) {
  const cred = getProviderCredential('elevenlabs', workspace);
  if (!cred?.apiKey) throw new Error('No "elevenlabs" API key.');
  const voiceId = voice || ELEVEN_DEFAULT_VOICE;
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=pcm_16000`;
  const res = await fetch(url, {
    method: 'POST', signal,
    headers: { 'xi-api-key': cred.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: model || 'eleven_turbo_v2_5' }),
  });
  if (!res.ok || !res.body) throw await httpErr('ElevenLabs', res);
  await streamBodyToPcm16(res, { isWav: false, srcRate: OUT_RATE, onAudio, signal });
}

// OpenAI streams raw pcm (24 kHz, no header) → resample 24k→16k.
async function openaiTtsStream({ model, voice, text, onAudio, signal, workspace }) {
  const cred = getProviderCredential('openai', workspace);
  if (!cred?.apiKey) throw new Error('No "openai" API key.');
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST', signal,
    headers: { Authorization: `Bearer ${cred.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model || 'tts-1', input: text, voice: voice || 'alloy', response_format: 'pcm' }),
  });
  if (!res.ok || !res.body) throw await httpErr('OpenAI', res);
  await streamBodyToPcm16(res, { isWav: false, srcRate: 24000, onAudio, signal });
}

// Groq/Orpheus streams WAV (48 kHz) → strip header, resample 48k→16k.
async function groqTtsStream({ model, voice, text, onAudio, signal, workspace }) {
  const cred = getProviderCredential('groq', workspace);
  if (!cred?.apiKey) throw new Error('No "groq" API key.');
  const res = await fetch('https://api.groq.com/openai/v1/audio/speech', {
    method: 'POST', signal,
    headers: { Authorization: `Bearer ${cred.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || 'canopylabs/orpheus-arabic-saudi',
      input: text,
      voice: String(voice || 'aisha').toLowerCase(), // Orpheus voices are lowercase
      response_format: 'wav',
    }),
  });
  if (!res.ok || !res.body) throw await httpErr('Groq', res);
  await streamBodyToPcm16(res, { isWav: true, onAudio, signal }); // rate from the WAV header
}

// AIMLAPI can emit pcm_16000 directly. With stream:true it returns a raw body;
// some plans/paths return a JSON { audio: url } instead — handle both.
async function aimlapiTtsStream({ model, voice, text, onAudio, signal, workspace }) {
  const cred = getProviderCredential('aimlapi', workspace);
  if (!cred?.apiKey) throw new Error('No "aimlapi" API key.');
  const res = await fetch('https://api.aimlapi.com/v1/tts', {
    method: 'POST', signal,
    headers: { Authorization: `Bearer ${cred.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || 'elevenlabs/eleven_turbo_v2_5',
      text,
      voice: voice || 'Sarah',
      output_format: 'pcm_16000',
      stream: true,
    }),
  });
  if (!res.ok || !res.body) throw await httpErr('AIMLAPI', res);
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    const j = await res.json().catch(() => ({}));
    const audioUrl = (j.audio && typeof j.audio === 'object' ? j.audio.url : j.audio) || j.url;
    if (!audioUrl) throw new Error('AIMLAPI TTS returned no audio.');
    const a = await fetch(audioUrl, { signal });
    if (!a.ok) throw new Error(`AIMLAPI audio fetch failed (${a.status}).`);
    const audio = Buffer.from(await a.arrayBuffer());
    assertNotMp3(audio, 'AIMLAPI');
    const isWav = audio.length >= 4 && audio.toString('ascii', 0, 4) === 'RIFF';
    bufferToPcm16(audio, { isWav, srcRate: OUT_RATE, onAudio, signal });
    return;
  }
  await streamBodyToPcm16(res, { isWav: false, srcRate: OUT_RATE, onAudio, signal });
}

// StreetAI managed gateway: one-shot WAV (azure-tts is 24 kHz; tts-1 honours
// response_format=wav). Gateway buffers the whole reply, so normalize as a batch.
async function streetaiTtsStream({ model, voice, text, onAudio, signal, workspace }) {
  const cred = getProviderCredential('streetai', workspace);
  if (!cred?.apiKey) throw new Error('No "streetai" API key.');
  const res = await fetch('https://streetai.org/llm/v1/audio/speech', {
    method: 'POST', signal,
    headers: { Authorization: `Bearer ${cred.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model || 'azure-tts', input: text, voice: voice || 'ar-AE-FatimaNeural', response_format: 'wav' }),
  });
  if (!res.ok) throw await httpErr('StreetAI', res);
  const audio = Buffer.from(await res.arrayBuffer());
  assertNotMp3(audio, 'StreetAI');
  const isWav = audio.length >= 4 && audio.toString('ascii', 0, 4) === 'RIFF';
  bufferToPcm16(audio, { isWav, srcRate: 24000, onAudio, signal });
}

async function httpErr(name, res) {
  const t = await res.text().catch(() => '');
  return new Error(`${name} TTS stream failed (${res.status}): ${t.slice(0, 160)}`);
}
