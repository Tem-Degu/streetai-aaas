// Per-language voice tables for the "match voice to the caller's language" mode.
//
// When an agent enables voice.tts.perLanguage, the pipeline swaps the TTS voice
// per detected language while keeping the SAME provider and the SAME gender as
// the selected main voice. Only providers with per-language (mono-lingual)
// voices belong here; genuinely multilingual providers (elevenlabs, cartesia)
// already speak every language on one voice and don't need this.
//
// Language keys are the reply-language codes the engine resolves (kept in sync
// with context.js LANG_NAMES / telnyx.js SUPPORTED_REPLY_LANGS): ar, en, hi, ml,
// fil, ru.

// Azure AI Speech neural voices, one female and one male set across the
// supported languages. fil-PH is Azure's locale for Tagalog/Filipino.
const AZURE_VOICES = {
  female: {
    ar:  'ar-AE-FatimaNeural',
    en:  'en-US-AriaNeural',
    hi:  'hi-IN-SwaraNeural',
    ml:  'ml-IN-SobhanaNeural',
    fil: 'fil-PH-BlessicaNeural',
    ru:  'ru-RU-SvetlanaNeural',
  },
  male: {
    ar:  'ar-AE-HamdanNeural',
    en:  'en-US-GuyNeural',
    hi:  'hi-IN-MadhurNeural',
    ml:  'ml-IN-MidhunNeural',
    fil: 'fil-PH-AngeloNeural',
    ru:  'ru-RU-DmitryNeural',
  },
};

// provider -> gender -> lang -> voice name. Extend with google / polly later.
const VOICE_TABLES = {
  azure_speech: AZURE_VOICES,
};

// Gender of every Azure voice offered in the dashboard voice picker. Needed so
// per-language mode can keep the SAME gender when the operator picks any voice,
// not just the two anchors above. Keep in sync with the Azure voice lists in
// dashboard/src/pages/Settings.jsx.
const AZURE_VOICE_GENDER = {
  // Arabic
  'ar-AE-FatimaNeural': 'female', 'ar-AE-HamdanNeural': 'male',
  'ar-SA-ZariyahNeural': 'female', 'ar-SA-HamedNeural': 'male',
  'ar-QA-AmalNeural': 'female', 'ar-QA-MoazNeural': 'male',
  'ar-KW-NouraNeural': 'female', 'ar-KW-FahedNeural': 'male',
  'ar-BH-LailaNeural': 'female', 'ar-BH-AliNeural': 'male',
  'ar-EG-SalmaNeural': 'female', 'ar-EG-ShakirNeural': 'male',
  'ar-JO-SanaNeural': 'female', 'ar-JO-TaimNeural': 'male',
  // English
  'en-US-AriaNeural': 'female', 'en-US-JennyNeural': 'female', 'en-US-AvaNeural': 'female',
  'en-US-GuyNeural': 'male', 'en-US-AndrewNeural': 'male', 'en-US-BrianNeural': 'male',
  'en-GB-SoniaNeural': 'female', 'en-GB-LibbyNeural': 'female', 'en-GB-RyanNeural': 'male',
  'en-IN-NeerjaNeural': 'female', 'en-IN-PrabhatNeural': 'male',
  // English HD (DragonHD) voices
  'en-US-Ava:DragonHDLatestNeural': 'female', 'en-US-Andrew:DragonHDLatestNeural': 'male',
  'en-US-Emma:DragonHDLatestNeural': 'female', 'en-US-Brian:DragonHDLatestNeural': 'male',
  // Hindi
  'hi-IN-SwaraNeural': 'female', 'hi-IN-AnanyaNeural': 'female',
  'hi-IN-MadhurNeural': 'male', 'hi-IN-AaravNeural': 'male',
  // Malayalam
  'ml-IN-SobhanaNeural': 'female', 'ml-IN-MidhunNeural': 'male',
  // Tagalog / Filipino
  'fil-PH-BlessicaNeural': 'female', 'fil-PH-AngeloNeural': 'male',
  // Russian
  'ru-RU-SvetlanaNeural': 'female', 'ru-RU-DariyaNeural': 'female', 'ru-RU-DmitryNeural': 'male',
};

// The language code an Azure voice speaks, from its locale prefix:
// 'ar-EG-SalmaNeural' -> 'ar', 'fil-PH-BlessicaNeural' -> 'fil'.
function azureVoiceLang(voice) {
  return String(voice || '').split('-')[0].toLowerCase();
}

// Gender of a voice: explicit map first, then the per-language table rows (which
// cover the anchor voices). Null when unknown → per-language can't apply.
function genderOfVoice(provider, voice) {
  if (provider === 'azure_speech') {
    const g = AZURE_VOICE_GENDER[voice];
    if (g) return g;
  }
  const table = VOICE_TABLES[provider];
  if (table) {
    const target = String(voice).toLowerCase();
    for (const g of Object.keys(table)) {
      if (Object.values(table[g]).some(v => v.toLowerCase() === target)) return g;
    }
  }
  return null;
}

/** True when a provider has per-language voice tables (so the UI shows the toggle). */
export function providerSupportsPerLanguage(provider) {
  return Object.prototype.hasOwnProperty.call(VOICE_TABLES, provider);
}

/**
 * Resolve the voice to use for `lang`, matching the gender of `mainVoice` on the
 * same provider. Returns null (→ caller falls back to the main voice) when:
 *  - the provider has no per-language table,
 *  - the main voice isn't in the table (can't infer its gender), or
 *  - that language has no mapped voice.
 */
export function resolveVoiceForLang(provider, mainVoice, lang) {
  const table = VOICE_TABLES[provider];
  if (!table || !lang || !mainVoice) return null;
  // The operator's chosen voice speaks its OWN language — never override it
  // (so picking, say, an Egyptian Arabic voice keeps Arabic in that voice).
  if (provider === 'azure_speech' && azureVoiceLang(mainVoice) === lang) return null;
  const gender = genderOfVoice(provider, mainVoice);
  if (!gender) return null;               // unknown voice → can't match gender → fall back
  return table[gender][lang] || null;     // no voice for this language → fall back
}
