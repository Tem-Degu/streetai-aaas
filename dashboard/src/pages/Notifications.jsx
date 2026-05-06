import React, { useEffect, useState, useContext } from 'react';
import { Link } from 'react-router-dom';
import { useApi, useResolveUrl, WorkspaceContext } from '../hooks/useApi.js';

const EMPTY = {
  telegram: { enabled: true, chat_id: '' },
  whatsapp: { enabled: true, phone: '' },
  email: {
    enabled: true,
    to: '', from: '',
    smtp: { host: '', port: 587, secure: false, user: '', pass: '', passSet: false },
  },
};

function mergeConfig(loaded) {
  return {
    telegram: { ...EMPTY.telegram, ...(loaded?.telegram || {}) },
    whatsapp: { ...EMPTY.whatsapp, ...(loaded?.whatsapp || {}) },
    email: {
      ...EMPTY.email,
      ...(loaded?.email || {}),
      smtp: { ...EMPTY.email.smtp, ...(loaded?.email?.smtp || {}) },
    },
  };
}

// What counts as "this channel has the required fields to be useful."
function isChannelComplete(channel, data) {
  if (channel === 'telegram') return !!data?.chat_id?.trim();
  if (channel === 'whatsapp') return !!data?.phone?.trim();
  if (channel === 'email') {
    const s = data?.smtp || {};
    return !!(data?.to?.trim() && s.host?.trim() && s.user?.trim() && (s.pass?.trim() || s.passSet));
  }
  return false;
}

// Compare the live form section against the last-saved snapshot.
function isChannelDirty(channel, form, saved) {
  return JSON.stringify(form?.[channel] || {}) !== JSON.stringify(saved?.[channel] || {});
}

// Strip UI-only fields before sending to the backend.
function payloadForChannel(channel, channelForm) {
  if (channel === 'telegram') {
    return { enabled: channelForm.enabled, chat_id: channelForm.chat_id.trim() };
  }
  if (channel === 'whatsapp') {
    return { enabled: channelForm.enabled, phone: channelForm.phone.trim() };
  }
  if (channel === 'email') {
    return {
      enabled: channelForm.enabled,
      to: channelForm.to.trim(),
      from: channelForm.from.trim(),
      smtp: {
        host: channelForm.smtp.host.trim(),
        port: Number(channelForm.smtp.port) || 587,
        secure: !!channelForm.smtp.secure,
        user: channelForm.smtp.user.trim(),
        pass: channelForm.smtp.pass,
      },
    };
  }
  return channelForm;
}

