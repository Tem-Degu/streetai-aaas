import fs from 'fs';
import path from 'path';
import { getProviderCredential } from '../auth/credentials.js';

// Speech-to-text for inbound customer voice messages.
//
// Provider-agnostic: any service that exposes an OpenAI-compatible
// `/audio/transcriptions` endpoint works by adding one entry to STT_PROVIDERS
// (or by passing an explicit `endpoint` for a custom host). The API key is
// resolved from the normal credentials store keyed by provider name — the
// same place LLM keys live — so a voice key is added like any other API key.

const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // keep well under common 25–40 MB limits

const STT_PROVIDERS = {
  groq:   { url: 'https://api.groq.com/openai/v1/audio/transcriptions', defaultModel: 'whisper-large-v3-turbo' },
  openai: { url: 'https://api.openai.com/v1/audio/transcriptions',      defaultModel: 'whisper-1' },
  // StreetAI managed: routes to StreetAI's metered audio gateway (it fronts the
  // upstream cost and bills your StreetAI wallet). Key = the `streetai` credential.
  streetai: { url: 'https://streetai.org/llm/v1/audio/transcriptions',  defaultModel: 'azure-stt' },
};

/** Provider keys we ship with built-in endpoints. */
export function sttProviderList() {
  return Object.keys(STT_PROVIDERS);
}

/** Default model for a provider, if known. */
export function sttDefaultModel(provider) {
  return STT_PROVIDERS[provider]?.defaultModel || '';
}

/**
 * Transcribe an audio file to text.
 *
 * Provide EITHER `filePath` (read from disk — used by the voice-note path) OR
 * `buffer` + `filename` (in-memory — used by the Web Call path so we don't
 * write a temp file per turn).
 *
 * @param {object} opts
 * @param {string} [opts.filePath]  Absolute path to the audio file.
 * @param {Buffer} [opts.buffer]    In-memory audio bytes (alternative to filePath).
 * @param {string} [opts.filename]  Filename hint for the buffer (extension matters).
 * @param {string} opts.provider  Credential/provider name (e.g. 'groq', 'openai').
 * @param {string} [opts.model]   Override model; falls back to the provider default.
 * @param {string} [opts.language] Optional ISO-639-1 hint (e.g. 'en'); omit to auto-detect.
 * @param {string} [opts.endpoint] Override URL for a custom OpenAI-compatible host.
 * @returns {Promise<string>} The transcript (may be empty if speech wasn't detected).
 */
export async function transcribeAudio({ filePath, buffer: inputBuffer, filename, provider = 'groq', model, language, region, endpoint } = {}) {
  // Azure Speech is not OpenAI-compatible (region endpoint + its own response
  // shape), so it has its own branch. The live Voice Call connector uses Azure's
  // streaming SDK instead; this batch path covers voice notes (WAV / OGG-Opus).
  if (provider === 'azure_speech') {
    return azureBatchTranscribe({ filePath, buffer: inputBuffer, filename, model, language, region });
  }

  const spec = STT_PROVIDERS[provider];
  const url = endpoint || spec?.url;
  if (!url) throw new Error(`Unknown transcription provider "${provider}" and no endpoint given.`);

  const cred = getProviderCredential(provider);
  if (!cred?.apiKey) {
    throw new Error(`No API key for "${provider}". Add it in Settings → Add API Key.`);
  }

  // Resolve the audio bytes from either an in-memory buffer or a file on disk.
  let buffer, name;
  if (inputBuffer) {
    buffer = inputBuffer;
    name = filename || 'audio.webm';
  } else {
    if (!filePath) throw new Error('transcribeAudio requires either filePath or buffer.');
    if (!fs.existsSync(filePath)) throw new Error(`Audio file not found: ${filePath}`);
    buffer = fs.readFileSync(filePath);
    name = path.basename(filePath);
  }

  if (buffer.length > MAX_AUDIO_BYTES) {
    throw new Error(`Audio is too large (${Math.round(buffer.length / 1048576)} MB).`);
  }

  const form = new FormData();
  form.append('file', new Blob([buffer]), name);
  form.append('model', model || spec?.defaultModel || 'whisper-1');
  form.append('response_format', 'json');
  if (language) form.append('language', language);

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cred.apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Transcription failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = await res.json().catch(() => ({}));
  return (data.text || '').trim();
}

// Map an audio filename to the Content-Type Azure's short-audio REST accepts.
function azureContentType(name) {
  const n = String(name || '').toLowerCase();
  if (n.endsWith('.wav')) return 'audio/wav; codecs=audio/pcm; samplerate=16000';
  if (n.endsWith('.ogg') || n.endsWith('.opus')) return 'audio/ogg; codecs=opus';
  return null; // webm/mp3/etc. are not accepted by this endpoint
}

/**
 * Azure Speech batch (short-audio) transcription. Accepts WAV (PCM16) or
 * OGG-Opus. `model` carries the language ('auto' | 'ar-AE' | 'en-US'); 'auto'
 * falls back to en-US here (the streaming SDK path does true auto-detect).
 */
async function azureBatchTranscribe({ filePath, buffer: inputBuffer, filename, model, language, region }) {
  const cred = getProviderCredential('azure_speech');
  if (!cred?.apiKey) throw new Error('No API key for "azure_speech". Add it in Settings → Add API Key (Azure Speech).');
  const reg = String(region || cred.region || cred.endpoint || cred.baseUrl || '').trim();
  if (!reg) throw new Error('Azure region not set (e.g. "uaenorth"). Set it on the voice config (region) or the azure_speech credential.');

  let buffer, name;
  if (inputBuffer) { buffer = inputBuffer; name = filename || 'audio.wav'; }
  else {
    if (!filePath) throw new Error('transcribeAudio requires either filePath or buffer.');
    if (!fs.existsSync(filePath)) throw new Error(`Audio file not found: ${filePath}`);
    buffer = fs.readFileSync(filePath);
    name = path.basename(filePath);
  }

  const contentType = azureContentType(name);
  if (!contentType) throw new Error(`Azure Speech batch accepts WAV or OGG-Opus, not "${name}". Use Groq/OpenAI for this format, or the live Voice Call connector.`);

  const lang = language || (model && model !== 'auto' ? model : 'en-US');
  const url = `https://${reg}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(lang)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Ocp-Apim-Subscription-Key': cred.apiKey, 'Content-Type': contentType, Accept: 'application/json' },
    body: buffer,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Azure transcription failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = await res.json().catch(() => ({}));
  return (data.DisplayText || data.displayText || '').trim();
}
