import React, { useState } from 'react';
import { useFetch } from '../hooks/useApi.js';

const STATUSES = ['all', 'pending', 'exploring', 'proposed', 'accepted', 'in_progress', 'delivered', 'completed', 'disputed', 'cancelled'];

export default function Transactions() {
  const [filter, setFilter] = useState('all');
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState(null);

  const url = `/api/transactions?all=${showAll}${filter !== 'all' ? `&status=${filter}` : ''}`;
  const { data: txns, loading, error } = useFetch(url);
  const { data: stats } = useFetch('/api/transactions-stats');

  const cur = stats?.currency || '';

  if (selected) {
    return <TransactionDetail id={selected} onBack={() => setSelected(null)} currency={cur} />;
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Transactions</h1>
        <p className="page-desc">Service delivery history and revenue</p>
      </div>

      {stats && (
        <div className="stat-grid">
          <div className="stat stat-green">
            <div className="stat-label">Revenue</div>
            <div className="stat-value green">{cur}{stats.revenue}</div>
          </div>
          <div className="stat stat-green">
            <div className="stat-label">Completed</div>
            <div className="stat-value green">{stats.completed}</div>
          </div>
          <div className="stat stat-accent">
            <div className="stat-label">Active</div>
            <div className="stat-value accent">{stats.active}</div>
          </div>
          <div className="stat stat-yellow">
            <div className="stat-label">Avg Rating</div>
            <div className="stat-value yellow">{stats.avgRating ?? '—'}</div>
          </div>
        </div>
      )}

      <div className="btn-group" style={{ flexWrap: 'wrap' }}>
        {STATUSES.map(s => (
          <button
            key={s}
            className={`btn ${filter === s ? 'btn-primary' : ''}`}
            onClick={() => setFilter(s)}
          >
            {s.replace(/_/g, ' ')}
          </button>
        ))}
        <button className="btn" onClick={() => setShowAll(!showAll)} style={{ marginLeft: 'auto' }}>
          {showAll ? 'Active only' : 'Show archived'}
        </button>
      </div>

      {loading && <div className="loading">Loading</div>}
      {error && <div className="empty">Error: {error}</div>}

      {!loading && txns && txns.length === 0 && (
        <div className="empty">No transactions match this filter</div>
      )}

      {!loading && txns && txns.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <table className="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Service</th>
                <th>User</th>
                <th>Status</th>
                <th>Cost</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {txns.map((t, i) => (
                <tr key={t.id || i} onClick={() => setSelected(t.id || t._file)} style={{ cursor: 'pointer' }}>
                  <td style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--text-muted)' }}>
                    {(t.id || t._file || '').slice(0, 8)}
                  </td>
                  <td>{t.service || '—'}</td>
                  <td>{t.user_name || t.user || t.client || '—'}</td>
                  <td><span className={`badge ${t.status}`}>{t.status?.replace(/_/g, ' ')}</span></td>
                  <td>{t.cost ? `${cur}${t.cost}` : 'Free'}</td>
                  <td style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                    {t.created_at ? new Date(t.created_at).toLocaleDateString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {stats?.byService && Object.keys(stats.byService).length > 0 && (
        <div className="card" style={{ marginTop: 16, padding: 0 }}>
          <div style={{ padding: '16px 18px 0' }}>
            <div className="card-title">Revenue by Service</div>
          </div>
          <table className="table">
            <thead>
              <tr><th>Service</th><th>Revenue</th></tr>
            </thead>
            <tbody>
              {Object.entries(stats.byService).map(([svc, rev]) => (
                <tr key={svc}>
                  <td>{svc}</td>
                  <td style={{ color: 'var(--green)', fontWeight: 600 }}>{cur}{rev}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function TransactionDetail({ id, onBack, currency: fallbackCurrency }) {
  const { data, loading, error } = useFetch(`/api/transactions/${id}`);

  if (loading) return <div className="loading">Loading transaction</div>;
  if (error) return <div className="empty">Error: {error}</div>;
  if (!data) return null;

  // Use the transaction's own currency, fall back to stats currency
  const currency = data.currency || fallbackCurrency;

  // Known fields to display structured, everything else goes in "Additional Details"
  const knownKeys = new Set([
    'id', 'user_id', 'user_name', 'service', 'cost', 'currency', 'status',
    'created_at', 'updated_at', 'completed_at', 'rating', 'notes',
    'details', 'items', 'sub_transactions', 'dispute', 'dispute_reason',
    'delivery', 'payment', '_file',
  ]);

  const extraFields = Object.entries(data).filter(([k]) => !knownKeys.has(k) && !k.startsWith('_'));

  // Build timeline events
  const timeline = [];
  if (data.created_at) timeline.push({ label: 'Created', time: data.created_at, color: 'var(--text-muted)' });
  if (data.updated_at && data.updated_at !== data.created_at) timeline.push({ label: 'Last Updated', time: data.updated_at, color: 'var(--accent)' });
  if (data.completed_at) timeline.push({ label: 'Completed', time: data.completed_at, color: 'var(--green)' });
  timeline.sort((a, b) => new Date(a.time) - new Date(b.time));

  return (
    <div>
      <div className="detail-header">
        <button className="btn-back" onClick={onBack}>&larr; Back</button>
        <h1 className="page-title" style={{ fontSize: 18 }}>
          {data.service || 'Transaction'}
        </h1>
        <span className={`badge ${data.status}`}>{data.status?.replace(/_/g, ' ')}</span>
      </div>

      {/* Key info cards */}
      <div className="stat-grid">
        <div className="stat">
          <div className="stat-label">Transaction ID</div>
          <div style={{ fontSize: 13, fontFamily: 'monospace', marginTop: 6, wordBreak: 'break-all' }}>{data.id || '—'}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Customer</div>
          <div style={{ fontSize: 16, fontWeight: 600, marginTop: 6 }}>{data.user_name || data.user_id || '—'}</div>
          {data.user_id && data.user_name && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>ID: {data.user_id}</div>
          )}
        </div>
        <div className="stat stat-green">
          <div className="stat-label">Cost</div>
          <div className="stat-value green">{data.cost ? `${currency}${data.cost}` : 'Free'}</div>
        </div>
        {data.rating && (
          <div className="stat stat-yellow">
            <div className="stat-label">Rating</div>
            <div className="stat-value yellow">{'★'.repeat(data.rating)}{'☆'.repeat(5 - data.rating)}</div>
          </div>
        )}
      </div>

      {/* Timeline */}
      {timeline.length > 0 && (
        <div className="card">
          <div className="card-title">Timeline</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 0' }}>
            {timeline.map((evt, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{
                  width: 10, height: 10, borderRadius: '50%',
                  background: evt.color, flexShrink: 0,
                }} />
                <div style={{ flex: 1 }}>
                  <span style={{ fontWeight: 500, fontSize: 13 }}>{evt.label}</span>
                  <span style={{ color: 'var(--text-muted)', fontSize: 12, marginLeft: 10 }}>{formatDate(evt.time)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Notes */}
      {data.notes && (
        <div className="card">
          <div className="card-title">Notes</div>
          <div style={{ fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{data.notes}</div>
        </div>
      )}

      {/* Items / Line items */}
      {data.items && Array.isArray(data.items) && data.items.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <div className="card-title" style={{ padding: '16px 18px 0' }}>Items</div>
          <table className="table">
            <thead>
              <tr>
                {Object.keys(data.items[0]).map(k => (
                  <th key={k}>{k.replace(/_/g, ' ')}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.items.map((item, i) => (
                <tr key={i}>
                  {Object.values(item).map((v, j) => (
                    <td key={j}>{typeof v === 'object' ? JSON.stringify(v) : String(v ?? '—')}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Sub-transactions (extension calls) */}
      {data.sub_transactions && Array.isArray(data.sub_transactions) && data.sub_transactions.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <div className="card-title" style={{ padding: '16px 18px 0' }}>Extension Calls</div>
          <table className="table">
            <thead>
              <tr>
                <th>Extension</th>
                <th>Service</th>
                <th>Status</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {data.sub_transactions.map((sub, i) => (
                <tr key={i}>
                  <td>{sub.extension || '—'}</td>
                  <td>{sub.service || '—'}</td>
                  <td><span className={`badge ${sub.status}`}>{sub.status || '—'}</span></td>
                  <td>{sub.cost ? `${currency}${sub.cost}` : 'Free'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Dispute */}
      {(data.dispute || data.dispute_reason) && (
        <div className="card" style={{ borderLeft: '3px solid var(--red)' }}>
          <div className="card-title" style={{ color: 'var(--red)' }}>Dispute</div>
          <div style={{ fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
            {data.dispute_reason || data.dispute || '—'}
          </div>
        </div>
      )}

      {/* Delivery info */}
      {data.delivery && typeof data.delivery === 'object' && (
        <div className="card">
          <div className="card-title">Delivery</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {Object.entries(data.delivery).map(([k, v]) => (
              <div key={k} style={{ display: 'flex', gap: 12, fontSize: 13 }}>
                <span style={{ fontWeight: 500, minWidth: 120, color: 'var(--text-secondary)' }}>{k.replace(/_/g, ' ')}</span>
                <span>{typeof v === 'object' ? JSON.stringify(v) : String(v ?? '—')}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Payment info */}
      {data.payment && typeof data.payment === 'object' && (
        <div className="card">
          <div className="card-title">Payment</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {Object.entries(data.payment).map(([k, v]) => (
              <div key={k} style={{ display: 'flex', gap: 12, fontSize: 13 }}>
                <span style={{ fontWeight: 500, minWidth: 120, color: 'var(--text-secondary)' }}>{k.replace(/_/g, ' ')}</span>
                <span style={{ fontFamily: k.includes('id') || k.includes('session') ? 'monospace' : 'inherit', fontSize: 12 }}>
                  {typeof v === 'object' ? JSON.stringify(v) : String(v ?? '—')}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Additional custom fields */}
      {extraFields.length > 0 && (
        <div className="card">
          <div className="card-title">Additional Details</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {extraFields.map(([k, v]) => (
              <div key={k} style={{ display: 'flex', gap: 12, fontSize: 13 }}>
                <span style={{ fontWeight: 500, minWidth: 140, color: 'var(--text-secondary)' }}>{k.replace(/_/g, ' ')}</span>
                <span style={{ wordBreak: 'break-word' }}>
                  {typeof v === 'object' ? (
                    <pre style={{ margin: 0, fontSize: 12, fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
                      {JSON.stringify(v, null, 2)}
                    </pre>
                  ) : String(v ?? '—')}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
