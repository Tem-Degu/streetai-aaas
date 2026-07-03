// Small PCM16 mono helpers shared by the real-time voice pipeline.
//
// Internal audio currency across the pipeline is raw 16 kHz, 16-bit, mono,
// little-endian PCM carried as Node Buffers. The browser sends/receives the
// same so no resampling is needed in the core (transports normalise at their
// own edge, e.g. an SBC converting 8 kHz mulaw).

/** Decode a base64 media payload to a PCM16 Buffer. */
export function base64ToBuf(b64) {
  return Buffer.from(b64 || '', 'base64');
}

/** Encode a PCM16 Buffer to a base64 media payload. */
export function bufToBase64(buf) {
  return Buffer.from(buf).toString('base64');
}

/** A non-copying Int16 view over a PCM16 Buffer (for VAD/energy maths). */
export function int16View(buf) {
  return new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength >> 1);
}

// ─── G.711 μ-law (PCMU) + 8k↔16k resampling ──────────────────────────────
// Telephony is 8 kHz μ-law; the pipeline is 16 kHz PCM16. These let a transport
// (an SBC media stream) declare its codec and have the connector normalise at
// the edge. Browser audio is already PCM16/16k, so its codec is the identity.

const BIAS = 0x84, CLIP = 32635;

/** One μ-law byte → signed 16-bit linear sample (standard G.711). */
function ulawDecodeSample(uVal) {
  uVal = ~uVal & 0xff;
  let t = ((uVal & 0x0f) << 3) + BIAS;
  t <<= (uVal & 0x70) >> 4;
  return (uVal & 0x80) ? (BIAS - t) : (t - BIAS);
}

/** One signed 16-bit linear sample → μ-law byte (standard G.711). */
function ulawEncodeSample(sample) {
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** Decode μ-law bytes (a Buffer) to a PCM16 Int16Array (same sample count). */
export function ulawToPcm16(buf) {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = ulawDecodeSample(buf[i]);
  return out;
}

/** Encode a PCM16 Int16Array to μ-law bytes (a Buffer, same sample count). */
export function pcm16ToUlaw(int16) {
  const out = Buffer.alloc(int16.length);
  for (let i = 0; i < int16.length; i++) out[i] = ulawEncodeSample(int16[i]);
  return out;
}

/** Linear-interpolate 8 kHz PCM16 up to 16 kHz (2× length). */
function upsample2x(int16) {
  const n = int16.length, out = new Int16Array(n * 2);
  for (let i = 0; i < n; i++) {
    const cur = int16[i], next = i + 1 < n ? int16[i + 1] : cur;
    out[2 * i] = cur;
    out[2 * i + 1] = (cur + next) >> 1;
  }
  return out;
}

/** Average-pair 16 kHz PCM16 down to 8 kHz (½ length) — a cheap anti-alias. */
function downsample2x(int16) {
  const n = int16.length >> 1, out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = (int16[2 * i] + int16[2 * i + 1]) >> 1;
  return out;
}

/** Buffer that views the raw bytes of a typed array (no value copy). */
function bytesOf(ta) {
  return Buffer.from(ta.buffer, ta.byteOffset, ta.byteLength);
}

/**
 * Build the codec for a transport's declared `format`, normalising both ways to
 * the pipeline's PCM16/16k currency. `format` may be a string ("pcmu", "mulaw",
 * "g711u", "pcm") or an object `{ encoding, sampleRate }`. Anything that resolves
 * to PCM16/16k (incl. undefined — the browser default) returns an **identity**
 * codec so that path is byte-for-byte unchanged and free.
 *
 * @returns {{ identity:boolean, label:string,
 *             decodeIn:(buf:Buffer)=>Buffer,    // wire bytes  → PCM16/16k Buffer
 *             encodeOut:(buf:Buffer)=>Buffer }}  // PCM16/16k Buffer → wire bytes
 */
export function makeVoiceCodec(format) {
  let enc = 'pcm', rate = 16000;
  if (typeof format === 'string') {
    const f = format.toLowerCase();
    const m = f.match(/(\d{4,6})/);              // optional explicit rate, e.g. "l16-8000"
    const isMulaw = /mulaw|ulaw|pcmu|g711u?/.test(f);
    enc = isMulaw ? 'mulaw' : 'pcm';
    rate = m ? Number(m[1]) : (isMulaw ? 8000 : 16000);
  } else if (format && typeof format === 'object') {
    const e = String(format.encoding || '').toLowerCase();
    if (/mulaw|ulaw|pcmu|g711u?/.test(e)) enc = 'mulaw';
    rate = Number(format.sampleRate || format.rate) || (enc === 'mulaw' ? 8000 : 16000);
  }

  if (enc === 'pcm' && rate === 16000) {
    return { identity: true, label: 'pcm16/16k', decodeIn: (b) => b, encodeOut: (b) => b };
  }
  if (enc === 'mulaw') {
    return {
      identity: false, label: `mulaw/${rate}`,
      decodeIn: (b) => {
        let pcm = ulawToPcm16(b);
        if (rate === 8000) pcm = upsample2x(pcm);
        return bytesOf(pcm);
      },
      encodeOut: (b) => {
        let pcm = int16View(b);
        if (rate === 8000) pcm = downsample2x(pcm);
        return pcm16ToUlaw(pcm);
      },
    };
  }
  // PCM16 at a non-16k rate (rare) → resample only.
  return {
    identity: false, label: `pcm16/${rate}`,
    decodeIn: (b) => (rate === 8000 ? bytesOf(upsample2x(int16View(b))) : b),
    encodeOut: (b) => (rate === 8000 ? bytesOf(downsample2x(int16View(b))) : b),
  };
}

/** Wrap raw PCM16 mono bytes in a WAV container (for batch STT endpoints). */
export function pcm16ToWav(pcmBuf, sampleRate = 16000) {
  const dataLen = pcmBuf.length;
  const out = Buffer.alloc(44 + dataLen);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + dataLen, 4);
  out.write('WAVE', 8);
  out.write('fmt ', 12);
  out.writeUInt32LE(16, 16);       // PCM chunk size
  out.writeUInt16LE(1, 20);        // audio format = PCM
  out.writeUInt16LE(1, 22);        // channels = 1
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28); // byte rate (16-bit mono)
  out.writeUInt16LE(2, 32);        // block align
  out.writeUInt16LE(16, 34);       // bits per sample
  out.write('data', 36);
  out.writeUInt32LE(dataLen, 40);
  pcmBuf.copy(out, 44);
  return out;
}
