import { getProviderCredential } from '../auth/credentials.js';

// Text-to-speech for spoken replies (Web Call / voice channels).
//
// Provider-agnostic mirror of transcription.js: any service exposing an
// OpenAI-compatible `/audio/speech` endpoint works by adding one entry to
// TTS_PROVIDERS (or passing an explicit `endpoint`). The API key is resolved
// from the normal credentials store keyed by provider name — the same place
// the LLM and STT keys live, so no separate key handling.

const MAX_TTS_CHARS = 4000; // keep requests bounded; spoken replies are short

const MIME_BY_FORMAT = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  aac: 'audio/aac',
};

const TTS_PROVIDERS = {
  // Groq serves Orpheus TTS (Canopy Labs). The Arabic-Saudi model gives natural
  // Gulf-Arabic speech. Voices (lowercase, as the API requires): abdullah,
  // fahad, sultan (male), lulwa, noura, aisha (female). `aisha` is a clear,
  // approachable female voice well suited to a reception/customer-service agent.
  // NOTE: Orpheus models require a one-time terms acceptance by the org admin in
  // the Groq console before they return audio
  // (https://console.groq.com/playground?model=canopylabs/orpheus-arabic-saudi).
  groq: {
    url: 'https://api.groq.com/openai/v1/audio/speech',
    defaultModel: 'canopylabs/orpheus-arabic-saudi',
    defaultVoice: 'aisha',
  },
  openai: {
    url: 'https://api.openai.com/v1/audio/speech',
    defaultModel: 'tts-1',
    defaultVoice: 'alloy',
  },
  // Microsoft Azure AI Speech — NOT OpenAI-compatible (SSML + region), handled
  // by its own branch below. Locale-specific neural voices (e.g. UAE Arabic
  // `ar-AE-FatimaNeural`) and SSML rate/pitch control. Uses its OWN credential
  // `azure_speech` (separate from `azure`, which is Azure OpenAI / the LLM) and
  // a region (config voice `region`, e.g. "uaenorth").
  azure_speech: {
    url: null,
    defaultModel: '',
    defaultVoice: 'ar-AE-FatimaNeural',
  },
  // ElevenLabs — most expressive multilingual TTS (incl. Arabic via the
  // multilingual model). NOT OpenAI-compatible; own branch below. `voice` is an
  // ElevenLabs voice_id (account-specific); credential `elevenlabs` (xi-api-key).
  elevenlabs: {
    url: null,
    defaultModel: 'eleven_multilingual_v2',
    defaultVoice: '', // must be set to a voice_id
  },
  // AI/ML API (aimlapi.com) — proxies ElevenLabs (and others) via your AIMLAPI
  // credits, so it works without a paid ElevenLabs plan. Own API shape; voices
  // are by NAME (Sarah, Aria, …). Credential `aimlapi`. Own branch below.
  aimlapi: {
    url: 'https://api.aimlapi.com/v1/tts',
    defaultModel: 'elevenlabs/eleven_turbo_v2_5',
    defaultVoice: 'Sarah',
  },
  // StreetAI managed: OpenAI-compatible, routes to StreetAI's metered audio
  // gateway (it fronts the upstream cost and bills your StreetAI wallet). Key =
  // the `streetai` credential.
  streetai: {
    url: 'https://streetai.org/llm/v1/audio/speech',
    defaultModel: 'azure-tts',
    defaultVoice: 'ar-AE-FatimaNeural',
  },
};

/** Provider keys we ship with built-in endpoints. */
export function ttsProviderList() {
  return Object.keys(TTS_PROVIDERS);
}

/** Default model for a provider, if known. */
export function ttsDefaultModel(provider) {
  return TTS_PROVIDERS[provider]?.defaultModel || '';
}

/** Default voice for a provider, if known. */
export function ttsDefaultVoice(provider) {
  return TTS_PROVIDERS[provider]?.defaultVoice || '';
}

/**
 * Synthesize spoken audio from text.
 *
 * @param {object} opts
 * @param {string} opts.text       The text to speak.
 * @param {string} opts.provider   Credential/provider name (e.g. 'groq', 'openai').
 * @param {string} [opts.model]    Override model; falls back to the provider default.
 * @param {string} [opts.voice]    Voice id; falls back to the provider default.
 * @param {string} [opts.format]   Audio container ('wav' default).
 * @param {string} [opts.endpoint] Override URL for a custom OpenAI-compatible host.
 * @param {string} [opts.region]   Azure region (e.g. 'uaenorth') — Azure only.
 * @param {string} [opts.rate]     SSML prosody rate (e.g. '-5%') — Azure only.
 * @param {string} [opts.pitch]    SSML prosody pitch (e.g. '+0%') — Azure only.
 * @returns {Promise<{ buffer: Buffer, mime: string }>}
 */
