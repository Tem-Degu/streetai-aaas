import React, { useState, useEffect, useRef } from 'react';
import { useApi } from '../hooks/useApi.js';

const PLATFORM_META = {
  truuze:   { label: 'Truuze',    color: '#4a9eff', icon: 'T', desc: 'Social platform for AI agents', supported: true },
  http:     { label: 'HTTP API',  color: '#10b981', icon: 'H', desc: 'REST API endpoint', supported: true },
  openclaw: { label: 'OpenClaw',  color: '#f59e0b', icon: 'O', desc: 'Agent gateway', supported: true },
  telegram: { label: 'Telegram',  color: '#29a9eb', icon: 'T', desc: 'Telegram bot integration', supported: true },
  whatsapp: { label: 'WhatsApp',  color: '#25d366', icon: 'W', desc: 'WhatsApp Business API', supported: true },
  discord:  { label: 'Discord',   color: '#5865f2', icon: 'D', desc: 'Discord bot integration', supported: true },
  slack:    { label: 'Slack',     color: '#e01e5a', icon: 'S', desc: 'Slack app integration', supported: true },
};

const PROVIDER_OPTIONS = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'google', label: 'Google' },
  { value: 'custom', label: 'Custom' },
];

export default function Deploy() {
  const api = useApi();
  const [deployStatus, setDeployStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(null);
  const [showForm, setShowForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formMsg, setFormMsg] = useState('');

  // Truuze form
  const [truuzeMode, setTruuzeMode] = useState('new');
  const [truuzeKey, setTruuzeKey] = useState('');
  const [truuzeUrl, setTruuzeUrl] = useState('https://origin.truuze.com/api/v1');
  const [truuzeUsername, setTruuzeUsername] = useState('');
  const [truuzeFirstName, setTruuzeFirstName] = useState('');
  const [truuzeLastName, setTruuzeLastName] = useState('');
  const [truuzeJobTitle, setTruuzeJobTitle] = useState('');
  const [truuzeDescription, setTruuzeDescription] = useState('');
  const [truuzeProvider, setTruuzeProvider] = useState('custom');
  const [truuzeProviderCustom, setTruuzeProviderCustom] = useState('');
  const [detectedProvider, setDetectedProvider] = useState(null);
  const [truuzeSkillContent, setTruuzeSkillContent] = useState('');
  const [truuzeFileName, setTruuzeFileName] = useState('');
  const fileInputRef = useRef(null);
  const formRef = useRef(null);
  // Truuze edit mode
  const [editingTruuze, setEditingTruuze] = useState(false);
  const [editFields, setEditFields] = useState({});
  const [editSaving, setEditSaving] = useState(false);
  // HTTP form
  const [httpPort, setHttpPort] = useState('3300');
  // Telegram form
  const [telegramToken, setTelegramToken] = useState('');
  // Discord form
  const [discordToken, setDiscordToken] = useState('');
  // Slack form
  const [slackBotToken, setSlackBotToken] = useState('');
  const [slackAppToken, setSlackAppToken] = useState('');
  // WhatsApp form
  const [waAccessToken, setWaAccessToken] = useState('');
  const [waPhoneNumberId, setWaPhoneNumberId] = useState('');
  const [waVerifyToken, setWaVerifyToken] = useState('');
  const [waPort, setWaPort] = useState('3301');

  const load = async () => {
    try {
      const data = await api.get('/api/deploy/status');
      setDeployStatus(data);
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => {
    load();
    api.get('/api/config').then(cfg => {
      if (cfg?.provider && PROVIDER_OPTIONS.some(o => o.value === cfg.provider)) {
        setDetectedProvider(cfg.provider);
        setTruuzeProvider(cfg.provider);
      }
    }).catch(() => {});
  }, []);
  useEffect(() => {
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleFileUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setTruuzeFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      setTruuzeSkillContent(ev.target.result);
    };
    reader.readAsText(file);
  };

  const resetTruuzeForm = () => {
    setTruuzeKey(''); setTruuzeUsername(''); setTruuzeFirstName('');
    setTruuzeLastName(''); setTruuzeJobTitle(''); setTruuzeDescription('');
    setTruuzeProvider(detectedProvider || 'custom'); setTruuzeProviderCustom(''); setTruuzeSkillContent(''); setTruuzeFileName('');
    setTruuzeUrl('https://origin.truuze.com/api/v1');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const connect = async (platform) => {
    setSaving(true);
    setFormMsg('');
    try {
      let body = {};
      if (platform === 'truuze') {
        if (truuzeMode === 'new') {
          if (!truuzeSkillContent.trim()) {
            setFormMsg('Please upload or paste your SKILL.md file');
            setSaving(false);
            return;
          }
          body.skillContent = truuzeSkillContent;
          if (truuzeUsername) body.username = truuzeUsername;
          if (truuzeFirstName) body.first_name = truuzeFirstName;
          if (truuzeLastName) body.last_name = truuzeLastName;
          if (truuzeJobTitle) body.job_title = truuzeJobTitle;
          if (truuzeDescription) body.agent_description = truuzeDescription;
          body.agent_provider = truuzeProvider;
          if (truuzeProvider === 'custom' && truuzeProviderCustom) body.agent_provider_custom = truuzeProviderCustom;
        } else {
          if (!truuzeKey.trim()) {
            setFormMsg('Please enter your agent key');
            setSaving(false);
            return;
          }
          body.baseUrl = truuzeUrl;
          body.agentKey = truuzeKey;
        }
      } else if (platform === 'http') {
        body.port = parseInt(httpPort) || 3300;
      } else if (platform === 'telegram') {
        if (!telegramToken.trim()) {
          setFormMsg('Please enter your bot token');
          setSaving(false);
          return;
        }
        body.botToken = telegramToken.trim();
      } else if (platform === 'discord') {
        if (!discordToken.trim()) {
          setFormMsg('Please enter your bot token');
          setSaving(false);
          return;
        }
        body.botToken = discordToken.trim();
      } else if (platform === 'slack') {
        if (!slackBotToken.trim() || !slackAppToken.trim()) {
          setFormMsg('Both bot token and app-level token are required');
          setSaving(false);
          return;
        }
        body.botToken = slackBotToken.trim();
        body.appToken = slackAppToken.trim();
      } else if (platform === 'whatsapp') {
        if (!waAccessToken.trim() || !waPhoneNumberId.trim() || !waVerifyToken.trim()) {
          setFormMsg('Access token, Phone Number ID, and verify token are all required');
          setSaving(false);
          return;
        }
        body.accessToken = waAccessToken.trim();
        body.phoneNumberId = waPhoneNumberId.trim();
        body.verifyToken = waVerifyToken.trim();
        body.port = parseInt(waPort) || 3301;
      }
      await api.post(`/api/connections/${platform}`, body);
      setShowForm(null);
      resetTruuzeForm();
      load();
    } catch (err) {
      setFormMsg(err.message);
    }
    setSaving(false);
  };

  const disconnect = async (platform) => {
    if (!confirm(`Disconnect from ${PLATFORM_META[platform]?.label || platform}?`)) return;
    setActing(platform);
    try {
      try { await api.post(`/api/deploy/${platform}/stop`); } catch { /* ignore */ }
      await api.del(`/api/connections/${platform}`);
      load();
    } catch (err) {
      alert('Failed: ' + err.message);
    }
    setActing(null);
  };

  const startPlatform = async (platform) => {
    setActing(platform);
    try {
      await api.post(`/api/deploy/${platform}/start`);
      await load();
    } catch (err) { alert('Failed to start: ' + err.message); }
    setActing(null);
  };

  const stopPlatform = async (platform) => {
    setActing(platform);
    try {
      await api.post(`/api/deploy/${platform}/stop`);
      await load();
    } catch (err) { alert('Failed to stop: ' + err.message); }
    setActing(null);
  };

  if (loading) return <div className="page-loading">Loading...</div>;

  const connected = deployStatus?.platforms || [];
  const connectedKeys = connected.map(c => c.platform);
  const available = Object.entries(PLATFORM_META).filter(([k]) => !connectedKeys.includes(k));

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Deploy</h1>
        <p className="page-desc">Connect and run your agent on platforms</p>
      </div>

      {deployStatus?.cliRunning && (
        <div className="deploy-banner">
          <span className="deploy-banner-dot" />
          Agent is running via CLI (<code>aaas run</code>). Manage it from the terminal.
        </div>
      )}

      {/* Connected platforms */}
      {connected.length > 0 && (
        <div className="deploy-grid">
          {connected.map(({ platform, config, status: pStatus, error, hasSkill }) => {
            const meta = PLATFORM_META[platform] || { label: platform, color: '#888', icon: '?', desc: '' };
            const isRunning = pStatus === 'connected';
            const isCli = pStatus === 'cli-managed';
            const isReconnecting = pStatus === 'reconnecting';
            const isError = pStatus === 'error';
            const isActing = acting === platform;

            const badgeClass = isRunning ? 'badge-green' : isCli ? 'badge-blue' : isReconnecting ? 'badge-yellow' : isError ? 'badge-red' : 'badge-gray';
            const badgeText = isRunning ? 'running' : isCli ? 'cli' : isReconnecting ? 'reconnecting' : isError ? 'error' : 'stopped';

            // Truuze gets a profile-style card
            if (platform === 'truuze') {
              const initials = (config.agentName || config.agentUsername || 'A')
                .split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
              return (
                <div key={platform} className={`card deploy-card deploy-profile-card ${isRunning ? 'deploy-active' : isError ? 'deploy-error-border' : ''}`}>
                  <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span className="deploy-platform-icon" style={{ background: meta.color }}>{meta.icon}</span>
                    <span style={{ flex: 1 }}>{meta.label}</span>
                    <span className={`badge ${badgeClass}`}>
                      {badgeText}
                    </span>
                  </div>
                  <div className="card-body">
                    {editingTruuze ? (
                      <>
                        <div className="form-row">
                          <div className="form-group">
                            <label>First Name</label>
                            <input type="text" value={editFields.first_name || ''} onChange={e => setEditFields(f => ({ ...f, first_name: e.target.value }))} className="form-input" />
                          </div>
                          <div className="form-group">
                            <label>Last Name</label>
                            <input type="text" value={editFields.last_name || ''} onChange={e => setEditFields(f => ({ ...f, last_name: e.target.value }))} className="form-input" />
                          </div>
                        </div>
                        <div className="form-group">
                          <label>Service/Skill</label>
                          <input type="text" value={editFields.job_title || ''} onChange={e => setEditFields(f => ({ ...f, job_title: e.target.value }))} className="form-input" />
                        </div>
                        <div className="form-group">
                          <label>Description</label>
                          <textarea value={editFields.agent_description || ''} onChange={e => setEditFields(f => ({ ...f, agent_description: e.target.value }))} className="form-input" rows={3} />
                        </div>
                        <div className="form-group">
                          <label>Provider</label>
                          <select value={PROVIDER_OPTIONS.some(o => o.value === editFields.agent_provider) ? editFields.agent_provider : 'custom'} onChange={e => setEditFields(f => ({ ...f, agent_provider: e.target.value, _customProvider: e.target.value === 'custom' ? (f._customProvider || '') : '' }))} className="form-input">
                            {PROVIDER_OPTIONS.map(opt => (
                              <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                          </select>
                          {(!PROVIDER_OPTIONS.some(o => o.value === editFields.agent_provider) || editFields.agent_provider === 'custom') && (
                            <input type="text" value={editFields._customProvider || ''} onChange={e => setEditFields(f => ({ ...f, _customProvider: e.target.value }))} className="form-input" placeholder="Enter provider name" style={{ marginTop: 8 }} />
                          )}
                        </div>
                        <div className="form-actions" style={{ display: 'flex', gap: 8 }}>
                          <button className="btn btn-primary" disabled={editSaving} onClick={async () => {
                            setEditSaving(true);
                            try {
                              const { _customProvider, ...fields } = editFields;
                              if (fields.agent_provider === 'custom' && _customProvider) {
                                fields.agent_provider = _customProvider;
                              }
                              await api.patch('/api/connections/truuze', fields);
                              setEditingTruuze(false);
                              load();
                            } catch (err) {
                              alert('Failed to save: ' + err.message);
                            }
                            setEditSaving(false);
                          }}>
                            {editSaving ? 'Saving...' : 'Save'}
                          </button>
                          <button className="btn" onClick={() => setEditingTruuze(false)}>Cancel</button>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="deploy-profile">
                          <div className="deploy-profile-avatar" style={{ background: config.avatarBgColor || meta.color }}>
                            {initials}
                          </div>
                          <div className="deploy-profile-info">
                            <div className="deploy-profile-name">{config.agentName || config.agentUsername || `Agent #${config.agentId}`}</div>
                            {config.agentUsername && <div className="deploy-profile-username">@{config.agentUsername}</div>}
                            {config.jobTitle && <div className="deploy-profile-role">{config.jobTitle}</div>}
                            {config.agentProvider && <div className="deploy-profile-meta">{config.agentProvider}</div>}
                          </div>
                        </div>
                        {config.agentDescription && <p className="deploy-profile-desc">{config.agentDescription}</p>}
                        <div className="deploy-profile-details">
                          {config.ownerUsername && <div className="deploy-detail"><span>Owner</span><span>@{config.ownerUsername}</span></div>}
                          {config.connectedAt && <div className="deploy-detail"><span>Connected</span><span>{new Date(config.connectedAt).toLocaleDateString()}</span></div>}
                          <div className="deploy-detail">
                            <span>Platform Skill</span>
                            <span className={hasSkill ? 'deploy-skill-ok' : 'deploy-skill-missing'}>{hasSkill ? 'loaded' : 'none'}</span>
                          </div>
                        </div>
                        {error && <div className="deploy-error">{error}</div>}
                      </>
                    )}
                  </div>
                  <div className="card-footer" style={{ display: 'flex', gap: 8 }}>
                    {!editingTruuze && (
                      <button className="btn" onClick={() => {
                        const nameParts = (config.agentName || '').split(' ');
                        const provider = config.agentProvider || 'custom';
                        const isKnown = PROVIDER_OPTIONS.some(o => o.value === provider);
                        setEditFields({
                          first_name: nameParts[0] || '',
                          last_name: nameParts.slice(1).join(' ') || '',
                          job_title: config.jobTitle || '',
                          agent_description: config.agentDescription || '',
                          agent_provider: isKnown ? provider : 'custom',
                          _customProvider: isKnown ? '' : provider,
                        });
                        setEditingTruuze(true);
                      }}>Edit</button>
                    )}
                    {isCli ? (
                      <span className="form-hint">Managed by CLI</span>
                    ) : isRunning ? (
                      <button className="btn btn-danger" onClick={() => stopPlatform(platform)} disabled={isActing}>
                        {isActing ? 'Stopping...' : 'Stop'}
                      </button>
                    ) : (
                      <button className="btn btn-primary" onClick={() => startPlatform(platform)} disabled={isActing}>
                        {isActing ? 'Starting...' : 'Start'}
                      </button>
                    )}
                    {!isCli && !isRunning && (
                      <button className="btn btn-danger" onClick={() => disconnect(platform)} disabled={isActing}>Disconnect</button>
                    )}
                  </div>
                </div>
              );
            }

            return (
              <div key={platform} className={`card deploy-card ${isRunning ? 'deploy-active' : isError ? 'deploy-error-border' : ''}`}>
                <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className="deploy-platform-icon" style={{ background: meta.color }}>{meta.icon}</span>
                  <span style={{ flex: 1 }}>{meta.label}</span>
                  <span className={`badge ${badgeClass}`}>
                    {badgeText}
                  </span>
                </div>
                <div className="card-body">
                  {config.baseUrl && <div className="deploy-detail"><span>URL</span><span className="mono">{config.baseUrl}</span></div>}
                  {config.port && <div className="deploy-detail"><span>Port</span><span>{config.port}</span></div>}
                  {config.agentId && <div className="deploy-detail"><span>Agent</span><span>#{config.agentId}</span></div>}
                  {config.ownerUsername && <div className="deploy-detail"><span>Owner</span><span>@{config.ownerUsername}</span></div>}
                  {config.connectedAt && <div className="deploy-detail"><span>Connected</span><span>{new Date(config.connectedAt).toLocaleDateString()}</span></div>}
                  <div className="deploy-detail">
                    <span>Platform Skill</span>
                    <span className={hasSkill ? 'deploy-skill-ok' : 'deploy-skill-missing'}>{hasSkill ? 'loaded' : 'none'}</span>
                  </div>
                  {error && <div className="deploy-error">{error}</div>}
                </div>
                <div className="card-footer" style={{ display: 'flex', gap: 8 }}>
                  {isCli ? (
                    <span className="form-hint">Managed by CLI</span>
                  ) : isRunning ? (
                    <button className="btn btn-danger" onClick={() => stopPlatform(platform)} disabled={isActing}>
                      {isActing ? 'Stopping...' : 'Stop'}
                    </button>
                  ) : (
                    <button className="btn btn-primary" onClick={() => startPlatform(platform)} disabled={isActing}>
                      {isActing ? 'Starting...' : 'Start'}
                    </button>
                  )}
                  {!isCli && !isRunning && (
                    <button className="btn btn-danger" onClick={() => disconnect(platform)} disabled={isActing}>Disconnect</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Available platforms */}
      {available.length > 0 && (
        <>
          <h3 style={{ margin: connected.length > 0 ? '24px 0 12px' : '0 0 12px' }}>Available Platforms</h3>
          <div className="deploy-grid">
            {available.map(([platform, meta]) => (
              <div key={platform} className={`card deploy-card ${!meta.supported ? 'deploy-unavailable' : ''}`}>
                <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className="deploy-platform-icon" style={{ background: meta.supported ? meta.color : '#333' }}>{meta.icon}</span>
                  <span style={{ flex: 1 }}>{meta.label}</span>
                  {!meta.supported && <span className="badge">coming soon</span>}
                </div>
                <div className="card-body">
                  <p className="form-hint">{meta.desc}</p>
                </div>
                <div className="card-footer">
                  {meta.supported ? (
                    <button className="btn btn-primary" onClick={() => {
                      setShowForm(platform);
                      setFormMsg('');
                      setTruuzeMode('new');
                      setTimeout(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
                    }}>Connect</button>
                  ) : (
                    <button className="btn" disabled>Not available</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ── Truuze Connect Form ── */}
      {showForm === 'truuze' && (
        <div ref={formRef} className="card deploy-form-card">
          <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>Connect to Truuze</span>
            <button className="btn btn-sm" onClick={() => { setShowForm(null); resetTruuzeForm(); }}>Cancel</button>
          </div>
          <div className="card-body">
            {/* Mode selector cards */}
            <div className="deploy-method-grid">
              <button
                className={`deploy-method-card ${truuzeMode === 'new' ? 'deploy-method-active' : ''}`}
                onClick={() => setTruuzeMode('new')}
              >
                <span className="deploy-method-icon">+</span>
                <span className="deploy-method-title">New Agent</span>
                <span className="deploy-method-desc">Register a new agent using a SKILL.md from Truuze</span>
              </button>
              <button
                className={`deploy-method-card ${truuzeMode === 'existing' ? 'deploy-method-active' : ''}`}
                onClick={() => setTruuzeMode('existing')}
              >
                <span className="deploy-method-icon">&#8594;</span>
                <span className="deploy-method-title">Existing Agent</span>
                <span className="deploy-method-desc">Connect an agent that's already registered on Truuze</span>
              </button>
            </div>

            {truuzeMode === 'new' ? (
              <>
                {/* File upload area */}
                <div className="form-group">
                  <label>SKILL.md</label>
                  <div
                    className={`deploy-upload-zone ${truuzeSkillContent ? 'deploy-upload-filled' : ''}`}
                    onClick={() => !truuzeSkillContent && fileInputRef.current?.click()}
                    onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('deploy-upload-dragover'); }}
                    onDragLeave={e => { e.currentTarget.classList.remove('deploy-upload-dragover'); }}
                    onDrop={e => {
                      e.preventDefault();
                      e.currentTarget.classList.remove('deploy-upload-dragover');
                      const file = e.dataTransfer.files?.[0];
                      if (file) {
                        setTruuzeFileName(file.name);
                        const reader = new FileReader();
                        reader.onload = (ev) => setTruuzeSkillContent(ev.target.result);
                        reader.readAsText(file);
                      }
                    }}
                  >
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".md,.txt"
                      onChange={handleFileUpload}
                      style={{ display: 'none' }}
                    />
                    {truuzeSkillContent ? (
                      <div className="deploy-upload-preview">
                        <div className="deploy-upload-file-info">
                          <span className="deploy-upload-file-icon">&#128196;</span>
                          <div>
                            <div className="deploy-upload-file-name">{truuzeFileName || 'SKILL.md'}</div>
                            <div className="deploy-upload-file-size">{(truuzeSkillContent.length / 1024).toFixed(1)} KB</div>
                          </div>
                        </div>
                        <button className="btn btn-sm" onClick={(e) => {
                          e.stopPropagation();
                          setTruuzeSkillContent(''); setTruuzeFileName('');
                          if (fileInputRef.current) fileInputRef.current.value = '';
                        }}>Remove</button>
                      </div>
                    ) : (
                      <div className="deploy-upload-empty">
                        <span className="deploy-upload-icon">&#8593;</span>
                        <span>Drop your SKILL.md here or <strong>click to browse</strong></span>
                        <span className="deploy-upload-hint">or paste the content below</span>
                      </div>
                    )}
                  </div>
                  {!truuzeSkillContent && (
                    <textarea
                      value={truuzeSkillContent}
                      onChange={e => setTruuzeSkillContent(e.target.value)}
                      className="form-input deploy-paste-area"
                      rows={4}
                      placeholder="Or paste the SKILL.md content here..."
                    />
                  )}
                  <p className="form-hint">Get this from Truuze: My Agents &rarr; Sponsor an Agent &rarr; Download SKILL.md</p>
                </div>

                <div className="deploy-form-divider" />
                <p className="form-hint" style={{ marginBottom: 12 }}>Optionally customize your agent's identity:</p>

                <div className="form-group">
                  <label>Username</label>
                  <input type="text" value={truuzeUsername} onChange={e => setTruuzeUsername(e.target.value)} className="form-input" placeholder="my_agent" />
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label>First Name</label>
                    <input type="text" value={truuzeFirstName} onChange={e => setTruuzeFirstName(e.target.value)} className="form-input" />
                  </div>
                  <div className="form-group">
                    <label>Last Name</label>
                    <input type="text" value={truuzeLastName} onChange={e => setTruuzeLastName(e.target.value)} className="form-input" />
                  </div>
                </div>
                <div className="form-group">
                  <label>Service/Skill</label>
                  <input type="text" value={truuzeJobTitle} onChange={e => setTruuzeJobTitle(e.target.value)} className="form-input" placeholder="e.g. iPhone Sales Agent" />
                </div>
                <div className="form-group">
                  <label>Description</label>
                  <textarea value={truuzeDescription} onChange={e => setTruuzeDescription(e.target.value)} className="form-input" rows={3} placeholder="What does this agent do?" />
                </div>
                <div className="form-group">
                  <label>Provider</label>
                  <select value={truuzeProvider} onChange={e => { setTruuzeProvider(e.target.value); if (e.target.value !== 'custom') setTruuzeProviderCustom(''); }} className="form-input">
                    {PROVIDER_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                  {truuzeProvider === 'custom' && (
                    <input type="text" value={truuzeProviderCustom} onChange={e => setTruuzeProviderCustom(e.target.value)} className="form-input" placeholder="Enter provider name" style={{ marginTop: 8 }} />
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="form-group">
                  <label>Truuze API URL</label>
                  <input type="text" value={truuzeUrl} onChange={e => setTruuzeUrl(e.target.value)} className="form-input" />
                </div>
                <div className="form-group">
                  <label>Agent Key</label>
                  <input type="password" value={truuzeKey} onChange={e => setTruuzeKey(e.target.value)} className="form-input" placeholder="trz_agent_..." />
                  <p className="form-hint">The API key you received when the agent was first created</p>
                </div>
              </>
            )}

            <div className="form-actions">
              <button className="btn btn-primary" onClick={() => connect('truuze')} disabled={saving}>
                {saving ? 'Connecting...' : truuzeMode === 'new' ? 'Create & Connect' : 'Connect'}
              </button>
            </div>
            {formMsg && <p className="form-hint" style={{ color: 'var(--red)', marginTop: 8 }}>{formMsg}</p>}
          </div>
        </div>
      )}

      {showForm === 'http' && (
        <div ref={formRef} className="card deploy-form-card">
          <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>Connect HTTP API</span>
            <button className="btn btn-sm" onClick={() => setShowForm(null)}>Cancel</button>
          </div>
          <div className="card-body">
            <div className="form-group">
              <label>Port</label>
              <input type="number" value={httpPort} onChange={e => setHttpPort(e.target.value)} className="form-input" />
              <p className="form-hint">The agent will listen on this port when started.</p>
            </div>
            <div className="form-actions">
              <button className="btn btn-primary" onClick={() => connect('http')} disabled={saving}>{saving ? 'Connecting...' : 'Connect'}</button>
            </div>
            {formMsg && <p className="form-hint" style={{ color: 'var(--red)', marginTop: 8 }}>{formMsg}</p>}

            <div className="deploy-form-divider" />
            <h4 style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--text)' }}>Integration Guide</h4>
            <p className="form-hint" style={{ marginBottom: 12 }}>Once connected and started, your agent exposes a REST API. Send a message and get the agent's response:</p>
            <pre className="deploy-code-block">{`POST http://localhost:${httpPort || 3300}/chat
Content-Type: application/json

{
  "message": "Hello, what services do you offer?",
  "userId": "user_123",
  "userName": "John"
}`}</pre>
            <p className="form-hint" style={{ margin: '8px 0 4px' }}>Response:</p>
            <pre className="deploy-code-block">{`{
  "response": "Hi! Here's what I can help with...",
  "toolsUsed": [],
  "tokensUsed": 120
}`}</pre>
            <p className="form-hint" style={{ margin: '12px 0 8px' }}>JavaScript example for your website:</p>
            <pre className="deploy-code-block">{`const response = await fetch("http://localhost:${httpPort || 3300}/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    message: userInput,
    userId: "user_123",
    userName: "John"
  })
});
const data = await response.json();
console.log(data.response);`}</pre>
            <div className="deploy-form-divider" />
            <h4 style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--text)' }}>Chat Widget (Easiest)</h4>
            <p className="form-hint" style={{ marginBottom: 8 }}>Add a ready-made chat interface to your website with one line. Paste this before the closing <code>&lt;/body&gt;</code> tag:</p>
            <pre className="deploy-code-block">{`<script src="http://localhost:${httpPort || 3300}/widget.js"
  data-agent="http://localhost:${httpPort || 3300}"
  data-title="My Agent"
  data-color="#2563eb"
  data-greeting="Hi! How can I help you today?"
></script>`}</pre>
            <p className="form-hint" style={{ marginTop: 8 }}>This injects a floating chat button in the bottom-right corner of your page. No other code needed.</p>
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
              <strong style={{ color: 'var(--text)' }}>Options:</strong>
              <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span><code>data-agent</code> — Your agent's URL (required)</span>
                <span><code>data-title</code> — Header title (default: "Chat")</span>
                <span><code>data-color</code> — Theme color (default: "#2563eb")</span>
                <span><code>data-position</code> — "right" or "left" (default: "right")</span>
                <span><code>data-greeting</code> — Welcome message shown before first message</span>
              </div>
            </div>

            <div style={{ marginTop: 16, padding: '10px 12px', background: 'var(--bg-secondary)', borderRadius: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
              <strong style={{ color: 'var(--text)' }}>Endpoints</strong>
              <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span><code>POST /chat</code> — Send a message, get the agent's response</span>
                <span><code>GET /health</code> — Check if the agent is running</span>
                <span><code>GET /info</code> — Get agent details (name, provider, status)</span>
                <span><code>GET /widget.js</code> — Embeddable chat widget script</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {showForm === 'telegram' && (
        <div ref={formRef} className="card deploy-form-card">
          <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>Connect to Telegram</span>
            <button className="btn btn-sm" onClick={() => { setShowForm(null); setTelegramToken(''); }}>Cancel</button>
          </div>
          <div className="card-body">
            <div className="form-group">
              <label>Bot Token</label>
              <input type="password" value={telegramToken} onChange={e => setTelegramToken(e.target.value)} className="form-input" placeholder="123456789:ABCdefGHI..." />
              <p className="form-hint">Get this from <strong>@BotFather</strong> on Telegram</p>
            </div>
            <div className="form-actions">
              <button className="btn btn-primary" onClick={() => connect('telegram')} disabled={saving}>{saving ? 'Connecting...' : 'Connect'}</button>
            </div>
            {formMsg && <p className="form-hint" style={{ color: 'var(--red)', marginTop: 8 }}>{formMsg}</p>}

            <div className="deploy-form-divider" />
            <h4 style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--text)' }}>Setup Instructions</h4>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
              <p style={{ margin: '0 0 8px' }}><strong>1.</strong> Open Telegram and search for <strong>@BotFather</strong></p>
              <p style={{ margin: '0 0 8px' }}><strong>2.</strong> Send <code>/newbot</code> and follow the prompts to name your bot</p>
              <p style={{ margin: '0 0 8px' }}><strong>3.</strong> BotFather will give you a token — paste it above</p>
              <p style={{ margin: '0 0 8px' }}><strong>4.</strong> Users can then message your bot directly on Telegram</p>
            </div>
          </div>
        </div>
      )}

      {showForm === 'discord' && (
        <div ref={formRef} className="card deploy-form-card">
          <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>Connect to Discord</span>
            <button className="btn btn-sm" onClick={() => { setShowForm(null); setDiscordToken(''); }}>Cancel</button>
          </div>
          <div className="card-body">
            <div className="form-group">
              <label>Bot Token</label>
              <input type="password" value={discordToken} onChange={e => setDiscordToken(e.target.value)} className="form-input" placeholder="MTIzNDU2Nzg5..." />
              <p className="form-hint">Get this from the <strong>Discord Developer Portal</strong></p>
            </div>
            <div className="form-actions">
              <button className="btn btn-primary" onClick={() => connect('discord')} disabled={saving}>{saving ? 'Connecting...' : 'Connect'}</button>
            </div>
            {formMsg && <p className="form-hint" style={{ color: 'var(--red)', marginTop: 8 }}>{formMsg}</p>}

            <div className="deploy-form-divider" />
            <h4 style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--text)' }}>Setup Instructions</h4>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
              <p style={{ margin: '0 0 8px' }}><strong>1.</strong> Go to <strong>discord.com/developers/applications</strong> and create a New Application</p>
              <p style={{ margin: '0 0 8px' }}><strong>2.</strong> Go to <strong>Bot</strong> tab → click <strong>Reset Token</strong> → copy the token and paste it above</p>
              <p style={{ margin: '0 0 8px' }}><strong>3.</strong> Under <strong>Privileged Gateway Intents</strong>, enable <strong>Message Content Intent</strong></p>
              <p style={{ margin: '0 0 8px' }}><strong>4.</strong> Go to <strong>OAuth2</strong> tab → <strong>URL Generator</strong> → select <strong>bot</strong> scope → select <strong>Send Messages</strong> and <strong>Read Message History</strong> permissions</p>
              <p style={{ margin: '0 0 8px' }}><strong>5.</strong> Copy the generated URL and open it to invite the bot to your server</p>
              <p style={{ margin: '0 0 8px' }}><strong>6.</strong> Users can DM the bot or @mention it in a channel</p>
            </div>
          </div>
        </div>
      )}

      {showForm === 'slack' && (
        <div ref={formRef} className="card deploy-form-card">
          <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>Connect to Slack</span>
            <button className="btn btn-sm" onClick={() => { setShowForm(null); setSlackBotToken(''); setSlackAppToken(''); }}>Cancel</button>
          </div>
          <div className="card-body">
            <div className="form-group">
              <label>Bot Token</label>
              <input type="password" value={slackBotToken} onChange={e => setSlackBotToken(e.target.value)} className="form-input" placeholder="xoxb-..." />
              <p className="form-hint">Found under <strong>OAuth & Permissions</strong> → Bot User OAuth Token</p>
            </div>
            <div className="form-group">
              <label>App-Level Token</label>
              <input type="password" value={slackAppToken} onChange={e => setSlackAppToken(e.target.value)} className="form-input" placeholder="xapp-..." />
              <p className="form-hint">Found under <strong>Basic Information</strong> → App-Level Tokens (needs <code>connections:write</code> scope)</p>
            </div>
            <div className="form-actions">
              <button className="btn btn-primary" onClick={() => connect('slack')} disabled={saving}>{saving ? 'Connecting...' : 'Connect'}</button>
            </div>
            {formMsg && <p className="form-hint" style={{ color: 'var(--red)', marginTop: 8 }}>{formMsg}</p>}

            <div className="deploy-form-divider" />
            <h4 style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--text)' }}>Setup Instructions</h4>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
              <p style={{ margin: '0 0 8px' }}><strong>1.</strong> Go to <strong>api.slack.com/apps</strong> and click <strong>Create New App</strong> → From scratch</p>
              <p style={{ margin: '0 0 8px' }}><strong>2.</strong> Go to <strong>Socket Mode</strong> → enable it → create an app-level token with <code>connections:write</code> scope → copy the <code>xapp-...</code> token</p>
              <p style={{ margin: '0 0 8px' }}><strong>3.</strong> Go to <strong>Event Subscriptions</strong> → enable → add bot events: <code>message.im</code> and <code>app_mention</code></p>
              <p style={{ margin: '0 0 8px' }}><strong>4.</strong> Go to <strong>OAuth & Permissions</strong> → add scopes: <code>chat:write</code>, <code>im:history</code>, <code>app_mentions:read</code> → install to workspace → copy the <code>xoxb-...</code> token</p>
              <p style={{ margin: '0 0 8px' }}><strong>5.</strong> Paste both tokens above</p>
              <p style={{ margin: '0 0 8px' }}><strong>6.</strong> Users can DM the bot or @mention it in channels</p>
            </div>
          </div>
        </div>
      )}

      {showForm === 'whatsapp' && (
        <div ref={formRef} className="card deploy-form-card">
          <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>Connect to WhatsApp</span>
            <button className="btn btn-sm" onClick={() => { setShowForm(null); setWaAccessToken(''); setWaPhoneNumberId(''); setWaVerifyToken(''); }}>Cancel</button>
          </div>
          <div className="card-body">
            <div className="form-group">
              <label>Access Token</label>
              <input type="password" value={waAccessToken} onChange={e => setWaAccessToken(e.target.value)} className="form-input" placeholder="EAAxxxxxxx..." />
              <p className="form-hint">Permanent token from your Meta App's WhatsApp settings</p>
            </div>
            <div className="form-group">
              <label>Phone Number ID</label>
              <input type="text" value={waPhoneNumberId} onChange={e => setWaPhoneNumberId(e.target.value)} className="form-input" placeholder="1234567890" />
              <p className="form-hint">Found in Meta Developer Portal → WhatsApp → API Setup</p>
            </div>
            <div className="form-group">
              <label>Verify Token</label>
              <input type="text" value={waVerifyToken} onChange={e => setWaVerifyToken(e.target.value)} className="form-input" placeholder="my_secret_verify_token" />
              <p className="form-hint">Any string you choose — must match what you enter in Meta's webhook config</p>
            </div>
            <div className="form-group">
              <label>Webhook Port</label>
              <input type="number" value={waPort} onChange={e => setWaPort(e.target.value)} className="form-input" />
              <p className="form-hint">Local port for the webhook server</p>
            </div>
            <div className="form-actions">
              <button className="btn btn-primary" onClick={() => connect('whatsapp')} disabled={saving}>{saving ? 'Connecting...' : 'Connect'}</button>
            </div>
            {formMsg && <p className="form-hint" style={{ color: 'var(--red)', marginTop: 8 }}>{formMsg}</p>}

            <div className="deploy-form-divider" />
            <h4 style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--text)' }}>Setup Instructions</h4>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
              <p style={{ margin: '0 0 8px' }}><strong>1.</strong> Create a Meta Business account and a Meta App at <strong>developers.facebook.com</strong></p>
              <p style={{ margin: '0 0 8px' }}><strong>2.</strong> Add the <strong>WhatsApp</strong> product to your app</p>
              <p style={{ margin: '0 0 8px' }}><strong>3.</strong> In <strong>API Setup</strong>, note your <strong>Phone Number ID</strong> and generate a permanent <strong>Access Token</strong></p>
              <p style={{ margin: '0 0 8px' }}><strong>4.</strong> Choose a <strong>Verify Token</strong> (any string) and enter it above</p>
              <p style={{ margin: '0 0 8px' }}><strong>5.</strong> Connect here, then start the connector — it will listen on the port shown</p>
              <p style={{ margin: '0 0 8px' }}><strong>6.</strong> In Meta's <strong>Webhook Configuration</strong>, set the callback URL to <code>https://&lt;your-public-url&gt;:{waPort || 3301}/webhook</code> and the verify token to match step 4</p>
              <p style={{ margin: '0 0 8px' }}><strong>7.</strong> Subscribe to the <strong>messages</strong> webhook field</p>
              <p style={{ margin: '0 0 4px', color: 'var(--text)', fontWeight: 500 }}>Important:</p>
              <p style={{ margin: '0 0 8px' }}>Your server must be publicly accessible with HTTPS for Meta to deliver webhooks. Use a reverse proxy (nginx, Cloudflare Tunnel, ngrok) to expose the local port.</p>
            </div>
          </div>
        </div>
      )}

      {showForm === 'openclaw' && (
        <div ref={formRef} className="card deploy-form-card">
          <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>Connect to OpenClaw</span>
            <button className="btn btn-sm" onClick={() => setShowForm(null)}>Cancel</button>
          </div>
          <div className="card-body">
            <p className="form-hint">This will sync your workspace to OpenClaw's directory when started.</p>
            <div className="form-actions">
              <button className="btn btn-primary" onClick={() => connect('openclaw')} disabled={saving}>{saving ? 'Connecting...' : 'Connect'}</button>
            </div>
            {formMsg && <p className="form-hint" style={{ color: 'var(--red)', marginTop: 8 }}>{formMsg}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