export default function Notifications() {
  const { put, post } = useApi();
  const resolveUrl = useResolveUrl();
  const workspace = useContext(WorkspaceContext);
  const deployRoute = workspace ? `/ws/${workspace}/deploy` : '/deploy';
  const [form, setForm] = useState(mergeConfig(null));
  const [saved, setSaved] = useState(mergeConfig(null));
  const [loading, setLoading] = useState(true);
  const [savingChannel, setSavingChannel] = useState(null);
  const [savedAt, setSavedAt] = useState({});
  const [testing, setTesting] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [connections, setConnections] = useState([]);
  // Manual expand/collapse, fully decoupled from the enabled toggle.
  // Defaults: configured channels start collapsed, unconfigured start expanded.
  const [expanded, setExpanded] = useState({});

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(resolveUrl('/api/notifications')).then(r => r.json()),
      fetch(resolveUrl('/api/connections')).then(r => r.json()).catch(() => []),
    ]).then(([cfg, conns]) => {
      if (cancelled) return;
      const merged = mergeConfig(cfg);
      setForm(merged);
      setSaved(merged);
      setConnections(Array.isArray(conns) ? conns : []);
      // First-load expansion: anything already saved+complete starts collapsed,
      // anything not yet set up starts open so the user has somewhere to type.
      // Email is verbose enough to always start collapsed — owner can open it
      // when they want to deal with SMTP.
      setExpanded({
        telegram: !isChannelComplete('telegram', merged.telegram),
        whatsapp: !isChannelComplete('whatsapp', merged.whatsapp),
        email: false,
      });
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [resolveUrl]);

  const isConnected = (platform) =>
    connections.some(c => (c.platform || c.name) === platform);

  function toggleExpanded(channel) {
    setExpanded(e => ({ ...e, [channel]: !e[channel] }));
  }

  function setChannel(channel, key, val) {
    setForm(f => ({ ...f, [channel]: { ...f[channel], [key]: val } }));
  }
  function setSmtp(key, val) {
    setForm(f => ({
      ...f,
      email: { ...f.email, smtp: { ...f.email.smtp, [key]: val } },
    }));
  }

  // Toggling On/Off is a single-boolean change with no validation needed —
  // persist it right away so the owner doesn't have to chase a separate Save.
  // Field edits still require an explicit Save (incomplete config could
  // otherwise be saved with empty fields).
  async function handleToggleEnabled(channel, val) {
    // Persist ONLY the enabled flag — base on the last-saved snapshot so any
    // dirty field edits stay dirty and the user still chooses when to commit
    // them with Save.
    //
    // Update form AND saved optimistically together: if we only updated form,
    // there'd be a render window where form !== saved, briefly flashing the
    // dirty UI (Save button + "Unsaved changes" pill) until the PUT returns.
    const previousSaved = saved;
    const previousForm = form;
    const baseChannel = saved[channel] || {};
    const nextSaved = {
      ...saved,
      [channel]: { ...baseChannel, enabled: val },
    };
    setForm(f => ({ ...f, [channel]: { ...f[channel], enabled: val } }));
    setSaved(nextSaved);
    try {
      await put('/api/notifications', nextSaved);
      setSavedAt(prev => ({ ...prev, [channel]: new Date() }));
    } catch (err) {
      // Roll back both so UI matches reality.
      setForm(previousForm);
      setSaved(previousSaved);
      alert('Could not update channel: ' + err.message);
    }
  }

  async function handleSaveChannel(channel) {
    setSavingChannel(channel);
    try {
      // Backend accepts the full config; merge this channel's form into the
      // last-saved snapshot so other channels stay untouched even if their
      // form has unsaved edits.
      const payload = {
        ...saved,
        [channel]: payloadForChannel(channel, form[channel]),
      };
      await put('/api/notifications', payload);
      setSaved(payload);
      setSavedAt(prev => ({ ...prev, [channel]: new Date() }));
    } catch (err) {
      alert('Failed to save: ' + err.message);
    }
    setSavingChannel(null);
  }

  async function handleTest(channel) {
    // If there are unsaved changes for this channel, save first so the test
    // exercises what the user actually sees on screen.
    if (isChannelDirty(channel, form, saved)) {
      await handleSaveChannel(channel);
    }
    setTesting(channel);
    setTestResult(null);
    try {
      const result = await post('/api/notifications/test', { channel });
      setTestResult({ channel, ok: result.ok, msg: result.ok ? `Sent on ${channel}.` : (result.error || 'Failed.') });
    } catch (err) {
      setTestResult({ channel, ok: false, msg: err.message });
    }
    setTesting(null);
  }

  if (loading) return <div className="loading">Loading notifications</div>;

  const cardCommon = (channel) => {
    const dirty = isChannelDirty(channel, form, saved);
    // Unsaved edits force the card open — never hide them behind a collapse.
    const isOpen = dirty || !!expanded[channel];
    return {
      enabled: form[channel].enabled,
      onToggle: (v) => handleToggleEnabled(channel, v),
      dirty,
      complete: isChannelComplete(channel, form[channel]),
      configured: isChannelComplete(channel, saved[channel]),
      saving: savingChannel === channel,
      savedAt: savedAt[channel],
      testing: testing === channel,
      testResult: testResult?.channel === channel ? testResult : null,
      onSave: () => handleSaveChannel(channel),
      onTest: () => handleTest(channel),
      open: isOpen,
      // When dirty, lock the chevron — the card shouldn't collapse and hide unsaved edits.
      onToggleOpen: dirty ? null : () => toggleExpanded(channel),
    };
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Notifications</h1>
        <p className="page-desc">
          When something needs your attention, your agent reaches out on these channels. Set up at least one so you can leave the agent running unattended.
        </p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 720 }}>

        {/* ── Telegram ── */}
        <ChannelCard
          title="Telegram"
          subtitle="Instant messages to your phone via your Telegram bot."
          ready={isConnected('telegram')}
          notReadyMsg="A Telegram bot must be connected first. Add one in the Deploy tab."
          notReadyLink={deployRoute}
          {...cardCommon('telegram')}
        >
          <Field
            label="Your Telegram username or chat ID *"
            hint="Use your @username (e.g. @tommy_0828) or your numeric chat ID. Either way, you must DM your bot once first, since Telegram bots cannot start chats. After your first message to the bot, your chat ID is captured automatically and the username keeps working from there on."
            value={form.telegram.chat_id}
            onChange={(v) => setChannel('telegram', 'chat_id', v)}
            placeholder="@yourname or 123456789"
          />
        </ChannelCard>

        {/* ── WhatsApp ── */}
        <ChannelCard
          title="WhatsApp"
          subtitle="Messages to your WhatsApp via your WhatsApp Business connection."
          ready={isConnected('whatsapp')}
          notReadyMsg="WhatsApp must be connected first. Add it in the Deploy tab."
          notReadyLink={deployRoute}
          {...cardCommon('whatsapp')}
        >
          <Field
            label="Your WhatsApp phone number *"
            hint="Include country code, no spaces. WhatsApp only allows free-form messages within 24 hours of your last message to the agent. Text the agent first to keep the window open, or set up an approved template with Meta."
            value={form.whatsapp.phone}
            onChange={(v) => setChannel('whatsapp', 'phone', v)}
            placeholder="+15551234567"
          />
        </ChannelCard>

        {/* ── Email ── */}
        <ChannelCard
          title="Email"
          subtitle="Email alerts via SMTP. Works with any provider (Gmail, custom domain, transactional services)."
          ready={true}
          {...cardCommon('email')}
        >
          <div className="form-grid">
            <Field
              label="Send to *"
              value={form.email.to}
              onChange={(v) => setChannel('email', 'to', v)}
              placeholder="you@example.com"
            />
            <Field
              label="Send from"
              hint="Leave blank to use the same address."
              value={form.email.from}
              onChange={(v) => setChannel('email', 'from', v)}
              placeholder="agent@example.com"
            />
          </div>

          <div style={{ marginTop: 12, padding: '12px 14px', background: 'var(--bg-secondary)', borderRadius: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>SMTP server</div>
            <div className="form-grid">
              <Field
                label="Host *"
                hint="For Gmail use smtp.gmail.com"
                value={form.email.smtp.host}
                onChange={(v) => setSmtp('host', v)}
                placeholder="smtp.example.com"
              />
              <Field
                label="Port"
                hint="587 for STARTTLS, 465 for SSL"
                value={String(form.email.smtp.port)}
                onChange={(v) => setSmtp('port', v)}
                placeholder="587"
              />
            </div>
            <div className="form-grid" style={{ marginTop: 8 }}>
              <Field
                label="Username *"
                value={form.email.smtp.user}
                onChange={(v) => setSmtp('user', v)}
                placeholder="usually your full email"
              />
              <Field
                label="Password *"
                hint="For Gmail, use an App Password (not your account password). Or paste {{ENV_VAR}} to read from an env variable."
                value={form.email.smtp.pass}
                onChange={(v) => setSmtp('pass', v)}
                placeholder={form.email.smtp.passSet ? '(unchanged)' : 'app password'}
                type="password"
              />
            </div>
            <label style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
              <input
                type="checkbox"
                checked={!!form.email.smtp.secure}
                onChange={(e) => setSmtp('secure', e.target.checked)}
              />
              Use SSL (port 465). Most providers want STARTTLS on 587, so leave this off.
            </label>
          </div>
        </ChannelCard>

        <div style={{ marginTop: 20, padding: '12px 14px', background: 'var(--bg-secondary)', borderRadius: 8, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          <strong style={{ color: 'var(--text)' }}>How the agent uses these.</strong> The agent reaches out on its own when something needs your attention: a customer disputes a delivery, an external API is failing repeatedly, or a request looks unusual. It also sends an alert if it genuinely doesn't know how to handle a situation. Routine successes don't trigger alerts. You can use <code style={{ background: 'var(--bg-card)', padding: '0 4px', borderRadius: 3 }}>{'{{ENV_VAR}}'}</code> in any field above to keep secrets out of the config file.
        </div>
      </div>
    </div>
  );
}

function StatusPill({ ready, configured, enabled, dirty }) {
  // One pill, picked by precedence: unsaved > setup needed > configured-on > configured-off > not configured.
  // This keeps the header scannable instead of stacking three pills.
  let label, bg, fg;
  if (!ready) { label = 'Setup needed'; bg = 'rgba(234,179,8,0.12)'; fg = '#b45309'; }
  else if (dirty) { label = '⚠ Unsaved changes'; bg = 'rgba(234,179,8,0.15)'; fg = '#b45309'; }
  else if (configured && enabled) { label = '✓ Active'; bg = 'rgba(34,197,94,0.12)'; fg = 'var(--green, #16a34a)'; }
  else if (configured && !enabled) { label = '✓ Configured · Off'; bg = 'rgba(120,120,120,0.14)'; fg = 'var(--text-secondary)'; }
  else { label = 'Not configured'; bg = 'rgba(120,120,120,0.10)'; fg = 'var(--text-secondary)'; }
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
      padding: '3px 10px', borderRadius: 100,
      background: bg, color: fg, textTransform: 'uppercase',
      whiteSpace: 'nowrap',
    }}>{label}</span>
  );
}

