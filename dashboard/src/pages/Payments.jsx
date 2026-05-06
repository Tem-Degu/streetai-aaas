import React, { useEffect, useState } from 'react';
import { useApi, useResolveUrl } from '../hooks/useApi.js';

const STATUS_TONES = {
  pending: '#9a8030',
  paid: '#1c7a44',
  expired: '#777',
  refunded: '#7a4a4a',
  cancelled: '#777',
};

function fmtMoney(amount, currency) {
  if (amount == null) return '—';
  const cur = (currency || 'usd').toUpperCase();
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format(amount);
  } catch {
    return `${amount} ${cur}`;
  }
}

function fmtDate(s) {
  if (!s) return '—';
  try { return new Date(s).toLocaleString(); } catch { return s; }
}

function StatusPill({ status }) {
  const color = STATUS_TONES[status] || '#777';
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 999,
      fontSize: 11, fontWeight: 600, color, border: `1px solid ${color}33`,
      backgroundColor: `${color}11`, textTransform: 'uppercase', letterSpacing: 0.4,
    }}>{status}</span>
  );
}

export default function Payments() {
  const { put, post, del } = useApi();
  const resolveUrl = useResolveUrl();

  const [conn, setConn] = useState(null);
  const [connForm, setConnForm] = useState({
    secret_key: '', currency: 'usd', min_amount: 0, max_amount: 0,
    success_url: '', cancel_url: '', expires_in_minutes: 1440,
  });
  const [savingConn, setSavingConn] = useState(false);
  const [connDirty, setConnDirty] = useState(false);
  const [connMsg, setConnMsg] = useState(null);

  const [payments, setPayments] = useState([]);
  const [paymentsLoading, setPaymentsLoading] = useState(true);
  const [refreshingId, setRefreshingId] = useState(null);
  const [filter, setFilter] = useState('all');
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [showMoreSettings, setShowMoreSettings] = useState(false);

  async function loadConn() {
    try {
      const res = await fetch(resolveUrl('/api/payments/connection'));
      const data = await res.json();
      setConn(data);
      setConnForm({
        secret_key: data.secretKeySet ? data.secret_key : '',
        currency: data.currency || 'usd',
        min_amount: data.min_amount || 0,
        max_amount: data.max_amount || 0,
        success_url: data.success_url || '',
        cancel_url: data.cancel_url || '',
        expires_in_minutes: data.expires_in_minutes || 1440,
      });
      setConnDirty(false);
      // Auto-open advanced settings if the user has already saved either URL,
      // so they can find them again without hunting for the disclosure.
      if (data.success_url || data.cancel_url) setShowMoreSettings(true);
    } catch { /* ignore */ }
  }

  async function loadPayments() {
    setPaymentsLoading(true);
    try {
      const res = await fetch(resolveUrl('/api/payments'));
      const data = await res.json();
      setPayments(data.payments || []);
    } catch { setPayments([]); }
    setPaymentsLoading(false);
  }

  useEffect(() => {
    loadConn();
    loadPayments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setConnField(key, val) {
    setConnForm(f => ({ ...f, [key]: val }));
    setConnDirty(true);
    setConnMsg(null);
  }

  async function handleSaveConn() {
    setSavingConn(true);
    setConnMsg(null);
    try {
      const payload = { ...connForm };
      // If field still shows the masked sentinel, leave it blank so the
      // backend keeps the existing key.
      if (payload.secret_key && payload.secret_key.includes('…')) payload.secret_key = '';
      const r = await put('/api/payments/connection', payload);
      setConnMsg({ ok: true, msg: `Saved (${r.mode || 'test'} mode).` });
      await loadConn();
    } catch (err) {
      setConnMsg({ ok: false, msg: err.message });
    }
    setSavingConn(false);
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      await del('/api/payments/connection');
      await loadConn();
      setConnMsg({ ok: true, msg: 'Disconnected.' });
      setShowDisconnectConfirm(false);
    } catch (err) {
      setConnMsg({ ok: false, msg: err.message });
    }
    setDisconnecting(false);
  }

  async function handleRefresh(paymentId) {
    setRefreshingId(paymentId);
    try {
      await post(`/api/payments/${paymentId}/refresh`, {});
      await loadPayments();
    } catch (err) {
      alert('Refresh failed: ' + err.message);
    }
    setRefreshingId(null);
  }

  const visible = filter === 'all' ? payments : payments.filter(p => p.status === filter);
  const isConnected = !!conn?.secretKeySet;
  const isLive = conn?.mode === 'live';

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Payments</h1>
        <p className="page-desc">
          Take payments from customers via Stripe Checkout. Money flows directly to your own Stripe account — your agent only generates the payment links and verifies status.
        </p>
      </div>

      {/* ── Stripe connection ── */}
      <div className="card" style={{ maxWidth: 720, marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Stripe connection</h2>
          {isConnected && (
            <span style={{
              padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600,
              color: isLive ? '#7a4a18' : '#1c7a44',
              border: `1px solid ${isLive ? '#7a4a1833' : '#1c7a4433'}`,
              backgroundColor: isLive ? '#7a4a1811' : '#1c7a4411',
              textTransform: 'uppercase', letterSpacing: 0.4,
            }}>{isLive ? 'Live mode' : 'Test mode'}</span>
          )}
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '0 0 14px' }}>
          Paste your Stripe secret key. Use a <code>sk_test_…</code> key while you set things up; switch to a <code>sk_live_…</code> key only when you are ready to take real money.
        </p>

        <Field
          label="Secret key *"
          hint={isConnected ? 'Replace by typing a new key. Leave the masked value to keep the existing key.' : 'Find this in your Stripe dashboard under Developers → API keys.'}
          value={connForm.secret_key}
          onChange={(v) => setConnField('secret_key', v)}
          placeholder="sk_test_..."
          type="password"
          mono
        />

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field
            label="Default currency"
            value={connForm.currency}
            onChange={(v) => setConnField('currency', v.toLowerCase())}
            placeholder="usd"
          />
          <Field
            label="Checkout link expires in (minutes)"
            type="number"
            value={connForm.expires_in_minutes}
            onChange={(v) => setConnField('expires_in_minutes', Number(v) || 0)}
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field
            label="Minimum amount (0 = no minimum)"
            type="number"
            value={connForm.min_amount}
            onChange={(v) => setConnField('min_amount', Number(v) || 0)}
          />
          <Field
            label="Maximum amount (0 = no maximum)"
            type="number"
            value={connForm.max_amount}
            onChange={(v) => setConnField('max_amount', Number(v) || 0)}
          />
        </div>

        {/*
         * Success/cancel URLs are pure browser-redirect polish — the agent
         * never reads them. Hide them behind a disclosure so the connection
         * card stays focused on what actually matters (key, currency,
         * bounds). Auto-open if either is already set so saved values stay
         * discoverable.
         */}
        <button
          type="button"
          onClick={() => setShowMoreSettings(s => !s)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '4px 0', marginTop: 4, marginBottom: 4,
            background: 'none', border: 'none',
            color: 'var(--text-muted)', fontSize: 13,
            cursor: 'pointer',
          }}
        >
          <span style={{
            display: 'inline-block', width: 10,
            transform: showMoreSettings ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 0.15s ease',
          }}>▶</span>
          More settings
        </button>

        {showMoreSettings && (
          <div style={{ marginTop: 8 }}>
            <Field
              label="Success URL"
              hint="Where Stripe sends customers after a successful payment."
              value={connForm.success_url}
              onChange={(v) => setConnField('success_url', v)}
              placeholder="https://yourdomain.com/thanks"
            />
            <Field
              label="Cancel URL"
              hint="Where Stripe sends customers who close or cancel checkout."
              value={connForm.cancel_url}
              onChange={(v) => setConnField('cancel_url', v)}
              placeholder="https://yourdomain.com/cancelled"
            />
          </div>
        )}

        {connMsg && (
          <div style={{
            padding: '8px 12px', borderRadius: 6, fontSize: 13, marginTop: 8,
            color: connMsg.ok ? '#1c7a44' : '#a83232',
            backgroundColor: connMsg.ok ? '#1c7a4411' : '#a8323211',
            border: `1px solid ${connMsg.ok ? '#1c7a4433' : '#a8323233'}`,
          }}>{connMsg.msg}</div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button
            className="btn btn-primary"
            onClick={handleSaveConn}
            disabled={savingConn || !connDirty || !connForm.secret_key}
          >
            {savingConn ? 'Saving…' : 'Save connection'}
          </button>
          {isConnected && (
            <button className="btn btn-secondary" onClick={() => setShowDisconnectConfirm(true)} disabled={savingConn}>
              Disconnect
            </button>
          )}
        </div>
      </div>

      {/* ── Payments list ── */}
      <div className="card" style={{ maxWidth: 1080 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Recent payments</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select
              className="input"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              style={{ width: 'auto', padding: '6px 10px', fontSize: 13 }}
            >
              <option value="all">All statuses</option>
              <option value="pending">Pending</option>
              <option value="paid">Paid</option>
              <option value="expired">Expired</option>
              <option value="refunded">Refunded</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <button className="btn btn-secondary" onClick={loadPayments} disabled={paymentsLoading}>
              {paymentsLoading ? 'Loading…' : 'Refresh list'}
            </button>
          </div>
        </div>

        {paymentsLoading ? (
          <div style={{ padding: 20, color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>
        ) : visible.length === 0 ? (
          <div style={{ padding: 20, color: 'var(--text-muted)', fontSize: 13 }}>
            {payments.length === 0
              ? 'No payments yet. When your agent takes its first payment, it will show up here.'
              : 'No payments match this filter.'}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                  <th style={{ padding: '8px 6px' }}>Status</th>
                  <th style={{ padding: '8px 6px' }}>Amount</th>
                  <th style={{ padding: '8px 6px' }}>Description</th>
                  <th style={{ padding: '8px 6px' }}>Customer</th>
                  <th style={{ padding: '8px 6px' }}>Transaction</th>
                  <th style={{ padding: '8px 6px' }}>Created</th>
                  <th style={{ padding: '8px 6px' }}></th>
                </tr>
              </thead>
              <tbody>
                {visible.map(p => (
                  <tr key={p.payment_id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 6px' }}><StatusPill status={p.status} /></td>
                    <td style={{ padding: '8px 6px', fontFamily: 'var(--font-mono)' }}>{fmtMoney(p.amount, p.currency)}</td>
                    <td style={{ padding: '8px 6px' }}>{p.description || '—'}</td>
                    <td style={{ padding: '8px 6px', color: 'var(--text-muted)' }}>
                      {p.session_user_name || p.customer_ref || '—'}
                    </td>
                    <td style={{ padding: '8px 6px', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{p.transaction_id || '—'}</td>
                    <td style={{ padding: '8px 6px', color: 'var(--text-muted)', fontSize: 12 }}>{fmtDate(p.created_at)}</td>
                    <td style={{ padding: '8px 6px', textAlign: 'right' }}>
                      {p.url && p.status === 'pending' && (
                        <a href={p.url} target="_blank" rel="noreferrer" style={{ marginRight: 8, fontSize: 12 }}>Open link</a>
                      )}
                      <button
                        className="btn-inline"
                        onClick={() => handleRefresh(p.payment_id)}
                        disabled={refreshingId === p.payment_id || !isConnected}
                        style={{ fontSize: 12 }}
                      >
                        {refreshingId === p.payment_id ? '…' : 'Refresh'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showDisconnectConfirm && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 100,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onClick={() => !disconnecting && setShowDisconnectConfirm(false)}
        >
          <div className="card" style={{ maxWidth: 420, width: '90%' }} onClick={(e) => e.stopPropagation()}>
            <div className="card-header">Disconnect Stripe?</div>
            <div className="card-body">
              <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--text)' }}>
                Your agent will stop being able to take new payments. Existing payment records stay in the ledger and you can reconnect at any time.
              </p>
              <div className="form-actions" style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-danger" onClick={handleDisconnect} disabled={disconnecting}>
                  {disconnecting ? 'Disconnecting…' : 'Disconnect'}
                </button>
                <button className="btn" onClick={() => setShowDisconnectConfirm(false)} disabled={disconnecting}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, hint, value, onChange, placeholder, type, disabled, mono }) {
  // Use the global .input class so dark-mode colors come from styles.css
  // (background: var(--bg-input), color: var(--text)) — inline styles bypass
  // the theme tokens and ended up rendering invisible text on dark.
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4, color: 'var(--text)' }}>{label}</label>
      <input
        className="input"
        type={type || 'text'}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        style={mono ? { fontFamily: 'var(--font-mono)' } : undefined}
      />
      {hint && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{hint}</div>}
    </div>
  );
}
