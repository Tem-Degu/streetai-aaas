import React, { useState, useEffect, useContext } from 'react';
import { useApi } from '../hooks/useApi.js';
import { ThemeContext } from '../hooks/useTheme.js';

const PROVIDERS = [
  { value: 'anthropic', label: 'Anthropic (Claude)', hasOAuth: true },
  { value: 'openai', label: 'OpenAI (GPT)', hasOAuth: false },
  { value: 'google', label: 'Google (Gemini)', hasOAuth: true },
  { value: 'ollama', label: 'Ollama (Local)', hasOAuth: false },
  { value: 'openrouter', label: 'OpenRouter', hasOAuth: false },
  { value: 'azure', label: 'Azure OpenAI', hasOAuth: true },
];

export default function Settings() {
  const api = useApi();
  const themeCtx = useContext(ThemeContext);
  const theme = themeCtx?.theme || 'dark';
  const setTheme = themeCtx?.setTheme || (() => {});
  const [config, setConfig] = useState(null);
  const [engineStatus, setEngineStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [model, setModel] = useState('');
  const [provider, setProvider] = useState('');
  const [providerModels, setProviderModels] = useState([]);
  const [customModel, setCustomModel] = useState(false);

  // API key form
  const [keyProvider, setKeyProvider] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [azureEndpoint, setAzureEndpoint] = useState('');
  const [ollamaUrl, setOllamaUrl] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [keyMsg, setKeyMsg] = useState('');

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
    try {
      await api.put('/api/config', { provider, model });
      const cfg = await api.get('/api/config');
      setConfig(cfg);
    } catch (err) {
      alert('Save failed: ' + err.message);
    }
    setSaving(false);
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
    if (!confirm(`Remove ${name} credentials?`)) return;
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
            <button className="btn btn-primary" onClick={save} disabled={saving || !provider || !model}>
              {saving ? 'Saving...' : 'Save'}
            </button>
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
          <div className="card-header">Connect via OAuth</div>
          <div className="card-body">
            <p className="form-hint" style={{ marginBottom: 12 }}>
              Use your existing subscription (Claude Max, Google AI, Azure) without an API key.
            </p>

            {oauthStep === 0 && (
              <>
                <div className="form-group">
                  <label>Provider</label>
                  <select value={oauthProvider} onChange={e => { setOauthProvider(e.target.value); setOauthMsg(''); }} className="form-select">
                    <option value="">Select provider...</option>
                    {PROVIDERS.filter(p => p.hasOAuth).map(p => (
                      <option key={p.value} value={p.value}>{p.label}</option>
                    ))}
                  </select>
                </div>

                {oauthProvider && (
                  <button className="btn btn-primary" onClick={startOAuth} disabled={oauthLoading}>
                    {oauthLoading ? 'Starting...' : 'Start Authorization'}
                  </button>
                )}
              </>
            )}

            {oauthStep === 2 && (
              <>
                <div className="oauth-steps">
                  <div className="oauth-step">
                    <span className="oauth-step-num">1</span>
                    <div>
                      <p>Open this URL in your browser and authorize:</p>
                      <div className="oauth-url-box">
                        <code className="oauth-url">{oauthAuthUrl}</code>
                        <button className="btn btn-small" onClick={() => {
                          navigator.clipboard.writeText(oauthAuthUrl);
                        }}>Copy</button>
                        <a href={oauthAuthUrl} target="_blank" rel="noreferrer" className="btn btn-small btn-primary">Open</a>
                      </div>
                    </div>
                  </div>

                  <div className="oauth-step">
                    <span className="oauth-step-num">2</span>
                    <div>
                      <p>After authorizing, you'll be redirected. Copy the full URL from your browser's address bar and paste it here:</p>
                      <div className="form-group">
                        <input
                          type="text"
                          value={oauthRedirectUrl}
                          onChange={e => setOauthRedirectUrl(e.target.value)}
                          className="form-input"
                          placeholder="http://localhost/callback?code=..."
                        />
                      </div>
                    </div>
                  </div>
                </div>

                <div className="form-actions">
                  <button className="btn btn-primary" onClick={exchangeOAuth} disabled={oauthLoading || !oauthRedirectUrl}>
                    {oauthLoading ? 'Connecting...' : 'Connect'}
                  </button>
                  <button className="btn" onClick={() => { setOauthStep(0); setOauthAuthUrl(''); setOauthState(''); }}>
                    Cancel
                  </button>
                </div>
              </>
            )}

            {oauthMsg && <p className="form-hint" style={{ marginTop: 8, color: oauthMsg.startsWith('Error') ? 'var(--text-error)' : 'var(--green)' }}>{oauthMsg}</p>}
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
                    <button className="btn-icon" onClick={() => removeKey(p.name)} title="Remove">✕</button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Token Budgets */}
        {config?.context?.budgets && (
          <div className="card">
            <div className="card-header">Token Budgets</div>
            <div className="card-body">
              <div className="status-list">
                {Object.entries(config.context.budgets).map(([k, v]) => (
                  <div key={k} className="status-item">
                    <span className="status-label">{k}</span>
                    <span>{v.toLocaleString()} tokens</span>
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
      </div>
    </div>
  );
}