export async function synthesizeSpeech({ text, provider = 'groq', model, voice, format = 'wav', endpoint, region, rate, pitch, stability, style, speed, similarityBoost, workspace } = {}) {
  const clean = (text || '').trim();
  if (!clean) throw new Error('No text to synthesize.');

  // Azure speaks SSML to a region-specific endpoint — its own path.
  if (provider === 'azure_speech') {
    return azureSynthesize({ text: clean, voice: voice || TTS_PROVIDERS.azure_speech.defaultVoice, region, rate, pitch, workspace });
  }

  // ElevenLabs uses its own JSON API + voice_settings — its own path.
  if (provider === 'elevenlabs') {
    return elevenlabsSynthesize({ text: clean, voice, model, stability, style, speed, similarityBoost, workspace });
  }

  // AI/ML API proxies ElevenLabs et al. via aimlapi.com — its own path.
  if (provider === 'aimlapi') {
    return aimlapiSynthesize({ text: clean, voice, model, stability, style, speed, similarityBoost, workspace });
  }

  const spec = TTS_PROVIDERS[provider];
  const url = endpoint || spec?.url;
  if (!url) throw new Error(`Unknown TTS provider "${provider}" and no endpoint given.`);

  const cred = getProviderCredential(provider, workspace);
  if (!cred?.apiKey) {
    throw new Error(`No API key for "${provider}". Add it in Settings → Add API Key.`);
  }

  // Groq's Orpheus voices are lowercase-only (e.g. `aisha`, `lulwa`); it rejects
  // `Aisha`. Normalize so any stored/selected casing works.
  let resolvedVoice = voice || spec?.defaultVoice;
  if (provider === 'groq' && resolvedVoice) resolvedVoice = String(resolvedVoice).toLowerCase();

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cred.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: model || spec?.defaultModel,
      input: clean.slice(0, MAX_TTS_CHARS),
      voice: resolvedVoice,
      response_format: format,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`TTS failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, mime: MIME_BY_FORMAT[format] || 'application/octet-stream' };
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * Microsoft Azure AI Speech (Cognitive Services TTS). Speaks SSML to a
 * region endpoint. Key from the `azure` credential; region from `region`
 * (or the credential's `region`/`endpoint`/`baseUrl`). Locale is derived from
 * the voice name (e.g. `ar-AE-FatimaNeural` → `ar-AE`). Optional SSML `rate`
 * and `pitch` (e.g. '-5%', '+0%'). Returns 24 kHz WAV.
 */
async function azureSynthesize({ text, voice, region, rate, pitch, workspace }) {
  const cred = getProviderCredential('azure_speech', workspace);
  if (!cred?.apiKey) {
    throw new Error('No API key for "azure_speech". Add it in Settings → Add API Key (Azure Speech).');
  }
  const reg = String(region || cred.region || cred.endpoint || cred.baseUrl || '').trim();
  if (!reg) {
    throw new Error('Azure region not set (e.g. "uaenorth"). Set it on the voice config (region) or the azure credential.');
  }
  const v = voice || 'ar-AE-FatimaNeural';
  const lang = v.split('-').slice(0, 2).join('-') || 'ar-AE';
  const inner = escapeXml(text.slice(0, 5000));

  // Only accept well-formed prosody values, so a bad entry (e.g. "3" instead of
  // "+3%") is ignored rather than producing invalid SSML.
  const RATE_OK = /^([+-]?\d+(\.\d+)?%|x-slow|slow|medium|fast|x-fast|default)$/;
  const PITCH_OK = /^([+-]?\d+(\.\d+)?(%|st|Hz)|x-low|low|medium|high|x-high|default)$/;
  const rateAttr = RATE_OK.test(String(rate || '')) ? ` rate="${rate}"` : '';
  const pitchAttr = PITCH_OK.test(String(pitch || '')) ? ` pitch="${pitch}"` : '';

  const url = `https://${reg}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const headers = {
    'Ocp-Apim-Subscription-Key': cred.apiKey,
    'Content-Type': 'application/ssml+xml',
    'X-Microsoft-OutputFormat': 'riff-24khz-16bit-mono-pcm',
    'User-Agent': 'aaas',
  };
  const speak = (bodyXml) => fetch(url, {
    method: 'POST', headers,
    body: `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}"><voice name="${v}">${bodyXml}</voice></speak>`,
  });

  const usedProsody = rateAttr || pitchAttr;
  let res = await speak(usedProsody ? `<prosody${rateAttr}${pitchAttr}>${inner}</prosody>` : inner);
  // If the prosody made Azure reject the request, retry once as plain text so
  // the agent still speaks (degrades gracefully instead of going silent).
  if (!res.ok && usedProsody) {
    console.warn('[tts] Azure rejected prosody (rate/pitch); retrying without it.');
    res = await speak(inner);
  }
  if (!res.ok) {
    const b = await res.text().catch(() => '');
    throw new Error(`Azure TTS failed (${res.status}): ${b.slice(0, 160)}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, mime: 'audio/wav' };
}

/**
 * ElevenLabs TTS. `voice` is an ElevenLabs voice_id (account/library-specific);
 * `model` defaults to the multilingual model (Arabic-capable). Expressiveness is
 * controlled by voice_settings: lower `stability` = more expressive/varied,
 * `style` adds expressiveness, `speed` (0.7–1.2) adjusts pace. Returns MP3
 * (the browser decodes it via Web Audio just like WAV).
 */
async function elevenlabsSynthesize({ text, voice, model, stability, style, speed, similarityBoost, workspace }) {
  const cred = getProviderCredential('elevenlabs', workspace);
  if (!cred?.apiKey) {
    throw new Error('No API key for "elevenlabs". Add it in Settings → Add API Key.');
  }
  const voiceId = voice || TTS_PROVIDERS.elevenlabs.defaultVoice;
  if (!voiceId) {
    throw new Error('ElevenLabs voice not set. Pick a voice_id (Settings → Voice) — choose an Arabic voice from your ElevenLabs library.');
  }
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const voiceSettings = {
    stability: num(stability, 0.45),
    similarity_boost: num(similarityBoost, 0.8),
    style: num(style, 0.3),
    use_speaker_boost: true,
  };
  const sp = num(speed, NaN);
  if (sp >= 0.7 && sp <= 1.2) voiceSettings.speed = sp;

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': cred.apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({
      text: text.slice(0, 5000),
      model_id: model || TTS_PROVIDERS.elevenlabs.defaultModel,
      voice_settings: voiceSettings,
    }),
  });
  if (!res.ok) {
    const b = await res.text().catch(() => '');
    throw new Error(`ElevenLabs TTS failed (${res.status}): ${b.slice(0, 160)}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, mime: 'audio/mpeg' };
}