function ToggleSwitch({ checked, onChange, disabled, label }) {
  // Compact pill switch — clearer than a checkbox for "is this channel on".
  // Sits in the header, far enough from the chevron that clicks don't collide.
  // Yellow/amber when on so the active-channel state is obvious at a glance,
  // even when scrolling past three cards.
  const onColor = '#eab308';   // amber-500
  const onBorder = '#ca8a04';  // amber-600
  return (
    <label
      onClick={(e) => e.stopPropagation()}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 8,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <span style={{
        fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
        color: checked ? onBorder : 'var(--text-secondary)',
        textTransform: 'uppercase',
      }}>{label}</span>
      <span
        onClick={() => !disabled && onChange(!checked)}
        style={{
          position: 'relative',
          width: 36, height: 20, borderRadius: 100,
          background: checked ? onColor : 'var(--bg-secondary)',
          border: `1px solid ${checked ? onBorder : 'var(--border)'}`,
          transition: 'background 0.15s ease, border-color 0.15s ease',
          flexShrink: 0,
          boxShadow: checked ? '0 0 0 3px rgba(234,179,8,0.15)' : 'none',
        }}
      >
        <span style={{
          position: 'absolute',
          top: 1, left: checked ? 17 : 1,
          width: 16, height: 16, borderRadius: 100,
          background: '#fff',
          boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
          transition: 'left 0.15s ease',
        }} />
      </span>
    </label>
  );
}

