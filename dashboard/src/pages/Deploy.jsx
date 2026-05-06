import React, { useState, useEffect, useRef } from 'react';
import { useApi } from '../hooks/useApi.js';
import { SiTelegram, SiWhatsapp, SiDiscord, SiSlack } from 'react-icons/si';
import { HiGlobeAlt, HiCommandLine } from 'react-icons/hi2';
import { TbRelationManyToMany } from 'react-icons/tb';
import truuzeIcon from '../assets/truuze-icon.png';
import openclawIcon from '../assets/openclaw-icon.png';

const PLATFORM_ICONS = {
  truuze:   { Icon: () => <img src={truuzeIcon} alt="Truuze" style={{ width: 20, height: 20, borderRadius: 4 }} /> },
  http:     { Icon: HiGlobeAlt, color: '#10b981' },
  openclaw: { Icon: () => <img src={openclawIcon} alt="OpenClaw" style={{ width: 20, height: 20, borderRadius: 4 }} /> },
  telegram: { Icon: SiTelegram, color: '#29a9eb' },
  whatsapp: { Icon: SiWhatsapp, color: '#25d366' },
  discord:  { Icon: SiDiscord, color: '#5865f2' },
  slack:    { Icon: SiSlack, color: '#e01e5a' },
  relay:    { Icon: TbRelationManyToMany, color: '#8b5cf6' },
};

const PLATFORM_META = {
  truuze:   { label: 'Truuze',    color: '#4a9eff', desc: 'Social platform for AI agents', supported: true, help: 'Connect your agent to the Truuze social network where it can post, comment, follow users, and interact with other AI agents.' },
  relay:    { label: 'Public Link (Relay)',     color: '#8b5cf6', desc: 'Get a public chat URL for your agent. No server needed. Also enables WhatsApp integration.', supported: true, help: 'Connect through StreetAI to get a public chat URL and embeddable widget. Works from any computer, no public IP needed. Also routes WhatsApp messages if connected.' },
  openclaw: { label: 'OpenClaw',  color: '#f59e0b', desc: 'Agent gateway', supported: true, help: 'Sync your workspace to OpenClaw\'s agent directory so others can discover and use your agent.' },
  telegram: { label: 'Telegram',  color: '#29a9eb', desc: 'Telegram bot integration', supported: true, help: 'Connect a Telegram bot so users can chat with your agent directly in Telegram. Requires a bot token from @BotFather.' },
  whatsapp: { label: 'WhatsApp',  color: '#25d366', desc: 'WhatsApp Business API', supported: true, help: 'Connect to WhatsApp Business API so customers can message your agent via WhatsApp. Requires Meta Business credentials.' },
  discord:  { label: 'Discord',   color: '#5865f2', desc: 'Discord bot integration', supported: true, help: 'Add your agent as a Discord bot that can respond to messages in your server channels.' },
  slack:    { label: 'Slack',     color: '#e01e5a', desc: 'Slack app integration', supported: true, help: 'Install your agent as a Slack app that can respond to messages in your workspace channels.' },
  http:     { label: 'HTTP API',  color: '#10b981', desc: 'REST API + chat widget (requires public server)', supported: true, help: 'Run a local REST API on your machine. Best for development or when you have a server with a public IP. Includes an embeddable chat widget.' },
};

const PROVIDER_OPTIONS = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'google', label: 'Google' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'custom', label: 'Custom' },
];

function HelpTooltip({ text }) {
  return (
    <span className="deploy-help-wrap">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-muted)', cursor: 'help', flexShrink: 0 }}>
        <circle cx="12" cy="12" r="10" />
        <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <span className="deploy-help-tooltip">{text}</span>
    </span>
  );
}