/**
 * AI/ML API (aimlapi.com) TTS — proxies ElevenLabs (and others). `voice` is a
 * voice NAME (e.g. "Sarah", "Aria"); `model` like "elevenlabs/eleven_turbo_v2_5".
 * The response is either raw audio bytes or a JSON `{ audio: <url> }` (depending
 * on streaming) — we handle both. Returns MP3.
 */
async function aimlapiSynthesize({ text, voice, model, stability, style, speed, similarityBoost, workspace }) {
  const cred = getProviderCredential('aimlapi', workspace);
  if (!cred?.apiKey) {
    throw new Error('No API key for "aimlapi". Add it in Settings → Add API Key.');
  }
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const voice_settings = {
    stability: num(stability, 0.45),
    similarity_boost: num(similarityBoost, 0.8),
    style: num(style, 0.3),
    use_speaker_boost: true,
  };
  const sp = num(speed, NaN);
  if (sp >= 0.7 && sp <= 1.2) voice_settings.speed = sp;

  const res = await fetch('https://api.aimlapi.com/v1/tts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${cred.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || TTS_PROVIDERS.aimlapi.defaultModel,
      text: text.slice(0, 5000),
      voice: voice || TTS_PROVIDERS.aimlapi.defaultVoice,
      output_format: 'mp3_44100_128',
      voice_settings,
      stream: false,
    }),
  });
  if (!res.ok) {
    const b = await res.text().catch(() => '');
    throw new Error(`AIMLAPI TTS failed (${res.status}): ${b.slice(0, 160)}`);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    // Non-streaming: returns a URL to the generated audio — fetch it. The URL
    // may be a string or a nested object: { audio: { url: "..." } }.
    const j = await res.json().catch(() => ({}));
    const audioUrl = (j.audio && typeof j.audio === 'object' ? j.audio.url : j.audio) || j.url;
    if (!audioUrl) throw new Error('AIMLAPI TTS returned no audio URL');
    const a = await fetch(audioUrl);
    if (!a.ok) throw new Error(`AIMLAPI audio fetch failed (${a.status})`);
    return { buffer: Buffer.from(await a.arrayBuffer()), mime: a.headers.get('content-type') || 'audio/mpeg' };
  }
  // Streaming/binary: the body IS the audio.
  return { buffer: Buffer.from(await res.arrayBuffer()), mime: ct || 'audio/mpeg' };
}
