// Streaming speech-to-text for the real-time voice pipeline.
//
// Provider comes from the workspace voice config (Settings -> Voice messages),
// nothing is hardcoded. Two modes:
//
//   - 'stream'  (azure_speech): true continuous recognition via the Azure Speech
//     SDK. We push PCM16 frames as they arrive; the SDK emits partial + final
//     transcripts and does its own endpointing.
//   - 'segment' (groq / openai / any OpenAI-compatible Whisper): the pipeline's
//     VAD slices speech at pauses and hands us a complete utterance, which we
//     transcribe with the existing batch endpoint.
//
// createSttStream(...) returns a uniform handle:
//   { mode, pushFrame(buf)|null, transcribeSegment(buf)|null, close() }
// Finals/partials are reported via the onFinal/onPartial callbacks.

import { transcribeAudio } from './transcription.js';
import { getProviderCredential } from '../auth/credentials.js';
import { pcm16ToWav } from './audio-utils.js';

const PCM_RATE = 16000;

/** Map a voice-config STT "model" to Azure language(s). 'auto' => bilingual. */
function azureLanguages(model) {
  const m = String(model || 'auto').toLowerCase();
  if (!m || m === 'auto') return ['ar-AE', 'en-US'];
  if (m === 'ar-ae' || m === 'ar' || m === 'arabic') return ['ar-AE'];
  if (m === 'en-us' || m === 'en' || m === 'english') return ['en-US'];
  return [model]; // already a BCP-47 tag
}

export async function createSttStream({ provider = 'groq', model, region, endpointSilenceMs, segmentation, onPartial, onFinal } = {}) {
  if (provider === 'azure_speech') {
    return azureStreamStt({ model, region, endpointSilenceMs, segmentation, onPartial, onFinal });
  }
  return segmentStt({ provider, model, onFinal });
}

// --- Azure: true streaming via the Speech SDK ------------------------------
async function azureStreamStt({ model, region, endpointSilenceMs, segmentation, onPartial, onFinal }) {
  const cred = getProviderCredential('azure_speech');
  const key = cred?.apiKey;
  const reg = String(region || cred?.region || cred?.endpoint || cred?.baseUrl || '').trim();
  if (!key) throw new Error('No "azure_speech" API key. Add it in Settings -> Add API Key.');
  if (!reg) throw new Error('No Azure region (e.g. "uaenorth"). Set it on the voice config or the azure_speech credential.');

  const sdk = (await import('microsoft-cognitiveservices-speech-sdk')).default;
  const speechConfig = sdk.SpeechConfig.fromSubscription(key, reg);
  // Finalise a turn faster after the caller stops talking (Azure's default
  // end-silence wait is long, which adds dead air before the agent even starts).
  const silenceMs = Math.max(200, Math.min(2000, Number(endpointSilenceMs) || 600));
  try { speechConfig.setProperty(sdk.PropertyId.Speech_SegmentationSilenceTimeoutMs, String(silenceMs)); } catch { /* older SDK */ }

  // Turn detection. Defaults to "semantic": Azure's AI model decides phrase
  // boundaries from content (smarter than fixed silence). Set voice.segmentation
  // to "default" to fall back to the silence timeout above.
  const strategy = String(segmentation || 'semantic').toLowerCase();
  if (strategy === 'semantic') {
    try { speechConfig.setProperty(sdk.PropertyId.Speech_SegmentationStrategy, 'Semantic'); } catch { /* older SDK */ }
  }

  const langs = azureLanguages(model);
  const fmt = sdk.AudioStreamFormat.getWaveFormatPCM(PCM_RATE, 16, 1);
  const pushStream = sdk.AudioInputStream.createPushStream(fmt);
  const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);

  let recognizer;
  if (langs.length > 1) {
    const auto = sdk.AutoDetectSourceLanguageConfig.fromLanguages(langs);
    recognizer = sdk.SpeechRecognizer.FromConfig(speechConfig, auto, audioConfig);
  } else {
    speechConfig.speechRecognitionLanguage = langs[0];
    recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
  }

  recognizer.recognizing = (_s, e) => {
    const t = e?.result?.text;
    if (t && onPartial) onPartial(t);
  };
  recognizer.recognized = (_s, e) => {
    if (e?.result?.reason === sdk.ResultReason.RecognizedSpeech) {
      const t = (e.result.text || '').trim();
      if (t && onFinal) onFinal(t);
    }
  };
  recognizer.canceled = (_s, e) => {
    console.error('[stt:azure] canceled:', e?.errorDetails || e?.reason);
  };
  recognizer.startContinuousRecognitionAsync(undefined, (err) => {
    console.error('[stt:azure] start failed:', err);
  });

  return {
    mode: 'stream',
    pushFrame(buf) {
      try {
        // Azure wants an ArrayBuffer of the frame bytes.
        pushStream.write(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      } catch { /* stream closing */ }
    },
    transcribeSegment: null,
    close() {
      try {
        recognizer.stopContinuousRecognitionAsync(() => {
          try { recognizer.close(); } catch { /* ignore */ }
          try { pushStream.close(); } catch { /* ignore */ }
        }, () => {});
      } catch { /* ignore */ }
    },
  };
}

// --- OpenAI-compatible (Groq / OpenAI): VAD-segmented batch ----------------
function segmentStt({ provider, model, onFinal }) {
  return {
    mode: 'segment',
    pushFrame: null,
    async transcribeSegment(pcmBuf) {
      try {
        const wav = pcm16ToWav(pcmBuf, PCM_RATE);
        const text = await transcribeAudio({
          buffer: wav,
          filename: 'audio.wav',
          provider,
          model,
        });
        const t = (text || '').trim();
        if (t && onFinal) onFinal(t);
      } catch (e) {
        console.error('[stt:segment] error:', e.message);
      }
    },
    close() { /* nothing to tear down */ },
  };
}