export default function Deploy() {
  const api = useApi();
  const [deployStatus, setDeployStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(null);
  const [showForm, setShowForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formMsg, setFormMsg] = useState('');
  const [disconnectConfirm, setDisconnectConfirm] = useState(null);
  const [connectSuccess, setConnectSuccess] = useState(null);

  // Truuze form
  const [truuzeMode, setTruuzeMode] = useState('new');
  const [truuzeKey, setTruuzeKey] = useState('');
  const [truuzeUrl, setTruuzeUrl] = useState('https://origin.truuze.com/api/v1');
  const [truuzeUsername, setTruuzeUsername] = useState('');
  const [truuzeAgentName, setTruuzeAgentName] = useState('');
  const [truuzeJobTitle, setTruuzeJobTitle] = useState('');
  const [truuzeDescription, setTruuzeDescription] = useState('');
  const [truuzeProvider, setTruuzeProvider] = useState('custom');
  const [truuzeProviderCustom, setTruuzeProviderCustom] = useState('');
  const [detectedProvider, setDetectedProvider] = useState(null);
  const [truuzeSkillContent, setTruuzeSkillContent] = useState('');
  const [truuzeFileName, setTruuzeFileName] = useState('');
  const [truuzePhoto, setTruuzePhoto] = useState(null);             // File object
  const [truuzePhotoPreview, setTruuzePhotoPreview] = useState(''); // data URL for <img>
  const fileInputRef = useRef(null);
  const photoInputRef = useRef(null);
  const formRef = useRef(null);
  // Truuze edit mode
  const [editingTruuze, setEditingTruuze] = useState(false);
  const [editFields, setEditFields] = useState({});
  const [editSaving, setEditSaving] = useState(false);
  // Photo edit state. editPhotoChanged distinguishes "user touched the photo"
  // from "user left it alone" — only when changed do we send multipart.
  const [editPhoto, setEditPhoto] = useState(null);
  const [editPhotoPreview, setEditPhotoPreview] = useState('');
  const [editPhotoChanged, setEditPhotoChanged] = useState(false);
  const editPhotoInputRef = useRef(null);
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
  // Relay form
  const [relayName, setRelayName] = useState('');
  const [relayResult, setRelayResult] = useState(null);
  // Owner verification
  const [verifyPending, setVerifyPending] = useState([]);

  const load = async () => {
    try {
      const data = await api.get('/api/deploy/status');
      setDeployStatus(data);
    } catch { /* ignore */ }
    try {
      const v = await api.get('/api/deploy/verify');
      setVerifyPending(v?.pending || []);
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
    setTruuzeKey(''); setTruuzeUsername(''); setTruuzeAgentName('');
    setTruuzeJobTitle(''); setTruuzeDescription('');
    setTruuzeProvider(detectedProvider || 'custom'); setTruuzeProviderCustom(''); setTruuzeSkillContent(''); setTruuzeFileName('');
    setTruuzePhoto(null); setTruuzePhotoPreview('');
    setTruuzeUrl('https://origin.truuze.com/api/v1');
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (photoInputRef.current) photoInputRef.current.value = '';
  };

  const handlePhotoUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setFormMsg('Please choose an image file');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setFormMsg('Photo must be 5MB or smaller');
      return;
    }
    setFormMsg('');
    setTruuzePhoto(file);
    const reader = new FileReader();
    reader.onload = (ev) => setTruuzePhotoPreview(ev.target.result);
    reader.readAsDataURL(file);
  };

  const removePhoto = () => {
    setTruuzePhoto(null);
    setTruuzePhotoPreview('');
    if (photoInputRef.current) photoInputRef.current.value = '';
  };

  const handleEditPhotoUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      alert('Please choose an image file');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      alert('Photo must be 5MB or smaller');
      return;
    }
    setEditPhoto(file);
    setEditPhotoChanged(true);
    const reader = new FileReader();
    reader.onload = (ev) => setEditPhotoPreview(ev.target.result);
    reader.readAsDataURL(file);
  };

  const removeEditPhoto = () => {
    setEditPhoto(null);
    setEditPhotoPreview('');
    setEditPhotoChanged(true);
    if (editPhotoInputRef.current) editPhotoInputRef.current.value = '';
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
          // Truuze accepts only first_name for agents — pass the agent name as first_name.
          const fields = {
            skillContent: truuzeSkillContent,
            agent_provider: truuzeProvider,
          };
          if (truuzeUsername) fields.username = truuzeUsername;
          if (truuzeAgentName) fields.first_name = truuzeAgentName;
          if (truuzeJobTitle) fields.job_title = truuzeJobTitle;
          if (truuzeDescription) fields.agent_description = truuzeDescription;
          if (truuzeProvider === 'custom' && truuzeProviderCustom) fields.agent_provider_custom = truuzeProviderCustom;

          // Use FormData only when a photo is attached, so the route stays JSON for everything else.
          if (truuzePhoto) {
            const fd = new FormData();
            for (const [k, v] of Object.entries(fields)) fd.append(k, v);
            fd.append('photo', truuzePhoto, truuzePhoto.name);
            body = fd;
          } else {
            body = fields;
          }
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
      } else if (platform === 'relay') {
        if (!relayName.trim()) {
          setFormMsg('Please enter an agent name');
          setSaving(false);
          return;
        }
        body.name = relayName.trim();
      }
      const result = await api.post(`/api/connections/${platform}`, body);
      if (platform === 'relay' && result?.connections) {
        const relayConn = result.connections.find(c => c.platform === 'relay');
        if (relayConn?.config) {
          setRelayResult(relayConn.config);
        }
      } else {
        setShowForm(null);
      }
      setConnectSuccess(platform);
      setTimeout(() => setConnectSuccess((p) => (p === platform ? null : p)), 3000);
      resetTruuzeForm();
      load();
    } catch (err) {
      setFormMsg(err.message);
    }
    setSaving(false);
  };

  const disconnect = async (platform) => {
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
          Your agent is already running from the terminal. Start and stop controls are managed there.
        </div>
      )}

      {verifyPending.length > 0 && verifyPending.map((v, i) => (
        <div key={i} className="card" style={{ borderLeft: '3px solid var(--accent)', marginBottom: 12 }}>
          <div className="card-title" style={{ color: 'var(--accent)', marginBottom: 8 }}>Owner Verification Request</div>
          <p style={{ fontSize: 14, margin: '0 0 8px' }}>
            Someone on <strong>{PLATFORM_META[v.platform]?.label || v.platform}</strong> is requesting admin access.
            {v.userId && <span style={{ color: 'var(--text-muted)' }}> (User: {v.userId})</span>}
          </p>
          <p style={{ fontSize: 14, margin: '0 0 4px' }}>If this is you, type this code in the chat:</p>
          <div style={{ fontSize: 24, fontFamily: 'monospace', fontWeight: 700, letterSpacing: 4, color: 'var(--accent)', margin: '8px 0' }}>{v.code}</div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>This code expires in 10 minutes.</p>
        </div>
      ))}

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
                    <span className="deploy-platform-icon">{(() => { const pi = PLATFORM_ICONS[platform]; return pi ? <pi.Icon size={20} color={pi.color} /> : meta.label[0]; })()}</span>
                    <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>{meta.label} {meta.help && <HelpTooltip text={meta.help} />}</span>
                    <span className={`badge ${badgeClass}`}>
                      {badgeText}
                    </span>
                  </div>
                  <div className="card-body">
                    {editingTruuze ? (
                      <>
                        <div className="deploy-photo-row">
                          <div
                            className={`deploy-photo-upload ${editPhotoPreview ? 'deploy-photo-filled deploy-photo-clickable' : ''}`}
                            onClick={() => editPhotoInputRef.current?.click()}
                            title={editPhotoPreview ? 'Click to change photo' : 'Click to upload agent photo'}
                          >
                            <input
                              ref={editPhotoInputRef}
                              type="file"
                              accept="image/*"
                              onChange={handleEditPhotoUpload}
                              style={{ display: 'none' }}
                            />
                            {editPhotoPreview ? (
                              <img src={editPhotoPreview} alt="Agent" className="deploy-photo-img" />
                            ) : (
                              <span className="deploy-photo-placeholder">+</span>
                            )}
                          </div>
                          <div className="deploy-photo-meta">
                            <div className="deploy-photo-label">Agent photo</div>
                            <div className="deploy-photo-hint">PNG or JPG, up to 5MB.</div>
                            {editPhotoPreview && (
                              <button
                                type="button"
                                className="deploy-photo-remove-link"
                                onClick={removeEditPhoto}
                              >Remove photo</button>
                            )}
                          </div>
                        </div>
                        <div className="form-group">
                          <label>Agent Name</label>
                          <input type="text" value={editFields.agent_name || ''} onChange={e => setEditFields(f => ({ ...f, agent_name: e.target.value }))} className="form-input" placeholder="e.g. Atlas" />
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
                              const { _customProvider, agent_name, ...rest } = editFields;
                              const fields = {
                                ...rest,
                                first_name: (agent_name || '').trim(),
                                last_name: '',
                              };
                              if (fields.agent_provider === 'custom' && _customProvider) {
                                fields.agent_provider = _customProvider;
                              }
                              if (editPhotoChanged) {
                                // Photo touched — send multipart so the backend
                                // can forward the binary (or photo=null) upstream.
                                const fd = new FormData();
                                Object.entries(fields).forEach(([k, v]) => {
                                  if (v !== undefined && v !== null) fd.append(k, v);
                                });
                                if (editPhoto) {
                                  fd.append('photo', editPhoto, editPhoto.name);
                                } else {
                                  fd.append('remove_photo', 'true');
                                }
                                await api.patch('/api/connections/truuze', fd);
                              } else {
                                await api.patch('/api/connections/truuze', fields);
                              }
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
                          {config.agentPhoto ? (
                            <img className="deploy-profile-avatar" src={config.agentPhoto} alt={config.agentName || 'Agent'} style={{ objectFit: 'cover' }} />
                          ) : (
                            <div className="deploy-profile-avatar" style={{ background: config.avatarBgColor || meta.color }}>
                              {initials}
                            </div>
                          )}
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
                        const provider = config.agentProvider || 'custom';
                        const isKnown = PROVIDER_OPTIONS.some(o => o.value === provider);
                        setEditFields({
                          agent_name: config.agentName || '',
                          job_title: config.jobTitle || '',
                          agent_description: config.agentDescription || '',
                          agent_provider: isKnown ? provider : 'custom',
                          _customProvider: isKnown ? '' : provider,
                        });
                        setEditPhoto(null);
                        setEditPhotoPreview(config.agentPhoto || '');
                        setEditPhotoChanged(false);
                        setEditingTruuze(true);
                      }}>Edit</button>
                    )}
                    {!editingTruuze && (
                      isCli ? (
                        <span className="form-hint">Managed by CLI</span>
                      ) : platform === 'openclaw' ? (
                        <button className="btn btn-primary" onClick={() => connect('openclaw')} disabled={saving}>
                          {saving ? 'Exporting...' : connectSuccess === 'openclaw' ? 'Exported ✓' : 'Re-export'}
                        </button>
                      ) : isRunning ? (
                        <button className="btn btn-danger" onClick={() => stopPlatform(platform)} disabled={isActing}>
                          {isActing ? 'Stopping...' : 'Stop'}
                        </button>
                      ) : (
                        <button className="btn btn-primary" onClick={() => startPlatform(platform)} disabled={isActing}>
                          {isActing ? 'Starting...' : 'Start'}
                        </button>
                      )
                    )}
                    {!editingTruuze && !isCli && !isRunning && (
                      <button className="btn btn-danger" onClick={() => setDisconnectConfirm(platform)} disabled={isActing}>Disconnect</button>
                    )}
                  </div>
                </div>
              );
            }

            return (
              <div key={platform} className={`card deploy-card ${isRunning ? 'deploy-active' : isError ? 'deploy-error-border' : ''}`}>
                <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className="deploy-platform-icon">{(() => { const pi = PLATFORM_ICONS[platform]; return pi ? <pi.Icon size={20} color={pi.color} /> : meta.label[0]; })()}</span>
                  <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>{meta.label} {meta.help && <HelpTooltip text={meta.help} />}</span>
                  <span className={`badge ${badgeClass}`}>
                    {badgeText}
                  </span>
                </div>
                <div className="card-body">
                  {config.baseUrl && <div className="deploy-detail"><span>URL</span><span className="mono">{config.baseUrl}</span></div>}
                  {config.port && <div className="deploy-detail"><span>Port</span><span>{config.port}</span></div>}
                  {config.slug && <div className="deploy-detail"><span>Slug</span><span className="mono">{config.slug}</span></div>}
                  {config.agentId && <div className="deploy-detail"><span>Agent</span><span>#{config.agentId}</span></div>}
                  {config.ownerUsername && <div className="deploy-detail"><span>Owner</span><span>@{config.ownerUsername}</span></div>}
                  {config.connectedAt && <div className="deploy-detail"><span>Connected</span><span>{new Date(config.connectedAt).toLocaleDateString()}</span></div>}
                  <div className="deploy-detail">
                    <span>Platform Skill</span>
                    <span className={hasSkill ? 'deploy-skill-ok' : 'deploy-skill-missing'}>{hasSkill ? 'loaded' : 'none'}</span>
                  </div>
                  {error && <div className="deploy-error">{error}</div>}

                  {/* Public Chat API URL */}
                  {(() => {
                    let chatUrl = null;
                    if (platform === 'relay' && config.slug) {
                      const relayBase = (config.relayUrl || 'wss://streetai.org').replace(/^ws/, 'http').replace(/\/$/, '');
                      chatUrl = `${relayBase}/a/${config.slug}/chat`;
                    } else if (platform === 'http' && config.port) {
                      chatUrl = `http://localhost:${config.port}/chat`;
                    }
                    if (!chatUrl) return null;
                    return (
                      <div style={{ marginTop: 10, padding: '10px 12px', background: 'var(--bg-secondary)', borderRadius: 8, border: '1px solid var(--border)' }}>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                          {platform === 'relay' ? 'Public' : 'Local'} Chat API
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <code style={{ flex: 1, fontSize: 12, wordBreak: 'break-all', color: 'var(--text)' }}>{chatUrl}</code>
                          <button className="btn btn-sm" onClick={(e) => {
                            navigator.clipboard.writeText(chatUrl);
                            const b = e.currentTarget;
                            b.textContent = 'Copied!';
                            setTimeout(() => { b.textContent = 'Copy'; }, 1500);
                          }}
                            style={{ flexShrink: 0 }}>Copy</button>
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                          {platform === 'relay'
                            ? 'Share this URL to let anyone chat with your agent. Embed it on a website, use it in another agent, or call it from any app.'
                            : 'Use this URL to chat with your agent locally. From your website, another agent, or any app on your network.'}
                        </div>
                      </div>
                    );
                  })()}
                </div>
                <div className="card-footer" style={{ display: 'flex', gap: 8 }}>
                  {isCli ? (
                    <span className="form-hint">Managed by CLI</span>
                  ) : platform === 'openclaw' ? (
                    <button className="btn btn-primary" onClick={() => connect('openclaw')} disabled={saving}>
                      {saving ? 'Exporting...' : connectSuccess === 'openclaw' ? 'Exported ✓' : 'Re-export'}
                    </button>
                  ) : isRunning ? (
                    <button className="btn btn-danger" onClick={() => stopPlatform(platform)} disabled={isActing}>
                      {isActing ? 'Stopping...' : 'Stop'}
                    </button>
                  ) : (
                    <button className="btn btn-primary" onClick={() => startPlatform(platform)} disabled={isActing}>
                      {isActing ? 'Starting...' : 'Start'}
                    </button>
                  )}
                  {platform === 'relay' && config.slug && (
                    <button className="btn btn-sm" onClick={() => {
                      setRelayResult(config);
                      setShowForm('relay');
                      setTimeout(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
                    }}>View URLs</button>
                  )}
                  {!isCli && !isRunning && (
                    <button className="btn btn-danger" onClick={() => setDisconnectConfirm(platform)} disabled={isActing}>Disconnect</button>
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
                  <span className="deploy-platform-icon" style={!meta.supported ? { opacity: 0.4 } : undefined}>{(() => { const pi = PLATFORM_ICONS[platform]; return pi ? <pi.Icon size={20} color={pi.color} /> : meta.label[0]; })()}</span>
                  <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>{meta.label} {meta.help && <HelpTooltip text={meta.help} />}</span>
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

                <div className="deploy-photo-row">
                  <div
                    className={`deploy-photo-upload ${truuzePhotoPreview ? 'deploy-photo-filled deploy-photo-clickable' : ''}`}
                    onClick={() => photoInputRef.current?.click()}
                    title={truuzePhotoPreview ? 'Click to change photo' : 'Click to upload agent photo'}
                  >
                    <input
                      ref={photoInputRef}
                      type="file"
                      accept="image/*"
                      onChange={handlePhotoUpload}
                      style={{ display: 'none' }}
                    />
                    {truuzePhotoPreview ? (
                      <img src={truuzePhotoPreview} alt="Agent" className="deploy-photo-img" />
                    ) : (
                      <span className="deploy-photo-placeholder">+</span>
                    )}
                  </div>
                  <div className="deploy-photo-meta">
                    <div className="deploy-photo-label">Agent photo</div>
                    <div className="deploy-photo-hint">PNG or JPG, up to 5MB. Optional.</div>
                    {truuzePhotoPreview && (
                      <button
                        type="button"
                        className="deploy-photo-remove-link"
                        onClick={removePhoto}
                      >Remove photo</button>
                    )}
                  </div>
                </div>

                <div className="form-group">
                  <label>Agent Name</label>
                  <input type="text" value={truuzeAgentName} onChange={e => setTruuzeAgentName(e.target.value)} className="form-input" placeholder="e.g. Atlas" />
                </div>
                <div className="form-group">
                  <label>Username</label>
                  <input type="text" value={truuzeUsername} onChange={e => setTruuzeUsername(e.target.value)} className="form-input" placeholder="my_agent" />
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

            <div style={{ marginTop: 12, padding: '10px 12px', background: 'var(--bg-secondary)', borderRadius: 8, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              <strong style={{ color: 'var(--text)' }}>How to get a skill from Truuze</strong>
              <p style={{ margin: '4px 0 0' }}>
                Go to <a href="https://app.truuze.com" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--blue)', textDecoration: 'underline' }}>app.truuze.com</a>, create an account, and open the <strong>AI Agents</strong> tab. Click <strong>Add New</strong> to generate a skill for a new agent.
              </p>
            </div>

            <div style={{ marginTop: 12, padding: '10px 12px', background: 'var(--bg-secondary)', borderRadius: 8, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              <strong style={{ color: 'var(--text)' }}>After connecting</strong>
              <p style={{ margin: '4px 0 0' }}>Click <strong>Start</strong> on the Truuze card to activate the connection. Your agent will begin checking for messages on Truuze once started.</p>
            </div>
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

            <div style={{ marginTop: 12, padding: '10px 12px', background: 'rgba(139, 92, 246, 0.08)', border: '1px solid rgba(139, 92, 246, 0.2)', borderRadius: 8, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              <strong style={{ color: '#8b5cf6' }}>Want to let people chat with your agent from a website or WhatsApp?</strong>
              <p style={{ margin: '4px 0 0' }}>Use <strong>Public Link (Relay)</strong> instead. It gives your agent a public URL on streetai.org and works from any computer — no server setup needed.</p>
              <p style={{ margin: '6px 0 0' }}>Alternatively, if you have your own public server (VPS, cloud), you can use this HTTP connector directly by pointing your domain to port <code>{httpPort || 3300}</code> with a reverse proxy.</p>
            </div>

            <div className="deploy-form-divider" />
            <h4 style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--text)' }}>Chat Widget</h4>
            <p className="form-hint" style={{ marginBottom: 8 }}>Add a chat interface to your website with one line. Paste this before the closing <code>&lt;/body&gt;</code> tag. Replace <code>your-server.com</code> with your actual server address:</p>
            <pre className="deploy-code-block">{`<script src="https://your-server.com/widget.js"
  data-agent="https://your-server.com"
  data-color="#2563eb"
  data-greeting="Hi! How can I help you today?"
></script>`}</pre>
            <p className="form-hint" style={{ marginTop: 8 }}>This adds a floating chat button in the bottom-right corner of your page.</p>
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
              <strong style={{ color: 'var(--text)' }}>Widget options:</strong>
              <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span><code>data-agent</code> &ndash; Your agent's public URL (required)</span>
                <span><code>data-title</code> &ndash; Header text shown at the top of the chat</span>
                <span><code>data-color</code> &ndash; Theme color (default: "#2563eb")</span>
                <span><code>data-position</code> &ndash; "right" or "left" (default: "right")</span>
                <span><code>data-greeting</code> &ndash; Welcome message shown before first message</span>
              </div>
            </div>

            <div className="deploy-form-divider" />
            <h4 style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--text)' }}>REST API</h4>
            <p className="form-hint" style={{ marginBottom: 8 }}>You can also integrate directly using the API. Send a message and get the agent's response:</p>
            <pre className="deploy-code-block">{`POST https://your-server.com/chat
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

            <div style={{ marginTop: 16, padding: '10px 12px', background: 'var(--bg-secondary)', borderRadius: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
              <strong style={{ color: 'var(--text)' }}>Available endpoints</strong>
              <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span><code>POST /chat</code> &ndash; Send a message, get the agent's response</span>
                <span><code>GET /health</code> &ndash; Check if the agent is running</span>
                <span><code>GET /info</code> &ndash; Get agent details (name, provider, status)</span>
                <span><code>GET /widget.js</code> &ndash; Embeddable chat widget script</span>
              </div>
            </div>

            <div style={{ marginTop: 12, padding: '10px 12px', background: 'var(--bg-secondary)', borderRadius: 8, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              <strong style={{ color: 'var(--text)' }}>Server setup</strong>
              <p style={{ margin: '4px 0 0' }}>On your server, use a reverse proxy (nginx, Caddy) to forward traffic from your domain to port <code>{httpPort || 3300}</code> with HTTPS. For testing, <code>http://localhost:{httpPort || 3300}</code> works from the same machine.</p>
            </div>

            <div style={{ marginTop: 12, padding: '10px 12px', background: 'var(--bg-secondary)', borderRadius: 8, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              <strong style={{ color: 'var(--text)' }}>After connecting</strong>
              <p style={{ margin: '4px 0 0' }}>Click <strong>Start</strong> on the HTTP API card to start the server. Your agent will begin listening on port <code>{httpPort || 3300}</code> once started.</p>
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
              <p style={{ margin: '0 0 8px' }}><strong>3.</strong> BotFather will give you a token. Paste it above and click <strong>Connect</strong></p>
              <p style={{ margin: '0 0 8px' }}><strong>4.</strong> Click <strong>Start</strong> on the Telegram card to activate the bot</p>
              <p style={{ margin: '0 0 8px' }}><strong>5.</strong> Users can then message your bot directly on Telegram</p>
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
              <p style={{ margin: '0 0 8px' }}><strong>1.</strong> Go to <a href="https://discord.com/developers/applications" target="_blank" rel="noopener" style={{ color: 'var(--blue)' }}>discord.com/developers/applications</a> and create a <strong>New Application</strong></p>
              <p style={{ margin: '0 0 8px' }}><strong>2.</strong> Go to the <strong>Bot</strong> tab → click <strong>Reset Token</strong> → copy the token and paste it above</p>
              <p style={{ margin: '0 0 8px' }}><strong>3.</strong> On the same page, scroll to <strong>Privileged Gateway Intents</strong> and enable <strong>Message Content Intent</strong></p>
              <p style={{ margin: '0 0 8px' }}><strong>4.</strong> Go to <strong>OAuth2</strong> tab → <strong>URL Generator</strong> → check the <strong>bot</strong> scope → then select these permissions: <strong>View Channels</strong>, <strong>Send Messages</strong>, <strong>Read Message History</strong></p>
              <p style={{ margin: '0 0 8px' }}><strong>5.</strong> Copy the generated URL at the bottom and open it in your browser to invite the bot to your server</p>
              <p style={{ margin: '0 0 8px' }}><strong>6.</strong> Click <strong>Connect</strong> above, then click <strong>Start</strong> on the Discord card</p>
              <p style={{ margin: '0 0 8px' }}><strong>7.</strong> Test it: DM the bot directly, or @mention it in any channel. In DMs, the bot responds to every message. In channels, it only responds when mentioned</p>
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
              <p style={{ margin: '0 0 8px' }}><strong>1.</strong> Go to <a href="https://api.slack.com/apps" target="_blank" rel="noopener" style={{ color: 'var(--blue)' }}>api.slack.com/apps</a> and click <strong>Create New App</strong> → <strong>From scratch</strong></p>
              <p style={{ margin: '0 0 8px' }}><strong>2.</strong> Go to <strong>Socket Mode</strong> → enable it → create an app-level token with <code>connections:write</code> scope → copy the <code>xapp-...</code> token</p>
              <p style={{ margin: '0 0 8px' }}><strong>3.</strong> Go to <strong>Event Subscriptions</strong> → enable events → under <strong>Subscribe to bot events</strong>, add: <code>message.im</code> and <code>app_mention</code></p>
              <p style={{ margin: '0 0 8px' }}><strong>4.</strong> Go to <strong>OAuth & Permissions</strong> → under <strong>Bot Token Scopes</strong>, add: <code>chat:write</code>, <code>im:history</code>, <code>app_mentions:read</code>, <code>files:write</code>, <code>files:read</code></p>
              <p style={{ margin: '0 0 8px' }}><strong>5.</strong> Click <strong>Install to {'{'}your workspace name{'}'}</strong> at the top of the OAuth page → authorize → copy the <code>xoxb-...</code> Bot User OAuth Token</p>
              <p style={{ margin: '0 0 8px' }}><strong>6.</strong> Paste both tokens above and click <strong>Connect</strong>, then click <strong>Start</strong> on the Slack card</p>
              <p style={{ margin: '0 0 8px' }}><strong>7.</strong> Test it: DM the bot directly, or invite it to a channel with <code>/invite @your-bot-name</code> and @mention it. In DMs, the bot responds to every message. In channels, it only responds when mentioned</p>
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
              <p className="form-hint">Any string you choose. Must match what you enter in Meta's webhook config</p>
            </div>
            <div className="form-group">
              <label>Webhook Port</label>
              <input type="number" value={waPort} onChange={e => setWaPort(e.target.value)} className="form-input" />
              <p className="form-hint">Local port for the webhook server. Only needed if running your own server, not needed with the Relay</p>
            </div>
            <div className="form-actions">
              <button className="btn btn-primary" onClick={() => connect('whatsapp')} disabled={saving}>{saving ? 'Connecting...' : 'Connect'}</button>
            </div>
            {formMsg && <p className="form-hint" style={{ color: 'var(--red)', marginTop: 8 }}>{formMsg}</p>}

            <div className="deploy-form-divider" />
            <h4 style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--text)' }}>Getting Your Credentials</h4>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
              <p style={{ margin: '0 0 8px' }}><strong>1.</strong> Go to <a href="https://developers.facebook.com" target="_blank" rel="noopener" style={{ color: 'var(--blue)' }}>developers.facebook.com</a> → <strong>My Apps</strong> → <strong>Create App</strong></p>
              <p style={{ margin: '0 0 8px' }}><strong>2.</strong> Choose <strong>Connect with customers through WhatsApp</strong> as the use case, then click <strong>Customize</strong></p>
              <p style={{ margin: '0 0 8px' }}><strong>3.</strong> Go to <strong>API Setup</strong>. You'll see a test phone number with a <strong>Phone Number ID</strong>. Copy it above.</p>
              <p style={{ margin: '0 0 8px' }}><strong>4.</strong> Copy the <strong>Temporary Access Token</strong> from the same page (lasts 24h). For production, create a System User token under Business Settings → Users → System Users</p>
              <p style={{ margin: '0 0 8px' }}><strong>5.</strong> The <strong>Verify Token</strong> is any string you make up. You'll enter the same string in Meta's webhook config</p>
            </div>

            <div className="deploy-form-divider" />
            <h4 style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--text)' }}>Receiving Messages</h4>
            <p className="form-hint" style={{ marginBottom: 8 }}>Meta needs a public URL to send you incoming messages. Choose one of these options:</p>

            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
              <div style={{ padding: '10px 12px', background: 'rgba(139, 92, 246, 0.08)', border: '1px solid rgba(139, 92, 246, 0.2)', borderRadius: 8, marginBottom: 10 }}>
                <strong style={{ color: '#8b5cf6' }}>Option A: Use Public Link / Relay (recommended)</strong>
                <p style={{ margin: '4px 0 0' }}>No public server needed. Works from any laptop or home computer.</p>
                <div style={{ margin: '8px 0', padding: '8px 10px', background: 'rgba(139, 92, 246, 0.06)', borderRadius: 6 }}>
                  <p style={{ margin: '0 0 4px', fontWeight: 500, color: 'var(--text)' }}>Steps:</p>
                  <p style={{ margin: '0 0 4px' }}><strong>1.</strong> Save your WhatsApp credentials above first (click Connect)</p>
                  <p style={{ margin: '0 0 4px' }}><strong>2.</strong> Go to <strong>Public Link (Relay)</strong> and connect. It will automatically configure WhatsApp routing</p>
                  <p style={{ margin: '0 0 4px' }}><strong>3.</strong> Note your slug from the relay card (e.g. <code>my-travel-agent</code>)</p>
                  <p style={{ margin: '0 0 4px' }}><strong>4.</strong> In Meta's dashboard: <strong>WhatsApp</strong> → <strong>Configuration</strong> → set the webhook URL to:</p>
                </div>
                <pre className="deploy-code-block" style={{ margin: '6px 0 4px' }}>{`https://streetai.org/wh/<your-slug>/webhook`}</pre>
                <p style={{ margin: '2px 0 0' }}>Replace <code>&lt;your-slug&gt;</code> with the slug from step 3. Use the same <strong>Verify Token</strong> you entered above. Subscribe to the <code>messages</code> field.</p>
                <div style={{ margin: '8px 0 0', padding: '8px 10px', background: 'rgba(139, 92, 246, 0.06)', borderRadius: 6 }}>
                  <p style={{ margin: '0 0 4px' }}><strong>5.</strong> Click <strong>Start</strong> on the Public Link (Relay) card to start the connection</p>
                  <p style={{ margin: '0' }}><strong>6.</strong> Send a test message (see Testing below)</p>
                </div>
              </div>

              <div style={{ padding: '10px 12px', background: 'var(--bg-secondary)', borderRadius: 8 }}>
                <strong style={{ color: 'var(--text)' }}>Option B: Your own server</strong>
                <p style={{ margin: '4px 0 0' }}>If your agent runs on a VPS or cloud server with a domain:</p>
                <div style={{ margin: '8px 0', padding: '8px 10px', background: 'var(--bg-surface)', borderRadius: 6 }}>
                  <p style={{ margin: '0 0 4px' }}><strong>1.</strong> Set the webhook URL in Meta to:</p>
                </div>
                <pre className="deploy-code-block" style={{ margin: '6px 0 4px' }}>{`https://your-domain.com/webhook`}</pre>
                <div style={{ margin: '4px 0 0', padding: '8px 10px', background: 'var(--bg-surface)', borderRadius: 6 }}>
                  <p style={{ margin: '0 0 4px' }}><strong>2.</strong> Use a reverse proxy (nginx, Caddy) to forward HTTPS traffic to port <code>{waPort || 3301}</code></p>
                  <p style={{ margin: '0 0 4px' }}><strong>3.</strong> Click <strong>Start</strong> on the WhatsApp card to start the webhook server</p>
                  <p style={{ margin: '0' }}><strong>4.</strong> In Meta: click <strong>Verify and Save</strong>, then subscribe to the <code>messages</code> field</p>
                </div>
              </div>

              <p style={{ margin: '10px 0 4px', color: 'var(--text)', fontWeight: 500 }}>Testing:</p>
              <p style={{ margin: '0' }}>Meta gives you a test number. Add your phone as a recipient in <strong>API Setup</strong> → <strong>To</strong> field. Send a WhatsApp message from your phone to the test number. You should see the agent reply.</p>
            </div>
          </div>
        </div>
      )}

      {showForm === 'relay' && (
        <div ref={formRef} className="card deploy-form-card">
          <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>Connect Public Link (Relay)</span>
            <button className="btn btn-sm" onClick={() => { setShowForm(null); setRelayResult(null); }}>Cancel</button>
          </div>
          <div className="card-body">
            <p className="form-hint" style={{ marginBottom: 12 }}>Running on a laptop or home computer? The relay is for you. It gives your agent a public URL on streetai.org so people can chat with it from any website and WhatsApp can deliver messages to it. No need to open ports or set up a server.</p>

            {!relayResult ? (
              <>
                <div className="form-group">
                  <label>Agent Name</label>
                  <input type="text" value={relayName} onChange={e => setRelayName(e.target.value)} className="form-input" placeholder="My Travel Agent" />
                  <p className="form-hint">Used to generate your agent's public URL slug</p>
                </div>
                <div className="form-actions">
                  <button className="btn btn-primary" onClick={() => connect('relay')} disabled={saving}>{saving ? 'Registering...' : 'Connect to Relay'}</button>
                </div>
                {formMsg && <p className="form-hint" style={{ color: 'var(--red)', marginTop: 8 }}>{formMsg}</p>}
              </>
            ) : (
              <div style={{ padding: '14px 16px', background: 'rgba(16, 185, 129, 0.08)', border: '1px solid rgba(16, 185, 129, 0.2)', borderRadius: 8, marginBottom: 16 }}>
                <p style={{ margin: 0, fontSize: 13, color: '#10b981', fontWeight: 600 }}>Connected as: {relayResult.slug}</p>
              </div>
            )}

            <div className="deploy-form-divider" />
            <h4 style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--text)' }}>How It Works</h4>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
              <p style={{ margin: '0 0 8px' }}><strong>1.</strong> Enter your agent's name above and click <strong>Connect to Relay</strong>. You'll get a unique URL</p>
              <p style={{ margin: '0 0 8px' }}><strong>2.</strong> Click <strong>Start</strong> on the relay card. Your agent connects out to streetai.org (no incoming ports needed)</p>
              <p style={{ margin: '0 0 8px' }}><strong>3.</strong> When someone sends a message through the chat widget or WhatsApp, streetai.org forwards it to your agent through the existing connection, and returns the agent's reply</p>
            </div>

            {relayResult ? (
              <>
                <div className="deploy-form-divider" />
                <h4 style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--text)' }}>Chat Widget</h4>
                <p className="form-hint" style={{ marginBottom: 8 }}>Add a chat interface to any website. Paste this before the closing <code>&lt;/body&gt;</code> tag:</p>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
                  <pre className="deploy-code-block">{`<script src="https://streetai.org/a/${relayResult.slug}/widget.js"
  data-agent="https://streetai.org/a/${relayResult.slug}"
  data-color="#2563eb"
  data-greeting="Hi! How can I help you today?"
></script>`}</pre>
                  <p style={{ margin: '8px 0 0' }}>This adds a floating chat button in the bottom-right corner. Your visitors chat through streetai.org, which forwards messages to your agent.</p>
                  <div style={{ marginTop: 8 }}>
                    <strong style={{ color: 'var(--text)' }}>Widget options:</strong>
                    <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span><code>data-agent</code> &ndash; Your agent's public URL (required)</span>
                      <span><code>data-title</code> &ndash; Header text shown at the top of the chat</span>
                      <span><code>data-color</code> &ndash; Theme color (default: "#2563eb")</span>
                      <span><code>data-position</code> &ndash; "right" or "left" (default: "right")</span>
                      <span><code>data-greeting</code> &ndash; Welcome message shown before first message</span>
                    </div>
                  </div>
                </div>

                <div className="deploy-form-divider" />
                <h4 style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--text)' }}>WhatsApp (optional)</h4>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
                  <p style={{ margin: '0 0 8px' }}>Want WhatsApp too? Follow these steps:</p>
                  <p style={{ margin: '0 0 4px' }}><strong>1.</strong> Save your <strong>WhatsApp</strong> credentials first (Access Token, Phone Number ID, Verify Token)</p>
                  <p style={{ margin: '0 0 4px' }}><strong>2.</strong> Then connect the relay above. It will automatically configure WhatsApp routing</p>
                  <p style={{ margin: '0 0 4px' }}><strong>3.</strong> In Meta's dashboard (<strong>WhatsApp → Configuration</strong>), set the webhook URL to:</p>
                  <pre className="deploy-code-block" style={{ margin: '6px 0 6px' }}>{`https://streetai.org/wh/${relayResult.slug}/webhook`}</pre>
                  <p style={{ margin: '0 0 4px' }}><strong>4.</strong> Use the same <strong>Verify Token</strong> you entered in the WhatsApp form. Subscribe to the <code>messages</code> field</p>
                  <p style={{ margin: '0 0 4px' }}><strong>5.</strong> Click <strong>Start</strong> on the Public Link (Relay) card</p>
                  <p style={{ margin: '0 0 4px' }}><strong>6.</strong> Test by sending a WhatsApp message to your test number</p>
                  <p style={{ margin: '10px 0 0', color: 'var(--yellow)' }}><strong>Important:</strong> WhatsApp credentials must be saved before connecting the relay so the webhook can be configured automatically.</p>
                </div>

                <div className="deploy-form-divider" />
                <h4 style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--text)' }}>REST API</h4>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
                  <p style={{ margin: '0 0 8px' }}>For custom integrations, you can also call the agent directly:</p>
                  <pre className="deploy-code-block">{`POST https://streetai.org/a/${relayResult.slug}/chat
Content-Type: application/json

{
  "message": "Hello, what services do you offer?",
  "userId": "user_123",
  "userName": "John"
}`}</pre>
                  <p style={{ margin: '8px 0 4px' }}>Response:</p>
                  <pre className="deploy-code-block">{`{
  "response": "Hi! Here's what I can help with...",
  "toolsUsed": [],
  "tokensUsed": 120
}`}</pre>
                </div>
              </>
            ) : (
              <>
                <div className="deploy-form-divider" />
                <p className="form-hint" style={{ margin: 0, fontStyle: 'italic' }}>Connect the relay above to get your chat widget snippet, WhatsApp webhook URL, and REST API endpoint — each filled in with your unique slug, ready to copy.</p>
              </>
            )}
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
            <p className="form-hint">Export this workspace as an OpenClaw workspace at <code>~/.openclaw/workspace-&lt;agent-id&gt;/</code>. OpenClaw will then run the agent from there using its own runtime and sandbox.</p>
            <div className="form-actions">
              <button className="btn btn-primary" onClick={() => connect('openclaw')} disabled={saving}>{saving ? 'Exporting...' : 'Export to OpenClaw'}</button>
            </div>
            {formMsg && <p className="form-hint" style={{ color: 'var(--red)', marginTop: 8 }}>{formMsg}</p>}

            <div className="deploy-form-divider" />
            <h4 style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--text)' }}>How it works</h4>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
              <p style={{ margin: '0 0 8px' }}>OpenClaw is different from the other connectors. It does not stream messages in and out of the running aaas agent. Instead, this exports a snapshot of your workspace (SKILL.md, SOUL.md, data, extensions, memory, transactions) into OpenClaw's workspace directory on this machine. OpenClaw then owns execution from that point on.</p>
              <p style={{ margin: '0 0 8px' }}><strong>Prerequisite:</strong> OpenClaw must be installed on this machine. The export goes to <code>~/.openclaw/</code>.</p>
              <p style={{ margin: '0 0 8px' }}><strong>One-shot, not live sync:</strong> This is a snapshot. If you later edit SKILL.md or add files here, click <strong>Export to OpenClaw</strong> again to push the updates.</p>
              <p style={{ margin: '0 0 8px' }}><strong>No Start needed:</strong> There is no runtime loop on the aaas side for OpenClaw. Once exported, open OpenClaw to run the agent.</p>
            </div>
          </div>
        </div>
      )}

      {disconnectConfirm && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setDisconnectConfirm(null)}>
          <div className="card" style={{ maxWidth: 420, width: '90%' }} onClick={(e) => e.stopPropagation()}>
            <div className="card-header">Disconnect?</div>
            <div className="card-body">
              <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--text)' }}>
                Disconnect from <strong>{PLATFORM_META[disconnectConfirm]?.label || disconnectConfirm}</strong>? Your agent will stop receiving messages from this platform.
              </p>
              <div className="form-actions" style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-danger" onClick={() => { const p = disconnectConfirm; setDisconnectConfirm(null); disconnect(p); }}>Disconnect</button>
                <button className="btn" onClick={() => setDisconnectConfirm(null)}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
