// One-shot Azure TTS: render an SSML file to MP3 with the streetai speech SDK.
// Usage:
//   AZURE_SPEECH_KEY=xxx AZURE_SPEECH_REGION=uaenorth \
//     node tts-gen.mjs <input.ssml> <output.mp3>
import fs from 'fs';
import sdk from 'microsoft-cognitiveservices-speech-sdk';

const [, , ssmlPath, outPath] = process.argv;
const key = process.env.AZURE_SPEECH_KEY;
const region = process.env.AZURE_SPEECH_REGION || 'uaenorth';
if (!key) { console.error('Set AZURE_SPEECH_KEY (and AZURE_SPEECH_REGION).'); process.exit(1); }
if (!ssmlPath || !outPath) { console.error('Usage: node tts-gen.mjs <input.ssml> <output.mp3>'); process.exit(1); }

const ssml = fs.readFileSync(ssmlPath, 'utf8');
const speechConfig = sdk.SpeechConfig.fromSubscription(key, region);
speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Audio48Khz192KBitRateMonoMp3;
const audioConfig = sdk.AudioConfig.fromAudioFileOutput(outPath);
const synth = new sdk.SpeechSynthesizer(speechConfig, audioConfig);

synth.speakSsmlAsync(ssml, (result) => {
  synth.close();
  if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
    const kb = (fs.statSync(outPath).size / 1024).toFixed(0);
    console.log(`OK: wrote ${outPath} (${kb} KB, ~${(result.audioDuration/1e7).toFixed(1)}s)`);
    process.exit(0);
  } else {
    console.error('Synthesis failed:', result.errorDetails || result.reason);
    process.exit(2);
  }
}, (err) => { synth.close(); console.error('Error:', err); process.exit(3); });
