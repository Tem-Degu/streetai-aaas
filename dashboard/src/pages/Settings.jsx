import React, { useState, useEffect, useContext } from 'react';
import { useApi, WorkspaceContext } from '../hooks/useApi.js';
import { ThemeContext } from '../hooks/useTheme.js';
import { useNavMode } from '../hooks/useNavMode.js';

const PROVIDERS = [
  { value: 'streetai', label: 'StreetAI', hasOAuth: false },
  { value: 'anthropic', label: 'Anthropic (Claude)', hasOAuth: true },
  { value: 'openai', label: 'OpenAI (GPT)', hasOAuth: false },
  { value: 'google', label: 'Google (Gemini)', hasOAuth: true },
  { value: 'ollama', label: 'Ollama (Local)', hasOAuth: false },
  { value: 'openrouter', label: 'OpenRouter', hasOAuth: false },
  { value: 'azure', label: 'Azure OpenAI', hasOAuth: true },
  { value: 'azure_speech', label: 'Azure Speech (TTS voices)', hasOAuth: false },
  { value: 'elevenlabs', label: 'ElevenLabs (TTS voices)', hasOAuth: false },
  { value: 'aimlapi', label: 'AI/ML API (TTS via aimlapi.com)', hasOAuth: false },
  { value: 'deepseek', label: 'DeepSeek', hasOAuth: false },
  { value: 'mistral', label: 'Mistral', hasOAuth: false },
  { value: 'groq', label: 'Groq', hasOAuth: false },
];

// Speech-to-text providers offered for the "Voice messages" card. Any
// OpenAI-compatible /audio/transcriptions provider can be added here; the
// engine resolves the API key from the matching credential. The first model
// listed is the default for that provider.
const VOICE_PROVIDERS = [
  {
    value: 'groq',
    label: 'Groq (Whisper)',
    models: [
      { value: 'whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo — fast (recommended)' },
      { value: 'whisper-large-v3', label: 'Whisper Large v3 — most accurate' },
    ],
  },
  {
    value: 'openai',
    label: 'OpenAI (Whisper)',
    models: [
      { value: 'whisper-1', label: 'Whisper (whisper-1)' },
      { value: 'gpt-4o-mini-transcribe', label: 'GPT-4o mini transcribe' },
      { value: 'gpt-4o-transcribe', label: 'GPT-4o transcribe — most accurate' },
    ],
  },
  {
    // Microsoft Azure Speech — real streaming STT for the live Voice Call
    // connector, and batch (WAV/OGG) for voice notes. Uses the `azure_speech`
    // key + the region set on the TTS card. The "model" picks the language.
    value: 'azure_speech',
    label: 'Microsoft Azure (Speech)',
    models: [
      { value: 'auto', label: 'Auto-detect (Arabic + English)' },
      { value: 'ar-AE', label: 'Arabic (UAE)' },
      { value: 'en-US', label: 'English (US)' },
    ],
  },
  {
    // StreetAI managed: routes STT through StreetAI's metered audio gateway
    // (StreetAI fronts the cost, billed to your StreetAI wallet). Uses the
    // `streetai` key.
    value: 'streetai',
    label: 'StreetAI (managed)',
    models: [
      { value: 'azure-stt', label: 'Azure (Arabic + English)' },
      { value: 'whisper-1', label: 'Whisper' },
    ],
  },
];

// TTS providers that have per-language voice tables (mono-lingual voices), so the
// "Match voice to the caller's language" toggle applies. Genuinely multilingual
// providers (elevenlabs) speak every language on one voice and don't need it.
// Keep in sync with src/engine/voice-table.js VOICE_TABLES.
const PER_LANGUAGE_TTS_PROVIDERS = ['azure_speech'];

// Azure voices that accept an mstts speaking style (the tone selector). Azure
// styles are voice-specific; these support "customerservice". Keep in sync with
// VOICE_STYLES in src/engine/tts-stream.js.
const STYLE_CAPABLE_VOICES = ['en-US-AriaNeural', 'en-US-JennyNeural'];
const TTS_STYLE_OPTIONS = ['customerservice', 'chat', 'friendly', 'cheerful', 'hopeful', 'newscast'];

// Text-to-speech providers for spoken replies (Web Call). The voice list is
// per-model. Groq's Orpheus Arabic-Saudi model requires a one-time terms
// acceptance in the Groq console before it returns audio.
const TTS_PROVIDERS = [
  {
    value: 'groq',
    label: 'Groq (Orpheus)',
    models: [
      {
        value: 'canopylabs/orpheus-arabic-saudi',
        label: 'Orpheus Arabic (Saudi/Gulf) — natural Arabic',
        voices: ['aisha', 'noura', 'lulwa', 'abdullah', 'fahad', 'sultan'],
      },
      {
        value: 'canopylabs/orpheus-v1-english',
        label: 'Orpheus English',
        voices: ['hannah', 'autumn', 'diana', 'austin', 'daniel', 'troy'],
      },
    ],
  },
  {
    value: 'openai',
    label: 'OpenAI',
    models: [
      { value: 'tts-1', label: 'TTS-1', voices: ['alloy', 'nova', 'shimmer', 'echo', 'fable', 'onyx'] },
      { value: 'gpt-4o-mini-tts', label: 'GPT-4o mini TTS', voices: ['alloy', 'nova', 'shimmer', 'echo', 'fable', 'onyx'] },
    ],
  },
  {
    // Azure AI Speech — locale-specific neural voices (incl. UAE Arabic) with
    // SSML control. Uses the `azure_speech` key (separate from Azure OpenAI) +
    // a region (the field below). The "model" entries just group voices by language.
    value: 'azure_speech',
    label: 'Microsoft Azure (Speech)',
    models: [
      { value: 'arabic', label: 'Arabic (neural)', voices: [
        'ar-AE-FatimaNeural', 'ar-AE-HamdanNeural',   // Emirati (UAE)
        'ar-SA-ZariyahNeural', 'ar-SA-HamedNeural',   // Saudi
        'ar-QA-AmalNeural', 'ar-QA-MoazNeural',       // Qatari
        'ar-KW-NouraNeural', 'ar-KW-FahedNeural',     // Kuwaiti
        'ar-BH-LailaNeural', 'ar-BH-AliNeural',       // Bahraini
        'ar-EG-SalmaNeural', 'ar-EG-ShakirNeural',    // Egyptian
        'ar-JO-SanaNeural', 'ar-JO-TaimNeural',       // Jordanian / Levantine
      ] },
      { value: 'english', label: 'English (neural)', voices: [
        'en-US-AriaNeural', 'en-US-JennyNeural', 'en-US-AvaNeural',
        'en-US-GuyNeural', 'en-US-AndrewNeural', 'en-US-BrianNeural',
        // Extra US voices
        'en-US-DavisNeural', 'en-US-JaneNeural', 'en-US-TonyNeural',
        'en-US-SaraNeural', 'en-US-SteffanNeural',
        'en-GB-SoniaNeural', 'en-GB-LibbyNeural', 'en-GB-RyanNeural',
        // Extra UK voices
        'en-GB-OliviaNeural', 'en-GB-ThomasNeural', 'en-GB-AbbiNeural',
        // Australian English
        'en-AU-NatashaNeural', 'en-AU-WilliamNeural',
        'en-IN-NeerjaNeural', 'en-IN-PrabhatNeural',  // Indian English (common in the UAE)
      ] },
      { value: 'english_hd', label: 'English (HD — most human)', voices: [
        'en-US-Ava:DragonHDLatestNeural', 'en-US-Andrew:DragonHDLatestNeural',
        'en-US-Emma:DragonHDLatestNeural', 'en-US-Brian:DragonHDLatestNeural',
      ] },
      { value: 'hindi', label: 'Hindi (neural)', voices: ['hi-IN-SwaraNeural', 'hi-IN-AnanyaNeural', 'hi-IN-MadhurNeural', 'hi-IN-AaravNeural'] },
      { value: 'malayalam', label: 'Malayalam (neural)', voices: ['ml-IN-SobhanaNeural', 'ml-IN-MidhunNeural'] },
      { value: 'tagalog', label: 'Tagalog / Filipino (neural)', voices: ['fil-PH-BlessicaNeural', 'fil-PH-AngeloNeural'] },
      { value: 'russian', label: 'Russian (neural)', voices: ['ru-RU-SvetlanaNeural', 'ru-RU-DariyaNeural', 'ru-RU-DmitryNeural'] },
    ],
  },
  {
    // ElevenLabs — most expressive multilingual TTS (incl. Arabic). Voices are
    // account/library-specific IDs, so the voice field is a free-text input.
    value: 'elevenlabs',
    label: 'ElevenLabs (multilingual)',
    models: [
      { value: 'eleven_multilingual_v2', label: 'Multilingual v2 — best quality', voices: [] },
      { value: 'eleven_turbo_v2_5', label: 'Turbo v2.5 — fast', voices: [] },
      { value: 'eleven_flash_v2_5', label: 'Flash v2.5 — fastest', voices: [] },
    ],
  },
  {
    // AI/ML API — ElevenLabs voices via aimlapi.com credits (no paid ElevenLabs
    // plan needed). Voices are by name; multilingual (speak Arabic, non-native accent).
    value: 'aimlapi',
    label: 'AI/ML API (ElevenLabs)',
    models: [
      {
        value: 'elevenlabs/eleven_turbo_v2_5',
        label: 'ElevenLabs Turbo v2.5 — multilingual',
        voices: ['Sarah', 'Aria', 'Charlotte', 'Alice', 'Matilda', 'Jessica', 'Grace', 'Lily', 'Serena', 'Nicole', 'Rachel', 'Emily', 'Dorothy', 'Freya', 'Laura', 'George', 'Charlie', 'Liam', 'Daniel', 'Brian', 'Will', 'Chris', 'Eric'],
      },
    ],
  },
  {
    // StreetAI managed: routes TTS through StreetAI's metered audio gateway
    // (StreetAI fronts the cost, billed to your StreetAI wallet). Uses the
    // `streetai` key.
    value: 'streetai',
    label: 'StreetAI (managed)',
    models: [
      { value: 'azure-tts', label: 'Azure neural', voices: ['ar-AE-FatimaNeural', 'ar-AE-HamdanNeural', 'en-US-JennyNeural', 'en-US-AriaNeural'] },
      { value: 'tts-1', label: 'OpenAI', voices: ['alloy', 'nova', 'shimmer', 'echo', 'fable', 'onyx'] },
    ],
  },
];

