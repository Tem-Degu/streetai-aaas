import React, { useState, useEffect, useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApi, WorkspaceContext } from '../hooks/useApi.js';
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
  const workspace = useContext(WorkspaceContext);
  const navigate = useNavigate();
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
  const [agentType, setAgentType] = useState('service');
  const [saveMsg, setSaveMsg] = useState('');
  const [showRestartNotice, setShowRestartNotice] = useState(false);

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
      await api.put('/api/config', { provider, model, agentType });
      const cfg = await api.get('/api/config');
      setConfig(cfg);
      setSaveMsg('Saved!');
      setTimeout(() => setSaveMsg(''), 2500);

      // Only workspace mode runs an agent daemon — skip in hub mode.
      if (workspace && (providerChanged || modelChanged)) {
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
                <span>Your running connectors are still using the previous provider/model. Stop and start them on the Deploy page to apply the change.</span>
                <button className="btn btn-sm" onClick={() => navigate(`/ws/${workspace}/deploy`)}>
                  Go to Deploy
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