function ChannelCard({
  title, subtitle, ready, notReadyMsg, notReadyLink,
  enabled, onToggle, dirty, complete, configured,
  saving, savedAt, testing, testResult,
  onSave, onTest, children,
  open, onToggleOpen,
}) {
  const canSave = ready && dirty && complete && !saving;
  const canTest = ready && enabled && configured && !dirty && !testing;
  const headerClickable = !!onToggleOpen;

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      {/* ── Header ── */}
      <div
        onClick={headerClickable ? onToggleOpen : undefined}
        style={{
          display: 'flex', alignItems: 'center', gap: 14,
          padding: '14px 18px',
          cursor: headerClickable ? 'pointer' : 'default',
          userSelect: 'none',
        }}
      >
        {/* Chevron */}
        <span
          aria-hidden
          style={{
            display: 'inline-block',
            width: 14, textAlign: 'center',
            color: 'var(--text-secondary)',
            transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 0.15s ease',
            opacity: headerClickable ? 1 : 0.3,
            fontSize: 12,
          }}
        >
          ▶
        </span>

        {/* Title + subtitle + pill */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>{title}</span>
            <StatusPill ready={ready} configured={configured} enabled={enabled} dirty={dirty} />
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>{subtitle}</div>
        </div>

        {/* Enable/disable switch (only when channel is set up — toggling something that's not configured does nothing useful) */}
        {ready && (
          <ToggleSwitch
            checked={enabled}
            onChange={onToggle}
            label={enabled ? 'On' : 'Off'}
          />
        )}
      </div>

      {/* ── Setup-needed warning (always visible when applicable) ── */}
      {!ready && (
        <div style={{
          margin: '0 18px 14px',
          padding: '10px 12px',
          background: 'rgba(234,179,8,0.08)',
          border: '1px solid rgba(234,179,8,0.3)',
          borderRadius: 6,
          fontSize: 12,
          color: 'var(--text-secondary)',
        }}>
          ⚠ {notReadyMsg}
          {notReadyLink && <> <Link to={notReadyLink} style={{ color: 'var(--accent)' }}>Go to Deploy →</Link></>}
        </div>
      )}

      {/* ── Body (form + actions) — only visible when expanded and channel is ready ── */}
      {ready && open && (
        <div style={{
          padding: '0 18px 18px',
          borderTop: '1px solid var(--border)',
          paddingTop: 14,
        }}>
          {children}

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
            <button
              onClick={onSave}
              disabled={!canSave}
              title={!complete ? 'Fill required fields first' : (!dirty ? 'Nothing to save' : 'Save this channel')}
              style={{
                padding: '6px 14px', borderRadius: 6,
                border: '1px solid var(--border)',
                background: canSave ? 'var(--accent)' : 'var(--bg-secondary)',
                color: canSave ? '#fff' : 'var(--text-secondary)',
                fontWeight: 600, fontSize: 13,
                cursor: canSave ? 'pointer' : 'not-allowed',
                transition: 'all 0.15s ease',
              }}
            >
              {saving ? 'Saving…' : (dirty ? 'Save changes' : 'Save')}
            </button>
            <button
              onClick={onTest}
              disabled={!canTest}
              title={
                !configured ? 'Save the channel before testing' :
                dirty ? 'Save your changes before testing' :
                !enabled ? 'Turn the channel on to send a test' :
                'Send a test alert on this channel'
              }
              style={{
                padding: '6px 14px', borderRadius: 6,
                border: `1px solid ${canTest ? 'var(--accent)' : 'var(--border)'}`,
                background: canTest ? 'rgba(33,96,100,0.10)' : 'transparent',
                color: canTest ? 'var(--accent)' : 'var(--text-secondary)',
                fontWeight: 600, fontSize: 13,
                cursor: canTest ? 'pointer' : 'not-allowed',
                transition: 'all 0.15s ease',
                display: 'inline-flex', alignItems: 'center', gap: 6,
              }}
            >
              <span style={{ fontSize: 14, lineHeight: 1 }}>✈</span>
              {testing ? 'Sending…' : 'Send test'}
            </button>

            {dirty && (
              <span style={{ fontSize: 12, color: '#b45309', marginLeft: 'auto' }}>
                You have unsaved changes.
              </span>
            )}
            {!dirty && savedAt && !testResult && (
              <span style={{ fontSize: 12, color: 'var(--green, #16a34a)', marginLeft: 'auto' }}>
                ✓ Saved at {savedAt.toLocaleTimeString()}
              </span>
            )}
          </div>

          {testResult && (
            <div style={{
              marginTop: 12, padding: '8px 12px', borderRadius: 6,
              background: testResult.ok ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
              border: `1px solid ${testResult.ok ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
              fontSize: 12, color: testResult.ok ? 'var(--green)' : 'var(--red)',
              wordBreak: 'break-word',
            }}>
              {testResult.ok ? '✓ ' : '✗ '}{testResult.msg}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, hint, value, onChange, placeholder, type, disabled }) {
  return (
    <div className="form-field">
      <label className="form-label">{label}</label>
      <input
        className="input"
        type={type || 'text'}
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
      />
      {hint && <span className="form-hint">{hint}</span>}
    </div>
  );
}
