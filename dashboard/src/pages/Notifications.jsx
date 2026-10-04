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
  transaction_alerts: { enabled: false },
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
    transaction_alerts: { ...EMPTY.transaction_alerts, ...(loaded?.transaction_alerts || {}) },
    // Preserved as-is across per-channel saves. `routes` is edited by the
    // Routes section below; `route_field` (which transaction column supplies
    // the route) is a workspace-level setting with no UI — kept so a save here
    // never drops it.
    routes: (loaded && typeof loaded.routes === 'object' && loaded.routes) ? loaded.routes : {},
    ...(loaded?.route_field ? { route_field: loaded.route_field } : {}),
  };
}

// The Routes map {name: {telegram,whatsapp,email}} is edited as an ordered
// array of rows; convert both ways. Channel values are kept as plain strings
// (Telegram may be a comma-separated list — the backend splits it).
function routesObjToArr(obj) {
  return Object.entries(obj || {}).map(([name, v]) => ({
    name,
    telegram: Array.isArray(v?.telegram) ? v.telegram.join(', ') : (v?.telegram || ''),
    whatsapp: Array.isArray(v?.whatsapp) ? v.whatsapp.join(', ') : (v?.whatsapp || ''),
    email: Array.isArray(v?.email) ? v.email.join(', ') : (v?.email || ''),
  }));
}
function routesArrToObj(arr) {
  const o = {};
  for (const r of arr || []) {
    const name = (r.name || '').trim();
    if (!name) continue;
    const entry = {};
    if ((r.telegram || '').trim()) entry.telegram = r.telegram.trim();
    if ((r.whatsapp || '').trim()) entry.whatsapp = r.whatsapp.trim();
    if ((r.email || '').trim()) entry.email = r.email.trim();
    o[name] = entry;
  }
  return o;
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
  // Routes: edited as an ordered array; compared to the saved snapshot for dirty.
  const [routes, setRoutes] = useState([]);
  const [routesSaved, setRoutesSaved] = useState([]);
  const [savingRoutes, setSavingRoutes] = useState(false);
  const [removeRouteConfirm, setRemoveRouteConfirm] = useState(null); // index pending removal
  const [testingRoute, setTestingRoute] = useState(null);     // route name currently testing
  const [routeTestResult, setRouteTestResult] = useState(null); // { name, ok, msg }

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
      const routeRows = routesObjToArr(merged.routes);
      setRoutes(routeRows);
      setRoutesSaved(routeRows);
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

  // Transaction alerts: a single opt-in that rides on the channels enabled
  // below. Persists immediately like the per-channel On/Off switch.
  async function handleToggleTxnAlerts(val) {
    const previous = { form, saved };
    const next = { ...saved, transaction_alerts: { enabled: val } };
    setForm(f => ({ ...f, transaction_alerts: { enabled: val } }));
    setSaved(next);
    try {
      await put('/api/notifications', next);
    } catch (err) {
      setForm(previous.form);
      setSaved(previous.saved);
      alert('Could not update transaction alerts: ' + err.message);
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

  // ── Routes editing ──
  const routesDirty = JSON.stringify(routes) !== JSON.stringify(routesSaved);
  function addRoute() {
    setRoutes(rs => [...rs, { name: '', telegram: '', whatsapp: '', email: '' }]);
  }
  function setRouteField(idx, key, val) {
    setRoutes(rs => rs.map((r, i) => (i === idx ? { ...r, [key]: val } : r)));
  }
  function removeRoute(idx) {
    setRoutes(rs => rs.filter((_, i) => i !== idx));
  }
  async function saveRoutes() {
    // Guard: names must be non-empty and unique (they're the routing keys).
    const names = routes.map(r => (r.name || '').trim()).filter(Boolean);
    if (new Set(names).size !== names.length) {
      alert('Route names must be unique.');
      return false;
    }
    setSavingRoutes(true);
    try {
      const payload = { ...saved, routes: routesArrToObj(routes) };
      await put('/api/notifications', payload);
      setSaved(payload);
      setRoutesSaved(routes);
      setSavingRoutes(false);
      return true;
    } catch (err) {
      alert('Failed to save routes: ' + err.message);
      setSavingRoutes(false);
      return false;
    }
  }

  // Send a test to every destination the route defines. Save pending edits
  // first so the backend tests exactly what's on screen.
  async function handleTestRoute(i) {
    const name = (routes[i]?.name || '').trim();
    if (!name) { alert('Give the route a name first.'); return; }
    if (routesDirty) { const ok = await saveRoutes(); if (!ok) return; }
    setTestingRoute(name);
    setRouteTestResult(null);
    try {
      const result = await post('/api/notifications/test', { route: name });
      let msg;
      if (result.ok) {
        const n = result.sent?.length || 0;
        msg = `Sent to ${n} destination${n === 1 ? '' : 's'}.`;
      } else {
        const okCount = result.sent?.length || 0;
        const first = result.failed?.[0]?.error || result.error || 'Failed.';
        msg = `${okCount ? `${okCount} sent · ` : ''}${result.failed?.length || 0} failed: ${first}`;
      }
      setRouteTestResult({ name, ok: !!result.ok, msg });
    } catch (err) {
      setRouteTestResult({ name, ok: false, msg: err.message });
    }
    setTestingRoute(null);
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

        {/* ── Transaction alerts (rides on enabled channels below) ── */}
        <div className="card" style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>Transaction alerts</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
              Push every new and cancelled transaction to your phone, with Complete / Cancel buttons. Sent on the channels you've turned on below.
            </div>
          </div>
          <ToggleSwitch
            checked={!!form.transaction_alerts?.enabled}
            onChange={handleToggleTxnAlerts}
            label={form.transaction_alerts?.enabled ? 'On' : 'Off'}
          />
        </div>

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

        {/* ── Routes (optional) ── */}
        <div className="card" style={{ padding: '14px 18px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>
                Routes <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)' }}>(optional)</span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.6 }}>
                Named destinations your agent can send to instead of the defaults above — for example one per branch or team. Fill only the channels you want for each route. Telegram and Email accept several entries separated by commas. A notification with no route (or an unknown one) uses the defaults.
              </div>
            </div>
            <button
              onClick={addRoute}
              style={{
                padding: '6px 12px', borderRadius: 6, border: '1px solid var(--accent)',
                background: 'rgba(33,96,100,0.10)', color: 'var(--accent)',
                fontWeight: 600, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap',
              }}
            >
              + Add route
            </button>
          </div>

          {routes.length > 0 && (
            <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
              {routes.map((r, i) => (
                <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px' }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
                    <div style={{ flex: 1 }}>
                      <Field
                        label="Route name"
                        value={r.name}
                        onChange={(v) => setRouteField(i, 'name', v)}
                        placeholder="e.g. seef"
                      />
                    </div>
                    <button
                      onClick={() => handleTestRoute(i)}
                      disabled={testingRoute !== null || !(r.name || '').trim()}
                      title={!(r.name || '').trim() ? 'Name the route first' : 'Send a test to this route'}
                      style={{
                        padding: '6px 12px', borderRadius: 6,
                        border: '1px solid var(--accent)',
                        background: 'rgba(33,96,100,0.10)', color: 'var(--accent)',
                        fontWeight: 600, fontSize: 13, height: 36,
                        cursor: (testingRoute !== null || !(r.name || '').trim()) ? 'not-allowed' : 'pointer',
                        opacity: (testingRoute !== null || !(r.name || '').trim()) ? 0.5 : 1,
                        display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap',
                      }}
                    >
                      <span style={{ fontSize: 14, lineHeight: 1 }}>✈</span>
                      {testingRoute === (r.name || '').trim() ? 'Sending…' : 'Send test'}
                    </button>
                    <button
                      onClick={() => setRemoveRouteConfirm(i)}
                      style={{
                        padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border)',
                        background: 'transparent', color: 'var(--text-secondary)',
                        fontWeight: 600, fontSize: 13, cursor: 'pointer', height: 36,
                      }}
                    >
                      Remove
                    </button>
                  </div>
                  <div className="form-grid" style={{ marginTop: 8 }}>
                    <Field
                      label="TELEGRAM CHAT ID OR USERNAME"
                      value={r.telegram}
                      onChange={(v) => setRouteField(i, 'telegram', v)}
                      placeholder="-100123… or @name"
                    />
                    <Field
                      label="WhatsApp phone"
                      value={r.whatsapp}
                      onChange={(v) => setRouteField(i, 'whatsapp', v)}
                      placeholder="+9731234567"
                    />
                  </div>
                  <div className="form-grid" style={{ marginTop: 8 }}>
                    <Field
                      label="Email"
                      value={r.email}
                      onChange={(v) => setRouteField(i, 'email', v)}
                      placeholder="kitchen@example.com"
                    />
                  </div>
                  {routeTestResult && routeTestResult.name === (r.name || '').trim() && (
                    <div style={{
                      marginTop: 10, padding: '8px 12px', borderRadius: 6,
                      background: routeTestResult.ok ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
                      border: `1px solid ${routeTestResult.ok ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
                      fontSize: 12, color: routeTestResult.ok ? 'var(--green)' : 'var(--red)',
                      wordBreak: 'break-word',
                    }}>
                      {routeTestResult.ok ? '✓ ' : '✗ '}{routeTestResult.msg}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {routesDirty && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
              <button
                onClick={saveRoutes}
                disabled={savingRoutes}
                style={{
                  padding: '6px 14px', borderRadius: 6, border: '1px solid var(--border)',
                  background: 'var(--accent)', color: '#fff', fontWeight: 600, fontSize: 13,
                  cursor: savingRoutes ? 'not-allowed' : 'pointer',
                }}
              >
                {savingRoutes ? 'Saving…' : 'Save routes'}
              </button>
              <span style={{ fontSize: 12, color: '#b45309' }}>You have unsaved route changes.</span>
            </div>
          )}
        </div>

        <div style={{ marginTop: 20, padding: '12px 14px', background: 'var(--bg-secondary)', borderRadius: 8, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          <strong style={{ color: 'var(--text)' }}>How the agent uses these.</strong> The agent reaches out on its own when something needs your attention: a customer disputes a delivery, an external API is failing repeatedly, or a request looks unusual. It also sends an alert if it genuinely doesn't know how to handle a situation. Routine successes don't trigger alerts. You can use <code style={{ background: 'var(--bg-card)', padding: '0 4px', borderRadius: 3 }}>{'{{ENV_VAR}}'}</code> in any field above to keep secrets out of the config file.
        </div>
      </div>

      {removeRouteConfirm !== null && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setRemoveRouteConfirm(null)}>
          <div className="card" style={{ maxWidth: 420, width: '90%' }} onClick={(e) => e.stopPropagation()}>
            <div className="card-header">Remove route?</div>
            <div className="card-body">
              <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--text)' }}>
                Remove the route <strong>{(routes[removeRouteConfirm]?.name || '').trim() || 'this route'}</strong>? Notifications tagged with it will fall back to the default channels. Save to apply.
              </p>
              <div className="form-actions" style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-danger" onClick={() => { removeRoute(removeRouteConfirm); setRemoveRouteConfirm(null); }}>Remove</button>
                <button className="btn" onClick={() => setRemoveRouteConfirm(null)}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}
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