// Vision providers for the "Vision" card — lets agents read images users send
// (a palm photo, a chat screenshot). Any OpenAI-compatible or Google (Gemini)
// vision model works; the first model listed is the default for that provider.
const VISION_PROVIDERS = [
  {
    value: 'openai',
    label: 'OpenAI',
    models: [
      { value: 'gpt-4o-mini', label: 'GPT-4o mini — fast & cheap (recommended)' },
      { value: 'gpt-4o', label: 'GPT-4o — most capable' },
    ],
  },
  {
    value: 'google',
    label: 'Google (Gemini)',
    models: [
      { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash — fast & cheap' },
      { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro — most capable' },
    ],
  },
];

// Web-search providers for the `web_search` tool. The key is stored in the
// normal credentials store under the provider name (serper / brave), exactly
// like every other API key. Keep in sync with src/engine/tools/web.js.
const WEB_SEARCH_PROVIDERS = [
  { value: 'serper', label: 'Serper (serper.dev — Google results)', keyUrl: 'https://serper.dev' },
  { value: 'brave', label: 'Brave Search API', keyUrl: 'https://brave.com/search/api/' },
];

export default function Settings() {
  const api = useApi();
  const workspace = useContext(WorkspaceContext);
  const themeCtx = useContext(ThemeContext);
  const theme = themeCtx?.theme || 'dark';
  const setTheme = themeCtx?.setTheme || (() => {});
  // Nav mode is per-workspace. In hub mode this hook reads/writes the
  // current workspace's setting via WorkspaceContext; in standalone the
  // workspace context is undefined so it falls back to the synthetic
  // standalone key.
  const { navMode, setNavMode } = useNavMode(workspace);
  const [config, setConfig] = useState(null);
  const [engineStatus, setEngineStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [model, setModel] = useState('');
  const [provider, setProvider] = useState('');
  const [providerModels, setProviderModels] = useState([]);
  const [customModel, setCustomModel] = useState(false);
  const [agentType, setAgentType] = useState('service');
  const [allowAgentChat, setAllowAgentChat] = useState(true);
  const [allowAgentEngagement, setAllowAgentEngagement] = useState(true);
  const [allowHumanEngagement, setAllowHumanEngagement] = useState(true);
  const [saveMsg, setSaveMsg] = useState('');
  const [showRestartNotice, setShowRestartNotice] = useState(false);
  const [restarting, setRestarting] = useState(false);

  // API key form
  const [keyProvider, setKeyProvider] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [azureEndpoint, setAzureEndpoint] = useState('');
  const [ollamaUrl, setOllamaUrl] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [keyMsg, setKeyMsg] = useState('');
  const [removeKeyConfirm, setRemoveKeyConfirm] = useState(null);

  // OAuth form
  const [oauthProvider, setOauthProvider] = useState('');
  const [oauthAuthUrl, setOauthAuthUrl] = useState('');
  const [oauthState, setOauthState] = useState('');
  const [oauthRedirectUrl, setOauthRedirectUrl] = useState('');
  const [oauthMsg, setOauthMsg] = useState('');
  const [oauthStep, setOauthStep] = useState(0); // 0=select, 2=paste
  const [oauthLoading, setOauthLoading] = useState(false);

  const loadConfig = async () => {
    try {
      const [cfg, status] = await Promise.all([
        api.get('/api/config'),
        api.get('/api/engine-status').catch(() => null),
      ]);
      setConfig(cfg);
      setEngineStatus(status);
      setProvider(cfg.provider || '');
      setModel(cfg.model || '');
      setAgentType(cfg.agentType || 'service');
      setAllowAgentChat(cfg.allowAgentChat !== false);
      setAllowAgentEngagement(cfg.allowAgentEngagement !== false);
      setAllowHumanEngagement(cfg.allowHumanEngagement !== false);
      if (cfg.provider) loadModels(cfg.provider, cfg.model);
    } catch { /* ignore */ }
    setLoading(false);
  };

  const loadModels = async (prov, currentModel) => {
    try {
      const models = await api.get(`/api/models/${prov}`);
      setProviderModels(models);
      // If current model isn't in the list, enable custom mode
      if (currentModel && models.length > 0 && !models.some(m => m.value === currentModel)) {
        setCustomModel(true);
      } else {
        setCustomModel(false);
      }
    } catch {
      setProviderModels([]);
    }
  };

  useEffect(() => { loadConfig(); }, []);

  const handleProviderChange = (val) => {
    setProvider(val);
    setModel('');
    setCustomModel(false);
    if (val) loadModels(val);
    else setProviderModels([]);
  };

  const save = async () => {
    setSaving(true);
    setSaveMsg('');
    setShowRestartNotice(false);
    try {
      const providerChanged = provider !== (config?.provider || '');
      const modelChanged = model !== (config?.model || '');
      const agentTypeChanged = agentType !== (config?.agentType || 'service');
      const allowAgentChatChanged = allowAgentChat !== (config?.allowAgentChat !== false);
      const allowAgentEngagementChanged = allowAgentEngagement !== (config?.allowAgentEngagement !== false);
      const allowHumanEngagementChanged = allowHumanEngagement !== (config?.allowHumanEngagement !== false);
      await api.put('/api/config', { provider, model, agentType, allowAgentChat, allowAgentEngagement, allowHumanEngagement });
      const cfg = await api.get('/api/config');
      setConfig(cfg);
      setSaveMsg('Saved!');
      setTimeout(() => setSaveMsg(''), 2500);

      // Provider/model/agent-type are baked into the engine at init, so they only
      // apply after a connector restart — prompt for it, but only if something's
      // actually running to restart.
      if (workspace && (providerChanged || modelChanged || agentTypeChanged || allowAgentChatChanged || allowAgentEngagementChanged || allowHumanEngagementChanged)) {
        try {
          const status = await api.get('/api/deploy/status');
          if (status?.daemonRunning || status?.sessionRunning) {
            setShowRestartNotice(true);
          }
        } catch { /* non-critical */ }
      }
    } catch (err) {
      setSaveMsg('Error: ' + err.message);
    }
    setSaving(false);
  };

  // Restart the running connectors in place (rebuilds the engine with the new
  // provider/model), so the user doesn't have to visit the Deploy page.
  const restartConnectors = async () => {
    setRestarting(true);
    try {
      await api.post('/api/deploy/restart');
      setShowRestartNotice(false);
      setSaveMsg('Connectors restarted — changes applied.');
      setTimeout(() => setSaveMsg(''), 2500);
    } catch (err) {
      setSaveMsg('Error restarting: ' + err.message);
    }
    setRestarting(false);
  };

  const saveKey = async () => {
    if (!keyProvider) return;
    setSavingKey(true);
    setKeyMsg('');
    try {
      const body = { provider: keyProvider };
      if (keyProvider === 'ollama') {
        body.baseUrl = ollamaUrl || 'http://localhost:11434';
      } else if (keyProvider === 'azure') {
        body.apiKey = apiKey;
        body.endpoint = azureEndpoint;
      } else {
        body.apiKey = apiKey;
      }
      await api.post('/api/credentials', body);
      setApiKey('');
      setAzureEndpoint('');
      setOllamaUrl('');
      setKeyMsg('Saved!');
      loadConfig();
    } catch (err) {
      setKeyMsg('Error: ' + err.message);
    }
    setSavingKey(false);
  };

  const removeKey = async (name) => {
    try {
      await api.del(`/api/credentials/${name}`);
      loadConfig();
    } catch (err) {
      alert('Failed: ' + err.message);
    }
  };

  // OAuth flow
  const startOAuth = async () => {
    if (!oauthProvider) return;
    setOauthLoading(true);
    setOauthMsg('');
    try {
      const data = await api.post('/api/oauth/start', { provider: oauthProvider });
      setOauthAuthUrl(data.authUrl);
      setOauthState(data.state);
      setOauthStep(2);
    } catch (err) {
      setOauthMsg('Error: ' + err.message);
    }
    setOauthLoading(false);
  };

  const exchangeOAuth = async () => {
    if (!oauthRedirectUrl || !oauthState) return;
    setOauthLoading(true);
    setOauthMsg('');
    try {
      await api.post('/api/oauth/exchange', { redirectUrl: oauthRedirectUrl, state: oauthState });
      setOauthMsg('Connected!');
      setOauthStep(0);
      setOauthRedirectUrl('');
      setOauthAuthUrl('');
      setOauthState('');
      loadConfig();
    } catch (err) {
      setOauthMsg('Error: ' + err.message);
    }
    setOauthLoading(false);
  };

  if (loading) return <div className="page-loading">Loading...</div>;

  return (
    <div>
      <div className="page-header">
        <h1>Settings</h1>
        <p className="page-subtitle">LLM provider configuration and engine status</p>
      </div>

      <div className="settings-grid">
        {/* Agent Type */}
        <div className="card">
          <div className="card-header">Agent Type</div>
          <div className="card-body">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {[
                {
                  value: 'service',
                  icon: (
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="7" width="20" height="14" rx="2" />
                      <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
                    </svg>
                  ),
                  title: 'Service Agent',
                  desc: 'Provides paid services via escrow. Compact skill for messaging and transactions.',
                },
                {
                  value: 'social',
                  icon: (
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="9" cy="7" r="4" />
                      <path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2" />
                      <circle cx="17" cy="7" r="3" />
                      <path d="M21 21v-2a4 4 0 0 0-3-3.87" />
                    </svg>
                  ),
                  title: 'Social Agent',
                  desc: 'Participates in social platforms built for AI agents.',
                },
              ].map(opt => {
                const active = agentType === opt.value;
                return (
                  <div
                    key={opt.value}
                    onClick={() => setAgentType(opt.value)}
                    style={{
                      padding: 14,
                      borderRadius: 10,
                      border: active ? '2px solid var(--accent)' : '1px solid var(--border)',
                      background: active ? 'var(--accent-bg, rgba(99,102,241,0.08))' : 'transparent',
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                      position: 'relative',
                    }}
                  >
                    <div style={{ marginBottom: 8, color: active ? 'var(--accent)' : 'var(--text-muted)' }}>{opt.icon}</div>
                    <div style={{ fontWeight: 600, marginBottom: 4, color: active ? 'var(--accent)' : 'var(--text)' }}>
                      {opt.title}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.4 }}>
                      {opt.desc}
                    </div>
                    {active && (
                      <div style={{
                        position: 'absolute', top: 8, right: 8,
                        width: 18, height: 18, borderRadius: '50%',
                        background: 'var(--accent)', color: '#fff',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 11, fontWeight: 700,
                      }}>✓</div>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="form-hint" style={{ marginTop: 10 }}>
              Click Save in the Active Provider card to apply changes.
            </p>
          </div>
        </div>

        {/* Active Provider */}
        <div className="card">
          <div className="card-header">Active Provider</div>
          <div className="card-body">
            <div className="form-group">
              <label>Provider</label>
              <select value={provider} onChange={e => handleProviderChange(e.target.value)} className="form-select">
                <option value="">Select...</option>
                {PROVIDERS.map(p => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label>Model</label>
              {providerModels.length > 0 && !customModel ? (
                <div>
                  <select
                    value={model}
                    onChange={e => setModel(e.target.value)}
                    className="form-select"
                  >
                    <option value="">Select model...</option>
                    {providerModels.map(m => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                  <button className="btn-link" onClick={() => setCustomModel(true)}>
                    Use custom model ID
                  </button>
                </div>
              ) : (
                <div>
                  <input
                    type="text"
                    value={model}
                    onChange={e => setModel(e.target.value)}
                    className="form-input"
                    placeholder="e.g., claude-sonnet-4-20250514"
                  />
                  {providerModels.length > 0 && (
                    <button className="btn-link" onClick={() => { setCustomModel(false); setModel(''); }}>
                      Choose from list
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className="form-group">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={allowAgentChat}
                  onChange={e => setAllowAgentChat(e.target.checked)}
                />
                Allow direct messages from other AI agents
              </label>
              <p className="form-hint" style={{ marginTop: 4 }}>
                Ignore DMs from other AI agents when off.
              </p>
            </div>
            <div className="form-group">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={allowAgentEngagement}
                  onChange={e => setAllowAgentEngagement(e.target.checked)}
                />
                Respond to other AI agents' comments, mentions, and reactions
              </label>
              <p className="form-hint" style={{ marginTop: 4 }}>
                Ignore other agents' comments, mentions, and reactions when off.
              </p>
            </div>
            <div className="form-group">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={allowHumanEngagement}
                  onChange={e => setAllowHumanEngagement(e.target.checked)}
                />
                Engage with people's activity (new followers, comments, mentions, reactions)
              </label>
              <p className="form-hint" style={{ marginTop: 4 }}>
                Off = reactive only: the agent stops reaching out on people's activity (e.g. welcoming every new follower) but still answers anyone who messages it. Good for service agents.
              </p>
            </div>
            <button className="btn btn-primary" onClick={save} disabled={saving || !provider || !model}>
              {saving ? 'Saving...' : 'Save'}
            </button>
            {saveMsg && (
              <p className="form-hint" style={{ marginTop: 8, color: saveMsg.startsWith('Error') ? 'var(--text-error)' : 'var(--green)' }}>
                {saveMsg}
              </p>
            )}
            {showRestartNotice && (
              <div className="deploy-banner" style={{ marginTop: 12, marginBottom: 0, justifyContent: 'space-between' }}>
                <span>Your running connectors are still using the previous provider/model. Restart them to apply the change.</span>
                <button className="btn btn-sm" onClick={restartConnectors} disabled={restarting}>
                  {restarting ? 'Restarting…' : 'Restart connectors'}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* API Key Setup */}
        <div className="card">
          <div className="card-header">Add API Key</div>
          <div className="card-body">
            <div className="form-group">
              <label>Provider</label>
              <select value={keyProvider} onChange={e => { setKeyProvider(e.target.value); setKeyMsg(''); }} className="form-select">
                <option value="">Select provider...</option>
                {PROVIDERS.map(p => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>

            {keyProvider && keyProvider !== 'ollama' && (
              <div className="form-group">
                <label>API Key</label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                  className="form-input"
                  placeholder="sk-..."
                />
              </div>
            )}

            {keyProvider === 'azure' && (
              <div className="form-group">
                <label>Azure Endpoint</label>
                <input
                  type="text"
                  value={azureEndpoint}
                  onChange={e => setAzureEndpoint(e.target.value)}
                  className="form-input"
                  placeholder="https://your-resource.openai.azure.com"
                />
              </div>
            )}

            {keyProvider === 'ollama' && (
              <div className="form-group">
                <label>Ollama URL</label>
                <input
                  type="text"
                  value={ollamaUrl}
                  onChange={e => setOllamaUrl(e.target.value)}
                  className="form-input"
                  placeholder="http://localhost:11434"
                />
              </div>
            )}

            {keyProvider && (
              <button className="btn btn-primary" onClick={saveKey} disabled={savingKey}>
                {savingKey ? 'Saving...' : 'Save Key'}
              </button>
            )}
            {keyMsg && <p className="form-hint" style={{ color: keyMsg.startsWith('Error') ? 'var(--text-error)' : 'var(--green)' }}>{keyMsg}</p>}
            <p className="form-hint">Keys are stored in <code>~/.aaas/credentials.json</code>. Environment variables take priority.</p>
          </div>
        </div>

        {/* OAuth Connection */}
        <div className="card">
          <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>Connect via OAuth</span>
            <span className="badge" style={{ background: 'var(--bg-secondary)', color: 'var(--text-muted)', fontSize: 11, padding: '2px 8px', borderRadius: 10 }}>Coming soon</span>
          </div>
          <div className="card-body">
            <p className="form-hint" style={{ margin: 0 }}>
              This option will be available in a future update. For now, please use an API key in the LLM Provider card above.
            </p>
          </div>
        </div>

        {/* Engine Status */}
        <div className="card">
          <div className="card-header">Engine Status</div>
          <div className="card-body">
            {engineStatus?.initialized ? (
              <div className="status-list">
                <div className="status-item">
                  <span className="status-dot status-dot-green" />
                  <span>Engine running</span>
                </div>
                <div className="status-item">
                  <span className="status-label">Agent</span>
                  <span>{engineStatus.agentName}</span>
                </div>
                <div className="status-item">
                  <span className="status-label">Provider</span>
                  <span>{engineStatus.provider} / {engineStatus.model}</span>
                </div>
                <div className="status-item">
                  <span className="status-label">Sessions</span>
                  <span>{engineStatus.sessionsActive}</span>
                </div>
                <div className="status-item">
                  <span className="status-label">Memory facts</span>
                  <span>{engineStatus.factsCount}</span>
                </div>
                <div className="status-item">
                  <span className="status-label">Tools</span>
                  <span>{engineStatus.toolsAvailable}</span>
                </div>
              </div>
            ) : (
              <div className="status-list">
                <div className="status-item">
                  <span className="status-dot status-dot-gray" />
                  <span>Engine not started</span>
                </div>
                {engineStatus?.error && (
                  <p className="form-hint" style={{ color: 'var(--text-error)' }}>{engineStatus.error}</p>
                )}
                <p className="form-hint">The engine starts when you send a chat message or run <code>aaas run</code></p>
              </div>
            )}
          </div>
        </div>

        {/* Configured Providers */}
        {config?.configuredProviders?.length > 0 && (
          <div className="card">
            <div className="card-header">Configured Providers</div>
            <div className="card-body">
              <div className="status-list">
                {config.configuredProviders.map(p => (
                  <div key={p.name} className="status-item">
                    <span className="status-dot status-dot-green" />
                    <span className="status-label">{p.name}</span>
                    <span className="mono">{p.keyPreview || 'no key'}</span>
                    <span className="badge badge-muted">{p.source}</span>
                    <button className="btn-icon" onClick={() => setRemoveKeyConfirm(p.name)} title="Remove">✕</button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Appearance */}
        <div className="card">
          <div className="card-header">Appearance</div>
          <div className="card-body">
            <div className="form-group">
              <label>Theme</label>
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button
                  className={`btn ${theme === 'dark' ? 'btn-primary' : ''}`}
                  onClick={() => setTheme('dark')}
                  style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M12.5 7.5a5.5 5.5 0 01-6-6 5.5 5.5 0 106 6z" />
                  </svg>
                  Dark
                </button>
                <button
                  className={`btn ${theme === 'light' ? 'btn-primary' : ''}`}
                  onClick={() => setTheme('light')}
                  style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <circle cx="7" cy="7" r="3" />
                    <path d="M7 1v1.5M7 11.5V13M1 7h1.5M11.5 7H13M2.75 2.75l1.06 1.06M10.19 10.19l1.06 1.06M11.25 2.75l-1.06 1.06M3.81 10.19l-1.06 1.06" />
                  </svg>
                  Light
                </button>
              </div>
            </div>
            <p className="form-hint">Choose your preferred dashboard appearance. Your preference is saved locally.</p>
          </div>
        </div>

        {/* Voice messages */}
        <VoiceMessagesCard
          config={config}
          api={api}
          configuredProviders={config?.configuredProviders || []}
          onSaved={loadConfig}
        />

        {/* Vision — let agents read images users send */}
        <VisionCard
          config={config}
          api={api}
          configuredProviders={config?.configuredProviders || []}
          onSaved={loadConfig}
        />

        <WebSearchCard
          config={config}
          api={api}
          configuredProviders={config?.configuredProviders || []}
          onSaved={loadConfig}
        />

        <PhoneNumberCard config={config} api={api} onSaved={loadConfig} />

        <OutboundCallingCard config={config} api={api} onSaved={loadConfig} />

        {/* Storage cleanup */}
        <StorageCleanupCard />

        {/* Diagnostics — locate & send the error log */}
        <DiagnosticsCard />

        {/* Navigation — per-workspace setting, hidden at hub root since
            the hub sidebar uses its own nav config (not workspaceNav). */}
        {workspace && (
        <div className="card">
          <div className="card-header">Navigation</div>
          <div className="card-body">
            <div className="form-group">
              <label>Sidebar layout</label>
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button
                  className={`btn ${navMode === 'admin' ? 'btn-primary' : ''}`}
                  onClick={() => setNavMode('admin')}
                  style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="1.5" y="2" width="11" height="2" rx="0.5" />
                    <rect x="1.5" y="6" width="11" height="2" rx="0.5" />
                    <rect x="1.5" y="10" width="11" height="2" rx="0.5" />
                  </svg>
                  Admin
                </button>
                <button
                  className={`btn ${navMode === 'basic' ? 'btn-primary' : ''}`}
                  onClick={() => setNavMode('basic')}
                  style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="3" cy="3.5" r="1.2" />
                    <line x1="6" y1="3.5" x2="12" y2="3.5" />
                    <circle cx="3" cy="7" r="1.2" />
                    <line x1="6" y1="7" x2="12" y2="7" />
                    <circle cx="3" cy="10.5" r="1.2" />
                    <line x1="6" y1="10.5" x2="12" y2="10.5" />
                  </svg>
                  Basic
                </button>
              </div>
            </div>
            <p className="form-hint">
              <strong>Admin</strong> shows the full sidebar with all sections. <strong>Basic</strong> hides technical pages (Skill, Soul, Data, Memory, Extensions, Deploy) for day-to-day use — switch back to Admin here when needed.
            </p>
          </div>
        </div>
        )}
      </div>

      {removeKeyConfirm && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setRemoveKeyConfirm(null)}>
          <div className="card" style={{ maxWidth: 420, width: '90%' }} onClick={(e) => e.stopPropagation()}>
            <div className="card-header">Remove credentials?</div>
            <div className="card-body">
              <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--text)' }}>
                Remove <strong>{removeKeyConfirm}</strong> credentials? This cannot be undone.
              </p>
              <div className="form-actions" style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-danger" onClick={() => { removeKey(removeKeyConfirm); setRemoveKeyConfirm(null); }}>Remove</button>
                <button className="btn" onClick={() => setRemoveKeyConfirm(null)}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * "Voice messages" card. Self-contained setup for inbound voice-note
 * transcription: enable it, pick the service + model, and — if no key exists
 * for that service yet — paste the API key right here. The key is saved to the
 * shared credentials store (same place LLM keys live), so it's never a
 * voice-only duplicate; a key already configured for the LLM is reused.
 */
function VoiceMessagesCard({ config, api, configuredProviders, onSaved }) {
  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState('groq');
  const [model, setModel] = useState('');
  const [segmentation, setSegmentation] = useState('semantic'); // Azure turn detection (live Voice Call)
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  // Web Call (spoken replies via TTS).
  const [webcallEnabled, setWebcallEnabled] = useState(false);
  const [ttsProvider, setTtsProvider] = useState('groq');
  const [ttsModel, setTtsModel] = useState('');
  const [ttsVoice, setTtsVoice] = useState('');
  const [ttsRegion, setTtsRegion] = useState(''); // Azure region (e.g. "uaenorth")
  const [ttsRate, setTtsRate] = useState('');     // Azure SSML rate (e.g. "+6%")
  const [ttsPitch, setTtsPitch] = useState('');   // Azure SSML pitch (e.g. "+3%")
  const [ttsPerLang, setTtsPerLang] = useState(false); // match voice to caller's language (mono-lingual providers)
  const [ttsStyle, setTtsStyle] = useState('customerservice'); // Azure express-as speaking style (style-capable voices)

  // Inline API key entry (only shown when the chosen provider has no key).
  const [apiKey, setApiKey] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [keyMsg, setKeyMsg] = useState('');

  const selected = VOICE_PROVIDERS.find(p => p.value === provider) || VOICE_PROVIDERS[0];
  const models = selected?.models || [];
  const defaultModel = models[0]?.value || '';

  useEffect(() => {
    const v = config?.voice || {};
    setEnabled(!!v.enabled);
    const prov = v.provider || 'groq';
    setProvider(prov);
    const provModels = (VOICE_PROVIDERS.find(p => p.value === prov)?.models) || [];
    setModel(v.model || provModels[0]?.value || '');
    setSegmentation(v.segmentation || 'semantic');

    const t = v.tts || {};
    setWebcallEnabled(!!v.webcall_enabled);
    const tProv = t.provider || 'groq';
    setTtsProvider(tProv);
    const tModels = (TTS_PROVIDERS.find(p => p.value === tProv)?.models) || [];
    const tModel = t.model || tModels[0]?.value || '';
    setTtsModel(tModel);
    const tVoices = (tModels.find(m => m.value === tModel)?.voices) || [];
    setTtsVoice(t.voice || tVoices[0] || '');
    setTtsRegion(t.region || '');
    setTtsRate(t.rate || '');
    setTtsPitch(t.pitch || '');
    setTtsPerLang(!!t.perLanguage);
    setTtsStyle(t.style || 'customerservice');
  }, [config]);

  const changeTtsProvider = (val) => {
    setTtsProvider(val);
    const tModels = (TTS_PROVIDERS.find(p => p.value === val)?.models) || [];
    const m = tModels[0]?.value || '';
    setTtsModel(m);
    setTtsVoice((tModels[0]?.voices || [])[0] || '');
  };
  const changeTtsModel = (val) => {
    setTtsModel(val);
    const tModels = (TTS_PROVIDERS.find(p => p.value === ttsProvider)?.models) || [];
    setTtsVoice((tModels.find(m => m.value === val)?.voices || [])[0] || '');
  };
  const ttsModels = (TTS_PROVIDERS.find(p => p.value === ttsProvider)?.models) || [];
  const ttsVoices = (ttsModels.find(m => m.value === ttsModel)?.voices) || [];

  const changeProvider = (val) => {
    setProvider(val);
    const provModels = (VOICE_PROVIDERS.find(p => p.value === val)?.models) || [];
    setModel(provModels[0]?.value || '');
    setApiKey('');
    setKeyMsg('');
  };

  const hasKey = configuredProviders.some(p => p.name === provider);

  const saveKey = async () => {
    if (!apiKey.trim()) return;
    setSavingKey(true); setKeyMsg('');
    try {
      await api.post('/api/credentials', { provider, apiKey: apiKey.trim() });
      setApiKey('');
      setKeyMsg('Key saved!');
      onSaved?.();  // reload config → configuredProviders refreshes → field hides
    } catch (e) {
      setKeyMsg('Error: ' + e.message);
    }
    setSavingKey(false);
  };

  const save = async () => {
    setSaving(true); setMsg(''); setKeyMsg('');
    try {
      // If the user typed a key but didn't click "Save key", persist it as
      // part of this Save so a single click does everything.
      if (enabled && !hasKey && apiKey.trim()) {
        await api.post('/api/credentials', { provider, apiKey: apiKey.trim() });
        setApiKey('');
      }
      await api.put('/api/config', {
        voice: {
          enabled, provider, model: model || defaultModel,
          segmentation,
          webcall_enabled: webcallEnabled,
          // Preserve an optional second-language (e.g. English) fallback voice
          // configured outside this form, so saving the main voice doesn't wipe it.
          tts: {
            provider: ttsProvider, model: ttsModel, voice: ttsVoice,
            ...(ttsRegion ? { region: ttsRegion } : {}),
            ...(ttsRate ? { rate: ttsRate } : {}),
            ...(ttsPitch ? { pitch: ttsPitch } : {}),
            // Only meaningful for mono-lingual providers; omitted (false) otherwise.
            ...(PER_LANGUAGE_TTS_PROVIDERS.includes(ttsProvider) && ttsPerLang ? { perLanguage: true } : {}),
            // Speaking style only for style-capable voices; omitted otherwise.
            ...(STYLE_CAPABLE_VOICES.includes(ttsVoice) && ttsStyle ? { style: ttsStyle } : {}),
            ...(config?.voice?.tts?.en ? { en: config.voice.tts.en } : {}),
          },
          // Preserve the outbound-calling settings (owned by the Outbound card),
          // so saving voice here doesn't wipe them (config merges shallowly).
          ...(config?.voice?.outbound ? { outbound: config.voice.outbound } : {}),
        },
      });
      setMsg('Saved!');
      onSaved?.();
      setTimeout(() => setMsg(''), 2500);
    } catch (e) {
      setMsg('Error: ' + e.message);
    }
    setSaving(false);
  };

  return (
    <div className="card">
      <div className="card-header">Voice messages</div>
      <div className="card-body">
        <p className="form-hint" style={{ marginTop: 0 }}>
          Let customers send voice notes on WhatsApp and Telegram. When on, each
          voice note is turned into text so your agent can understand and reply.
          The language is detected automatically.
        </p>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 12 }}>
          <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
          <span>Understand customer voice notes</span>
        </label>

        {enabled && (
          <>
            <div className="form-group">
              <label>Transcription service</label>
              <select className="form-select" value={provider} onChange={e => changeProvider(e.target.value)}>
                {VOICE_PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>

            <div className="form-group">
              <label>Model</label>
              <select className="form-select" value={model} onChange={e => setModel(e.target.value)}>
                {models.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>

            {provider === 'azure_speech' && (
              <div className="form-group">
                <label>Turn detection</label>
                <select className="form-select" value={segmentation} onChange={e => setSegmentation(e.target.value)}>
                  <option value="semantic">Semantic — AI decides when the caller finished (recommended)</option>
                  <option value="default">Silence timeout — finish after a pause</option>
                </select>
                <p className="form-hint">
                  For the live <strong>Voice Call</strong> connector. “Semantic” lets Azure judge from the content when the
                  caller has finished speaking, instead of waiting for a fixed silence. Azure Speech only — other STT
                  providers always use the silence/pause method.
                </p>
              </div>
            )}

            {hasKey ? (
              <p className="form-hint" style={{ color: 'var(--green)' }}>
                ✓ API key for “{provider}” is configured. Manage or remove it in the <strong>Configured Providers</strong> card above.
              </p>
            ) : (
              <div className="form-group">
                <label>{selected?.label} API key</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="password"
                    className="form-input"
                    value={apiKey}
                    onChange={e => setApiKey(e.target.value)}
                    placeholder="Paste your API key"
                    style={{ flex: 1 }}
                  />
                  <button className="btn" onClick={saveKey} disabled={savingKey || !apiKey.trim()}>
                    {savingKey ? 'Saving…' : 'Save key'}
                  </button>
                </div>
                {keyMsg && (
                  <p className="form-hint" style={{ marginTop: 6, color: keyMsg.startsWith('Error') ? 'var(--text-error)' : 'var(--green)' }}>
                    {keyMsg}
                  </p>
                )}
              </div>
            )}
          </>
        )}

        <div style={{ borderTop: '1px solid var(--border)', margin: '16px 0' }} />

        <p className="form-hint" style={{ marginTop: 0 }}>
          <strong>Voice Call</strong> — let callers talk to your agent by voice (website, app,
          or any client). Turn this on so the agent replies out loud in the voice you pick
          below. Pair it with the <strong>Voice Call</strong> card in the Deploy tab.
        </p>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 12 }}>
          <input type="checkbox" checked={webcallEnabled} onChange={e => setWebcallEnabled(e.target.checked)} />
          <span>Reply to customers out loud</span>
        </label>

        {webcallEnabled && (
          <>
            <div className="form-group">
              <label>Voice service</label>
              <select className="form-select" value={ttsProvider} onChange={e => changeTtsProvider(e.target.value)}>
                {TTS_PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>Voice model</label>
              <select className="form-select" value={ttsModel} onChange={e => changeTtsModel(e.target.value)}>
                {ttsModels.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>Voice</label>
              {ttsProvider === 'elevenlabs' ? (
                <input className="form-input" value={ttsVoice} onChange={e => setTtsVoice(e.target.value)} placeholder="ElevenLabs voice ID (from your Voice Library)" />
              ) : (
                <select className="form-select" value={ttsVoice} onChange={e => setTtsVoice(e.target.value)}>
                  {ttsVoices.map(v => <option key={v} value={v}>{v}</option>)}
                </select>
              )}
            </div>
            {ttsProvider === 'azure_speech' && (
              <>
                <div className="form-group">
                  <label>Azure region</label>
                  <input className="form-input" value={ttsRegion} onChange={e => setTtsRegion(e.target.value)} placeholder="e.g. uaenorth" />
                  <p className="form-hint">The region of your Azure Speech resource (e.g. <code>uaenorth</code>, <code>eastus</code>). Add the Azure key under <strong>Configured Providers</strong> above.</p>
                </div>
                <div className="form-group" style={{ display: 'flex', gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <label>Speed</label>
                    <input className="form-input" value={ttsRate} onChange={e => setTtsRate(e.target.value)} placeholder="e.g. +6%" />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label>Pitch</label>
                    <input className="form-input" value={ttsPitch} onChange={e => setTtsPitch(e.target.value)} placeholder="e.g. +3%" />
                  </div>
                </div>
                <p className="form-hint">Tune how the voice sounds. Use a signed percent like <code>+6%</code> / <code>-5%</code>. A slightly higher speed and pitch usually sounds livelier and less robotic; leave blank for a mild default. (Listen, adjust, save — applies to new calls right away.)</p>
                {STYLE_CAPABLE_VOICES.includes(ttsVoice) && (
                  <div className="form-group">
                    <label>Tone</label>
                    <select className="form-select" value={ttsStyle} onChange={e => setTtsStyle(e.target.value)}>
                      {TTS_STYLE_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <p className="form-hint">A speaking style for a warmer, less robotic delivery. Available on select English voices (Aria, Jenny). Arabic and most other voices don't support styles, so this only shows for voices that do.</p>
                  </div>
                )}
                {ttsModel === 'english_hd' && (
                  <p className="form-hint">HD voices are the most human-sounding, but they need an Azure region that supports them. If you hear nothing on a test call, pick a standard voice instead.</p>
                )}
              </>
            )}
            {PER_LANGUAGE_TTS_PROVIDERS.includes(ttsProvider) && (
              <div className="form-group">
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={ttsPerLang} onChange={e => setTtsPerLang(e.target.checked)} />
                  <span>Match voice to the caller's language</span>
                </label>
                <p className="form-hint">
                  When on, the agent replies with a native voice of the <strong>same gender</strong> as the
                  one above for each language it detects (Arabic, English, Hindi, Malayalam, Tagalog,
                  Russian), instead of speaking every language with a single voice. Recommended when you
                  serve multiple languages. The voice above is used as the default for anything unmapped.
                </p>
              </div>
            )}
            <p className="form-hint">
              {ttsProvider === 'groq'
                ? "Uses the same API key as transcription above. Groq's Orpheus voices need a one-time terms acceptance in the Groq console before they work."
                : ttsProvider === 'azure_speech'
                  ? 'Azure neural voices support locale-specific accents (e.g. ar-AE Emirati) and longer replies. Needs an Azure key + region.'
                  : ttsProvider === 'elevenlabs'
                    ? 'ElevenLabs is the most expressive option and speaks Arabic via the multilingual model. For a native accent, add an Arabic voice from the ElevenLabs Voice Library and paste its voice ID above. Needs an ElevenLabs API key.'
                    : ttsProvider === 'aimlapi'
                      ? 'ElevenLabs voices billed against your AI/ML API (aimlapi.com) credits — no paid ElevenLabs plan needed. Voices are multilingual (they speak Arabic with a non-native accent). Needs an AI/ML API key.'
                      : 'Uses the API key configured for this provider.'}
            </p>
          </>
        )}

        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {msg && (
          <p className="form-hint" style={{ marginTop: 8, color: msg.startsWith('Error') ? 'var(--text-error)' : 'var(--green)' }}>
            {msg}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * "Vision" card. Lets an agent read images customers send (a photo, a
 * screenshot). Pick the vision service + model, and — if no key exists for that
 * provider yet — paste it right here. Saves to config.vision; the key goes to
 * the shared credentials store (same place LLM keys live), so a key already
 * configured for another use is reused. Read live by the read_image tool — no
 * restart needed.
 */
function VisionCard({ config, api, configuredProviders, onSaved }) {
  const [enabled, setEnabled] = useState(true);
  const [provider, setProvider] = useState('openai');
  const [model, setModel] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [keyMsg, setKeyMsg] = useState('');

  const selected = VISION_PROVIDERS.find(p => p.value === provider) || VISION_PROVIDERS[0];
  const models = selected?.models || [];
  const defaultModel = models[0]?.value || '';

  useEffect(() => {
    const v = config?.vision || {};
    // Default ON unless explicitly turned off — the tool degrades gracefully
    // when no key is present anyway.
    setEnabled(v.enabled !== false);
    const prov = v.provider || 'openai';
    setProvider(prov);
    const provModels = (VISION_PROVIDERS.find(p => p.value === prov)?.models) || [];
    setModel(v.model || provModels[0]?.value || '');
    setApiKey('');
    setKeyMsg('');
  }, [config]);

  const changeProvider = (val) => {
    setProvider(val);
    const provModels = (VISION_PROVIDERS.find(p => p.value === val)?.models) || [];
    setModel(provModels[0]?.value || '');
    setApiKey('');
    setKeyMsg('');
  };

  const hasKey = configuredProviders.some(p => p.name === provider);

  const saveKey = async () => {
    if (!apiKey.trim()) return;
    setSavingKey(true); setKeyMsg('');
    try {
      await api.post('/api/credentials', { provider, apiKey: apiKey.trim() });
      setApiKey('');
      setKeyMsg('Key saved!');
      onSaved?.();
    } catch (e) {
      setKeyMsg('Error: ' + e.message);
    }
    setSavingKey(false);
  };

  const save = async () => {
    setSaving(true); setMsg(''); setKeyMsg('');
    try {
      // If a key was typed but not separately saved, persist it with this Save.
      if (enabled && !hasKey && apiKey.trim()) {
        await api.post('/api/credentials', { provider, apiKey: apiKey.trim() });
        setApiKey('');
      }
      await api.put('/api/config', {
        vision: { enabled, provider, model: model || defaultModel },
      });
      setMsg('Saved!');
      onSaved?.();
      setTimeout(() => setMsg(''), 2500);
    } catch (e) {
      setMsg('Error: ' + e.message);
    }
    setSaving(false);
  };

  return (
    <div className="card">
      <div className="card-header">Vision (image understanding)</div>
      <div className="card-body">
        <p className="form-hint" style={{ marginTop: 0 }}>
          Let your agent read images customers send — a photo, a screenshot — and
          describe or transcribe them. Uses a vision model on demand (a few cents
          per image). When off or unconfigured, the agent simply can't see images
          and falls back gracefully.
        </p>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 12 }}>
          <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
          <span>Let this agent read images</span>
        </label>

        {enabled && (
          <>
            <div className="form-group">
              <label>Vision service</label>
              <select className="form-select" value={provider} onChange={e => changeProvider(e.target.value)}>
                {VISION_PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>Model</label>
              <select className="form-select" value={model} onChange={e => setModel(e.target.value)}>
                {models.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>

            {hasKey ? (
              <p className="form-hint" style={{ color: 'var(--green)' }}>
                ✓ API key for “{provider}” is configured. Manage it in the <strong>Configured Providers</strong> card above.
              </p>
            ) : (
              <div className="form-group">
                <label>{selected?.label} API key</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="password"
                    className="form-input"
                    value={apiKey}
                    onChange={e => setApiKey(e.target.value)}
                    placeholder="Paste your API key"
                    style={{ flex: 1 }}
                  />
                  <button className="btn" onClick={saveKey} disabled={savingKey || !apiKey.trim()}>
                    {savingKey ? 'Saving…' : 'Save key'}
                  </button>
                </div>
                {keyMsg && (
                  <p className="form-hint" style={{ marginTop: 6, color: keyMsg.startsWith('Error') ? 'var(--text-error)' : 'var(--green)' }}>
                    {keyMsg}
                  </p>
                )}
              </div>
            )}
          </>
        )}

        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {msg && (
          <p className="form-hint" style={{ marginTop: 8, color: msg.startsWith('Error') ? 'var(--text-error)' : 'var(--green)' }}>
            {msg}
          </p>
        )}
      </div>
    </div>
  );
}

function WebSearchCard({ config, api, configuredProviders, onSaved }) {
  const [provider, setProvider] = useState('serper');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [keyMsg, setKeyMsg] = useState('');

  const selected = WEB_SEARCH_PROVIDERS.find(p => p.value === provider) || WEB_SEARCH_PROVIDERS[0];

  useEffect(() => {
    const w = config?.web_search || {};
    setProvider(w.provider || 'serper');
    setApiKey('');
    setKeyMsg('');
  }, [config]);

  const changeProvider = (val) => {
    setProvider(val);
    setApiKey('');
    setKeyMsg('');
  };

  const hasKey = configuredProviders.some(p => p.name === provider);

  const saveKey = async () => {
    if (!apiKey.trim()) return;
    setSavingKey(true); setKeyMsg('');
    try {
      await api.post('/api/credentials', { provider, apiKey: apiKey.trim() });
      setApiKey('');
      setKeyMsg('Key saved!');
      onSaved?.();
    } catch (e) {
      setKeyMsg('Error: ' + e.message);
    }
    setSavingKey(false);
  };

  const save = async () => {
    setSaving(true); setMsg(''); setKeyMsg('');
    try {
      // If a key was typed but not separately saved, persist it with this Save.
      if (!hasKey && apiKey.trim()) {
        await api.post('/api/credentials', { provider, apiKey: apiKey.trim() });
        setApiKey('');
      }
      await api.put('/api/config', { web_search: { provider } });
      setMsg('Saved!');
      onSaved?.();
      setTimeout(() => setMsg(''), 2500);
    } catch (e) {
      setMsg('Error: ' + e.message);
    }
    setSaving(false);
  };

  return (
    <div className="card">
      <div className="card-header">Web search</div>
      <div className="card-body">
        <p className="form-hint" style={{ marginTop: 0 }}>
          Let your agent search the open web (the <code>web_search</code> tool). Pick a
          search provider and add its API key. When unconfigured, web search simply
          returns an error and the agent carries on without it.
        </p>

        <div className="form-group">
          <label>Search provider</label>
          <select className="form-select" value={provider} onChange={e => changeProvider(e.target.value)}>
            {WEB_SEARCH_PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </div>

        {hasKey ? (
          <p className="form-hint" style={{ color: 'var(--green)' }}>
            ✓ API key for “{provider}” is configured. Manage it in the <strong>Configured Providers</strong> card above.
          </p>
        ) : (
          <div className="form-group">
            <label>{selected?.label} API key</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="password"
                className="form-input"
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder="Paste your API key"
                style={{ flex: 1 }}
              />
              <button className="btn" onClick={saveKey} disabled={savingKey || !apiKey.trim()}>
                {savingKey ? 'Saving…' : 'Save key'}
              </button>
            </div>
            {selected?.keyUrl && (
              <p className="form-hint" style={{ marginTop: 6 }}>
                Get a key at <a href={selected.keyUrl} target="_blank" rel="noreferrer">{selected.keyUrl}</a>.
              </p>
            )}
            {keyMsg && (
              <p className="form-hint" style={{ marginTop: 6, color: keyMsg.startsWith('Error') ? 'var(--text-error)' : 'var(--green)' }}>
                {keyMsg}
              </p>
            )}
          </div>
        )}

        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {msg && (
          <p className="form-hint" style={{ marginTop: 8, color: msg.startsWith('Error') ? 'var(--text-error)' : 'var(--green)' }}>
            {msg}
          </p>
        )}
      </div>
    </div>
  );
}

function PhoneNumberCard({ config, api, onSaved }) {
  const [number, setNumber] = useState('');
  const [useInbound, setUseInbound] = useState(true);
  const [useOutbound, setUseOutbound] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    const p = config?.phone;
    // Back-compat: an older config may store phone as a plain string.
    if (typeof p === 'string') { setNumber(p); setUseInbound(true); setUseOutbound(true); }
    else { setNumber(p?.number || ''); setUseInbound(p?.inbound !== false); setUseOutbound(p?.outbound !== false); }
    setMsg('');
  }, [config]);

  const save = async () => {
    setSaving(true); setMsg('');
    try {
      await api.put('/api/config', {
        phone: { number: number.trim(), inbound: useInbound, outbound: useOutbound },
      });
      setMsg('Saved. Restart connectors to apply it.');
      onSaved?.();
      setTimeout(() => setMsg(''), 4000);
    } catch (e) {
      setMsg('Error: ' + e.message);
    }
    setSaving(false);
  };

  return (
    <div className="card">
      <div className="card-header">Phone number</div>
      <div className="card-body">
        <p className="form-hint" style={{ marginTop: 0 }}>
          A phone number for this agent. Choose what it's used for below. The number must
          already be provisioned with your telephony provider (e.g. Telnyx) and pointed at
          the server; this just tells StreetAI which agent it belongs to.
        </p>
        <div className="form-group">
          <label>Number (international format)</label>
          <input
            type="text"
            className="form-input"
            value={number}
            onChange={e => setNumber(e.target.value)}
            placeholder="+14155551212"
          />
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 8 }}>
          <input type="checkbox" checked={useInbound} onChange={e => setUseInbound(e.target.checked)} />
          <span>Use for incoming calls (this agent answers calls to this number)</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 12 }}>
          <input type="checkbox" checked={useOutbound} onChange={e => setUseOutbound(e.target.checked)} />
          <span>Use for outgoing calls (shown as caller ID when this agent calls out)</span>
        </label>

        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {msg && (
          <p className="form-hint" style={{ marginTop: 8, color: msg.startsWith('Error') ? 'var(--text-error)' : 'var(--green)' }}>
            {msg}
          </p>
        )}
      </div>
    </div>
  );
}

function OutboundCallingCard({ config, api, onSaved }) {
  const [enabled, setEnabled] = useState(false);
  const [allowIntl, setAllowIntl] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    const o = config?.voice?.outbound || {};
    setEnabled(o.enabled === true);
    setAllowIntl(o.denyInternational === false);
    setMsg('');
  }, [config]);

  const save = async () => {
    setSaving(true); setMsg('');
    try {
      await api.put('/api/config', {
        // Spread the existing voice object so we only touch `outbound` and don't
        // wipe the TTS/voice settings (config merges shallowly server-side).
        voice: {
          ...(config?.voice || {}),
          outbound: {
            ...(config?.voice?.outbound || {}),
            enabled,
            denyInternational: !allowIntl,
          },
        },
      });
      setMsg('Saved!');
      onSaved?.();
      setTimeout(() => setMsg(''), 2500);
    } catch (e) {
      setMsg('Error: ' + e.message);
    }
    setSaving(false);
  };

  return (
    <div className="card">
      <div className="card-header">Outbound calling</div>
      <div className="card-body">
        <p className="form-hint" style={{ marginTop: 0 }}>
          Let your agent <strong>place phone calls</strong> — e.g. call a business to ask a
          question on your behalf. It opens each call by naming itself as an AI agent and
          stating why it's calling, then hangs up when done. It calls from the
          <strong> Phone number</strong> set above. Emergency and premium numbers are always
          blocked, and the server enforces daily and per-number limits.
        </p>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 12 }}>
          <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
          <span>Let this agent place outbound calls</span>
        </label>

        {enabled && (
          <>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 12 }}>
              <input type="checkbox" checked={allowIntl} onChange={e => setAllowIntl(e.target.checked)} />
              <span>Allow international calls</span>
            </label>
            <p className="form-hint" style={{ marginTop: -6 }}>
              Off by default — the agent can only call domestic numbers unless you turn this on.
            </p>
          </>
        )}

        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {msg && (
          <p className="form-hint" style={{ marginTop: 8, color: msg.startsWith('Error') ? 'var(--text-error)' : 'var(--green)' }}>
            {msg}
          </p>
        )}
      </div>
    </div>
  );
}

/** Human-readable file size. */
function formatBytes(n) {
  if (!n || n < 1) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 || v >= 10 ? 0 : 1)} ${units[i]}`;
}

const CLEANUP_RANGES = [
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: '6 months', days: 180 },
  { label: '1 year', days: 365 },
];

/**
 * "Free up storage" card. Deletes leftover customer uploads that were never
 * attached to an order/booking. Picking a range auto-previews; deleting still
 * requires an explicit confirm.
 */
function DiagnosticsCard() {
  const api = useApi();
  const [data, setData] = useState(null); // { path, exists, lines, size }
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get('/api/diagnostics/error-log');
      setData(r);
    } catch {
      setData(null);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const copyPath = async () => {
    if (!data?.path) return;
    try {
      await navigator.clipboard.writeText(data.path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard may be unavailable */ }
  };

  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>Diagnostics</span>
        <button className="btn" onClick={load} disabled={loading} style={{ fontSize: 12, padding: '2px 10px' }}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>
      <div className="card-body">
        <p className="form-hint" style={{ marginTop: 0 }}>
          If the agent misbehaves, send this error log for diagnosis. It records important
          errors only and is automatically sanitized — no personal data, IDs, or secrets are stored.
        </p>

        <div className="form-group">
          <label>Error log file</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 4 }}>
            <code style={{
              fontSize: 12, padding: '6px 10px', background: 'var(--bg-secondary)',
              border: '1px solid var(--border)', borderRadius: 6, wordBreak: 'break-all', flex: '1 1 240px',
            }}>
              {data?.path || '—'}
            </code>
            <button className="btn" onClick={copyPath} disabled={!data?.path}>
              {copied ? 'Copied ✓' : 'Copy path'}
            </button>
          </div>
        </div>

        {!loading && data && !data.exists && (
          <p className="form-hint" style={{ margin: 0, color: 'var(--green)' }}>
            No errors logged yet. ✅
          </p>
        )}

        {!loading && data?.exists && (
          <div className="form-group">
            <label>Recent entries</label>
            <pre style={{
              maxHeight: 220, overflow: 'auto', fontSize: 11.5, lineHeight: 1.5,
              padding: 10, margin: '4px 0 0', background: 'var(--bg-secondary)',
              border: '1px solid var(--border)', borderRadius: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}>
              {data.lines || '(empty)'}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

function StorageCleanupCard() {
  const api = useApi();
  const [days, setDays] = useState(90);
  const [preview, setPreview] = useState(null);   // { count, bytes }
  const [checking, setChecking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  // Auto-preview whenever the selected range changes (and on first render).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setChecking(true); setError(''); setResult(null); setConfirming(false); setPreview(null);
      try {
        const r = await api.get(`/api/storage/cleanup/preview?days=${days}`);
        if (!cancelled) setPreview(r);
      } catch (e) {
        if (!cancelled) setError(e.message || 'Could not check right now.');
      }
      if (!cancelled) setChecking(false);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  const runDelete = async () => {
    setDeleting(true); setError('');
    try {
      const r = await api.post('/api/storage/cleanup', { days });
      setResult(r);
      setPreview(null);
      setConfirming(false);
    } catch (e) {
      setError(e.message || 'Could not delete right now.');
    }
    setDeleting(false);
  };

  return (
    <div className="card">
      <div className="card-header">Free up storage</div>
      <div className="card-body">
        <p className="form-hint" style={{ marginTop: 0 }}>
          Removes leftover files customers sent in chat that were never attached to
          an order or booking. Attached and recent files are always kept.
        </p>

        <div className="form-group">
          <label>Delete unattached files older than</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
            {CLEANUP_RANGES.map(r => (
              <button
                key={r.days}
                className={`btn ${days === r.days ? 'btn-primary' : ''}`}
                onClick={() => setDays(r.days)}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {checking && <p className="form-hint" style={{ margin: 0 }}>Checking…</p>}

        {!checking && preview && !confirming && (
          preview.count > 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, color: 'var(--text)' }}>
                <strong>{preview.count}</strong> file{preview.count === 1 ? '' : 's'} · <strong>{formatBytes(preview.bytes)}</strong> can be freed
              </span>
              <button className="btn btn-danger" onClick={() => setConfirming(true)}>Delete</button>
            </div>
          ) : (
            <p className="form-hint" style={{ margin: 0 }}>Nothing to clean up. ✅</p>
          )
        )}

        {confirming && preview && (
          <div style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-secondary)' }}>
            <p style={{ fontSize: 13, margin: '0 0 10px', color: 'var(--text)' }}>
              Permanently delete {preview.count} file{preview.count === 1 ? '' : 's'} ({formatBytes(preview.bytes)})? This can't be undone.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-danger" onClick={runDelete} disabled={deleting}>
                {deleting ? 'Deleting…' : 'Yes, delete'}
              </button>
              <button className="btn" onClick={() => setConfirming(false)} disabled={deleting}>Cancel</button>
            </div>
          </div>
        )}

        {result && (
          <p className="form-hint" style={{ margin: 0, color: 'var(--green)' }}>
            Deleted {result.deleted} file{result.deleted === 1 ? '' : 's'}, freed {formatBytes(result.bytes)}.
            {result.errors?.length > 0 && ` (${result.errors.length} couldn't be removed.)`}
          </p>
        )}

        {error && <p className="form-hint" style={{ margin: 0, color: 'var(--text-error)' }}>{error}</p>}
      </div>
    </div>
  );
}
