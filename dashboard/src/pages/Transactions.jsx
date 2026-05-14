import React, { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useFetch, useResolveUrl, useApi } from '../hooks/useApi.js';
import { getTableColumns, getLabel, formatCellWithConfig, prettyKey } from '../utils/transactionView.js';
import TransactionViewEditor from '../components/TransactionViewEditor.jsx';

/** Extract unique statuses from actual transaction data */
function getStatuses(txns) {
  if (!txns || txns.length === 0) return [];
  const seen = new Set();
  for (const t of txns) {
    if (t.status) seen.add(t.status);
  }
  return [...seen];
}

export default function Transactions() {
  const [filter, setFilter] = useState('all');
  const [showAll, setShowAll] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const selected = searchParams.get('id');
  const setSelected = (id) => {
    if (id) setSearchParams({ id });
    else setSearchParams({});
  };

  const [editorOpen, setEditorOpen] = useState(false);
  const url = `/api/transactions?all=${showAll}`;
  const { data: allTxns, loading, error, refetch: refetchTxns } = useFetch(url);
  const { data: stats, refetch: refetchStats } = useFetch('/api/transactions-stats');
  const { data: viewConfig, refetch: refetchView } = useFetch('/api/transaction-view');
  const api = useApi();

  // Optimistic archive state. While `pendingArchive` is set, the row is
  // hidden client-side; an undo banner lets the user revert before the
  // server change settles into the next refetch.
  const [pendingArchive, setPendingArchive] = useState(null); // { id, wasArchived }
  const undoTimerRef = useRef(null);
  useEffect(() => () => clearTimeout(undoTimerRef.current), []);

  const cur = stats?.currency || '';
  const statuses = getStatuses(allTxns);
  const visibleTxns = pendingArchive
    ? allTxns?.filter(t => (t.id || t._file) !== pendingArchive.id)
    : allTxns;
  const txns = filter === 'all' ? visibleTxns : visibleTxns?.filter(t => t.status === filter);
  const extraCols = getTableColumns(viewConfig, allTxns);

  // ── Pagination ──
  const PAGE_SIZE = 20;
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil((txns?.length || 0) / PAGE_SIZE));
  // Reset to page 1 whenever the filter / archive toggle changes the row set
  useEffect(() => { setPage(1); }, [filter, showAll]);
  // Clamp when the underlying list shrinks (e.g. after archiving the last row on a page)
  useEffect(() => { if (page > totalPages) setPage(totalPages); }, [page, totalPages]);
  const pageStart = (page - 1) * PAGE_SIZE;
  const pagedTxns = txns?.slice(pageStart, pageStart + PAGE_SIZE);

  const archiveTxn = async (txn, e) => {
    if (e) e.stopPropagation();
    const id = txn.id || txn._file;
    const wasArchived = txn.archived === true;
    setPendingArchive({ id, wasArchived });
    try {
      await api.post(`/api/transactions/${encodeURIComponent(id)}/${wasArchived ? 'unarchive' : 'archive'}`);
    } catch {
      setPendingArchive(null);
      refetchTxns();
      return;
    }
    clearTimeout(undoTimerRef.current);
    undoTimerRef.current = setTimeout(() => {
      setPendingArchive(null);
      refetchTxns();
      refetchStats();
    }, 5000);
  };

  const completeTxn = async (txn, e) => {
    if (e) e.stopPropagation();
    if (txn.status === 'completed') return;
    const id = txn.id || txn._file;
    try {
      await api.post(`/api/transactions/${encodeURIComponent(id)}/complete`);
    } catch { /* refetch will reveal the truth */ }
    refetchTxns();
    refetchStats();
  };

  const undoArchive = async () => {
    if (!pendingArchive) return;
    const { id, wasArchived } = pendingArchive;
    clearTimeout(undoTimerRef.current);
    setPendingArchive(null);
    try {
      await api.post(`/api/transactions/${encodeURIComponent(id)}/${wasArchived ? 'archive' : 'unarchive'}`);
    } catch { /* row will reappear on refetch regardless */ }
    refetchTxns();
    refetchStats();
  };

  if (selected) {
    return (
      <TransactionDetail
        id={selected}
        onBack={() => setSelected(null)}
        currency={cur}
        viewConfig={viewConfig}
        onArchived={(txn) => { setSelected(null); archiveTxn(txn); }}
        onCompleted={(txn) => completeTxn(txn)}
      />
    );
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
            <div className="stat-value green">{cur ? `${cur} ${stats.revenue}` : stats.revenue}</div>
          </div>
          <div className="stat stat-green">
            <div className="stat-label">Completed</div>
            <div className="stat-value green">{stats.completed}</div>
          </div>
          <div className="stat stat-accent">
            <div className="stat-label">Active</div>
            <div className="stat-value accent">{stats.active}</div>
          </div>
          <div className="stat stat-red">
            <div className="stat-label">Disputes</div>
            <div className="stat-value red">{stats.disputed || 0}</div>
          </div>
        </div>
      )}

      <div className="card" style={{ padding: 0, marginBottom: 14 }}>
        <button
          onClick={() => setEditorOpen(v => !v)}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '10px 14px', background: 'transparent', border: 'none', cursor: 'pointer',
            color: 'var(--text)', fontSize: 14, fontWeight: 500,
          }}
        >
          <span>Customize columns</span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{editorOpen ? '▾' : '▸'}</span>
        </button>
        {editorOpen && (
          <div style={{ borderTop: '1px solid var(--border)' }}>
            <TransactionViewEditor viewConfig={viewConfig} onSaved={refetchView} />
          </div>
        )}
      </div>

      <div className="btn-group" style={{ flexWrap: 'wrap' }}>
        {statuses.length > 0 && (
          <button
            className={`btn ${filter === 'all' ? 'btn-primary' : ''}`}
            onClick={() => setFilter('all')}
          >
            all
          </button>
        )}
        {statuses.map(s => (
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

      {pendingArchive && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 14px', marginBottom: 12,
          background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8,
          fontSize: 13,
        }}>
          <span>Transaction {pendingArchive.wasArchived ? 'unarchived' : 'archived'}.</span>
          <button
            onClick={undoArchive}
            style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}
          >
            Undo
          </button>
        </div>
      )}

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
                <th>Service</th>
                <th>User</th>
                <th>Status</th>
                {extraCols.map(k => (
                  <th key={k}>{getLabel(viewConfig, k)}</th>
                ))}
                <th>Cost</th>
                <th>Date</th>
                <th style={{ width: 76 }}></th>
              </tr>
            </thead>
            <tbody>
              {pagedTxns.map((t, i) => {
                const isArchived = t.archived === true;
                return (
                <tr key={t.id || i} onClick={() => setSelected(t.id || t._file)} style={{ cursor: 'pointer' }}>
                  <td>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      {t.service || ''}
                      {Array.isArray(t.files) && t.files.length > 0 && (
                        <span title={`${t.files.length} attached file${t.files.length > 1 ? 's' : ''}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: '#b91c1c', fontSize: 12, fontWeight: 600 }}>
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                          {t.files.length}
                        </span>
                      )}
                    </span>
                  </td>
                  <td>{t.user_name || t.user || t.client || ''}</td>
                  <td><span className={`badge ${t.status}`}>{t.status?.replace(/_/g, ' ')}</span></td>
                  {extraCols.map(k => (
                    <td key={k} style={{ fontSize: 13 }}>{formatCellWithConfig(t[k], k, viewConfig, cur)}</td>
                  ))}
                  <td>{t.cost ? `${cur} ${t.cost}` : 'Free'}</td>
                  <td style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                    {t.created_at ? new Date(t.created_at).toLocaleDateString() : ''}
                  </td>
                  <td onClick={e => e.stopPropagation()} style={{ textAlign: 'right', paddingRight: 10, whiteSpace: 'nowrap' }}>
                    {(() => {
                      const done = t.status === 'completed';
                      return (
                        <button
                          onClick={e => { if (!done) completeTxn(t, e); else e.stopPropagation(); }}
                          disabled={done}
                          title={done ? 'Already completed' : 'Mark as completed'}
                          style={{
                            background: 'none', border: 'none', padding: 4, marginRight: 4,
                            cursor: done ? 'default' : 'pointer',
                            color: done ? 'var(--green)' : 'var(--text-muted)',
                            display: 'inline-flex', alignItems: 'center',
                            opacity: done ? 0.55 : 0.85,
                          }}
                          onMouseEnter={e => { if (!done) e.currentTarget.style.opacity = 1; }}
                          onMouseLeave={e => { if (!done) e.currentTarget.style.opacity = 0.85; }}
                        >
                          {/* check-circle */}
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                        </button>
                      );
                    })()}
                    <button
                      onClick={e => archiveTxn(t, e)}
                      title={isArchived ? 'Unarchive — bring this transaction back to the active list' : 'Archive — hide this transaction from the active list'}
                      style={{
                        background: 'none', border: 'none', padding: 4, cursor: 'pointer',
                        color: isArchived ? 'var(--green)' : 'var(--red)',
                        display: 'inline-flex', alignItems: 'center', opacity: 0.85,
                      }}
                      onMouseEnter={e => e.currentTarget.style.opacity = 1}
                      onMouseLeave={e => e.currentTarget.style.opacity = 0.85}
                    >
                      {isArchived ? (
                        // unarchive — up arrow out of tray (green)
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><polyline points="9 7 12 4 15 7"/><line x1="12" y1="4" x2="12" y2="12"/></svg>
                      ) : (
                        // archive — down arrow into tray (red)
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><polyline points="15 9 12 12 9 9"/><line x1="12" y1="4" x2="12" y2="12"/></svg>
                      )}
                    </button>
                  </td>
                </tr>
              );})}
            </tbody>
          </table>
          {totalPages > 1 && (
            <Pagination
              page={page}
              totalPages={totalPages}
              total={txns.length}
              pageStart={pageStart}
              pageEnd={Math.min(pageStart + PAGE_SIZE, txns.length)}
              onChange={setPage}
            />
          )}
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
                  <td style={{ color: 'var(--green)', fontWeight: 600 }}>{cur ? `${cur} ${rev}` : rev}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Pagination ───────────────────────────────────

/**
 * Page number control with Prev / page buttons / Next, plus a "Showing X–Y
 * of N" label. Compacts the page list with ellipses when there are many
 * pages so the bar doesn't grow unbounded.
 */
function Pagination({ page, totalPages, total, pageStart, pageEnd, onChange }) {
  const items = buildPageItems(page, totalPages);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: 12, padding: '12px 14px', borderTop: '1px solid var(--border)', flexWrap: 'wrap',
    }}>
      <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
        Showing {pageStart + 1}–{pageEnd} of {total}
      </span>
      <div style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
        <button
          className="btn btn-sm"
          onClick={() => onChange(page - 1)}
          disabled={page <= 1}
          style={{ padding: '4px 10px' }}
        >
          ← Prev
        </button>
        {items.map((item, i) =>
          item === '…' ? (
            <span key={`gap-${i}`} style={{ padding: '0 6px', color: 'var(--text-muted)', fontSize: 13 }}>…</span>
          ) : (
            <button
              key={item}
              className={`btn btn-sm ${item === page ? 'btn-primary' : ''}`}
              onClick={() => onChange(item)}
              style={{ padding: '4px 10px', minWidth: 32 }}
            >
              {item}
            </button>
          )
        )}
        <button
          className="btn btn-sm"
          onClick={() => onChange(page + 1)}
          disabled={page >= totalPages}
          style={{ padding: '4px 10px' }}
        >
          Next →
        </button>
      </div>
    </div>
  );
}

/**
 * Build the visible page-button sequence with ellipses for compactness.
 * Always shows first and last; shows up to 2 neighbors on each side of the
 * current page. Examples:
 *   page=1,  total=7  → [1, 2, 3, 4, 5, '…', 7]
 *   page=4,  total=10 → [1, '…', 3, 4, 5, '…', 10]
 *   page=10, total=10 → [1, '…', 6, 7, 8, 9, 10]
 */
function buildPageItems(page, totalPages) {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const items = [];
  const add = (v) => { if (items[items.length - 1] !== v) items.push(v); };
  add(1);
  if (page > 3) add('…');
  for (let p = Math.max(2, page - 1); p <= Math.min(totalPages - 1, page + 1); p++) add(p);
  if (page < totalPages - 2) add('…');
  add(totalPages);
  return items;
}

// ─── Shared helpers ───────────────────────────────

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Format a value using the view config format hints */
function applyFormat(value, key, viewConfig, currency) {
  const fmt = viewConfig?.formats?.[key];
  if (fmt === 'currency' && value != null) return `${currency}${value}`;
  if (fmt === 'percentage' && value != null) return `${value}%`;
  if (fmt === 'rating' && value != null) return '★'.repeat(Math.min(Number(value) || 0, 5)) + '☆'.repeat(Math.max(0, 5 - (Number(value) || 0)));
  if (fmt === 'date' || fmt === 'datetime') return formatDate(value);
  if (fmt === 'boolean') return value ? 'Yes' : 'No';
  if (fmt === 'list' && Array.isArray(value)) return value.join(', ');
  return null; // no format applied
}

/** Render any value in a readable way */
function FieldValue({ value, fieldKey, viewConfig, currency }) {
  if (value === null || value === undefined) return <span style={{ color: 'var(--text-muted)' }}>—</span>;

  // Check agent-configured format first
  const formatted = applyFormat(value, fieldKey, viewConfig, currency);
  if (formatted !== null) return <span>{formatted}</span>;

  if (typeof value === 'boolean') return <span>{value ? 'Yes' : 'No'}</span>;

  // Arrays of primitives
  if (Array.isArray(value) && value.length > 0 && value.every(v => typeof v !== 'object')) {
    return <span>{value.join(', ')}</span>;
  }

  // Objects and arrays of objects
  if (typeof value === 'object') {
    return <pre className="txn-json">{JSON.stringify(value, null, 2)}</pre>;
  }

  const s = String(value);

  // Auto-detect dates
  if (fieldKey && (fieldKey.includes('_at') || fieldKey.includes('date') || fieldKey.includes('time')) && !isNaN(Date.parse(s))) {
    return <span>{formatDate(s)}</span>;
  }

  // IDs and hashes
  if (fieldKey && (fieldKey === 'id' || fieldKey.endsWith('_id') || fieldKey.includes('token') || fieldKey.includes('session'))) {
    return <span className="txn-mono">{s}</span>;
  }

  // Long text
  if (s.length > 100) {
    return <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{s}</div>;
  }

  return <span>{s}</span>;
}

/** Renders a labeled field */
function Field({ label, value, fieldKey, viewConfig, currency }) {
  return (
    <div className="txn-field">
      <div className="txn-field-label">{label}</div>
      <div className="txn-field-value"><FieldValue value={value} fieldKey={fieldKey} viewConfig={viewConfig} currency={currency} /></div>
    </div>
  );
}

/** Renders a group of key-value pairs from an object */
function FieldGroup({ title, data: obj, viewConfig, currency, accent }) {
  if (!obj || typeof obj !== 'object') return null;
  const entries = Object.entries(obj).filter(([k]) => !k.startsWith('_'));
  if (entries.length === 0) return null;

  return (
    <div className="card" style={accent ? { borderLeft: `3px solid ${accent}` } : undefined}>
      <div className="card-title" style={accent ? { color: accent } : undefined}>{title}</div>
      <div className="txn-fields">
        {entries.map(([k, v]) => (
          <Field key={k} label={getLabel({ labels: viewConfig?.labels }, k)} value={v} fieldKey={k} viewConfig={viewConfig} currency={currency} />
        ))}
      </div>
    </div>
  );
}

// ─── Detail view ──────────────────────────────────

function TransactionDetail({ id, onBack, currency: fallbackCurrency, viewConfig, onArchived, onCompleted }) {
  const { data, loading, error } = useFetch(`/api/transactions/${id}`);
  const resolveUrl = useResolveUrl();

  if (loading) return <div className="loading">Loading transaction</div>;
  if (error) return <div className="empty">Error: {error}</div>;
  if (!data) return null;

  const currency = data.currency || fallbackCurrency;
  const hasConfig = viewConfig?.detail_sections?.length > 0;
  const isArchived = data.archived === true;
  const isCompleted = data.status === 'completed';

  // Build timeline
  const timeline = [];
  if (data.created_at) timeline.push({ label: 'Created', time: data.created_at });
  if (data.updated_at && data.updated_at !== data.created_at) timeline.push({ label: 'Updated', time: data.updated_at });
  if (data.completed_at) timeline.push({ label: 'Completed', time: data.completed_at });
  timeline.sort((a, b) => new Date(a.time) - new Date(b.time));

  const customer = data.user_name || data.user || data.client || '';

  return (
    <div>
      <div className="detail-header">
        <button className="btn-back" onClick={onBack}>&larr; Back</button>
        <h1 className="page-title" style={{ fontSize: 18 }}>
          {data.service || 'Transaction'}
        </h1>
        <span className={`badge ${data.status}`}>{data.status?.replace(/_/g, ' ')}</span>
        <div style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
          {onCompleted && (
            <button
              className="btn btn-sm"
              onClick={() => { if (!isCompleted) onCompleted(data); }}
              disabled={isCompleted}
              title={isCompleted ? 'Already completed' : 'Mark this transaction as completed'}
              style={isCompleted ? { color: 'var(--green)', opacity: 0.7 } : undefined}
            >
              {isCompleted ? '✓ Completed' : 'Mark completed'}
            </button>
          )}
          {onArchived && (
            <button
              className="btn btn-sm"
              onClick={() => onArchived(data)}
              title={isArchived ? 'Unarchive this transaction' : 'Archive this transaction'}
            >
              {isArchived ? 'Unarchive' : 'Archive'}
            </button>
          )}
        </div>
      </div>

      {/* Summary row */}
      <div className="txn-summary">
        <div className="txn-summary-item">
          <div className="txn-summary-label">Customer</div>
          <div className="txn-summary-value">{customer || '—'}</div>
          {data.user_id && customer && customer !== data.user_id && (
            <div className="txn-summary-sub">ID: {data.user_id}</div>
          )}
        </div>
        <div className="txn-summary-item">
          <div className="txn-summary-label">Cost</div>
          <div className="txn-summary-value" style={{ color: 'var(--green)' }}>
            {data.cost ? `${currency}${data.cost}` : 'Free'}
          </div>
        </div>
        {data.rating != null && (
          <div className="txn-summary-item">
            <div className="txn-summary-label">Rating</div>
            <div className="txn-summary-value" style={{ color: 'var(--yellow)' }}>
              {'★'.repeat(data.rating)}{'☆'.repeat(Math.max(0, 5 - data.rating))}
            </div>
          </div>
        )}
        <div className="txn-summary-item">
          <div className="txn-summary-label">Timeline</div>
          <div className="txn-summary-value" style={{ fontSize: 13 }}>
            {timeline.map((evt, i) => (
              <div key={i} className="txn-timeline-row">
                <span className="txn-timeline-dot" style={{
                  background: evt.label === 'Completed' ? 'var(--green)' : evt.label === 'Updated' ? 'var(--accent)' : 'var(--text-muted)',
                }} />
                <span className="txn-timeline-label">{evt.label}</span>
                <span className="txn-timeline-time">{formatDate(evt.time)}</span>
              </div>
            ))}
          </div>
        </div>
        {data.id && (
          <div className="txn-summary-item">
            <div className="txn-summary-label">Transaction ID</div>
            <div className="txn-mono" style={{ fontSize: 12, marginTop: 4, wordBreak: 'break-all' }}>{data.id}</div>
          </div>
        )}
      </div>

      {/* Agent-configured sections */}
      {hasConfig && <ConfiguredDetail data={data} viewConfig={viewConfig} currency={currency} />}

      {/* Fallback: auto-detected sections */}
      {!hasConfig && <AutoDetail data={data} viewConfig={viewConfig} currency={currency} />}

      {/* Attached files */}
      {Array.isArray(data.files) && data.files.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <div className="card-title" style={{ padding: '16px 18px 12px' }}>Files ({data.files.length})</div>
          <div style={{ padding: '0 18px 18px', display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            {data.files.map((f, i) => {
              const url = resolveUrl(`/api/data/file/${(f.path || '').replace(/^data\//, '')}`);
              if (f.kind === 'image') {
                return (
                  <a key={i} href={url} target="_blank" rel="noreferrer" title={f.name} style={{ display: 'block' }}>
                    <img src={url} alt={f.name} style={{ width: 96, height: 96, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)' }} />
                  </a>
                );
              }
              if (f.kind === 'audio') {
                return (
                  <div key={i} style={{ minWidth: 240, padding: 10, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-secondary)' }}>
                    <div style={{ fontSize: 12, marginBottom: 6, color: 'var(--text)', wordBreak: 'break-all' }}>{f.name}</div>
                    <audio controls src={url} style={{ width: '100%' }} />
                  </div>
                );
              }
              if (f.kind === 'video') {
                return (
                  <a key={i} href={url} target="_blank" rel="noreferrer" title={f.name}>
                    <video src={url} style={{ width: 160, height: 96, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)', background: '#000' }} />
                  </a>
                );
              }
              return (
                <a key={i} href={url} target="_blank" rel="noreferrer" title={f.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-secondary)', textDecoration: 'none', color: 'var(--text)', fontSize: 13 }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                  <span style={{ wordBreak: 'break-all' }}>{f.name}</span>
                </a>
              );
            })}
          </div>
        </div>
      )}

      {/* Items table (always shown if present) */}
      {data.items && Array.isArray(data.items) && data.items.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <div className="card-title" style={{ padding: '16px 18px 0' }}>Items</div>
          <table className="table">
            <thead>
              <tr>
                {Object.keys(data.items[0]).map(k => (
                  <th key={k}>{getLabel(viewConfig, k)}</th>
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

      {/* Sub-transactions */}
      {data.sub_transactions && Array.isArray(data.sub_transactions) && data.sub_transactions.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <div className="card-title" style={{ padding: '16px 18px 0' }}>Extension Calls</div>
          <table className="table">
            <thead>
              <tr>
                {Object.keys(data.sub_transactions[0]).map(k => (
                  <th key={k}>{getLabel(viewConfig, k)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.sub_transactions.map((sub, i) => (
                <tr key={i}>
                  {Object.entries(sub).map(([k, v], j) => (
                    <td key={j}>
                      {k === 'status' ? <span className={`badge ${v}`}>{v}</span>
                        : k === 'cost' ? (v ? `${currency}${v}` : 'Free')
                        : typeof v === 'object' ? JSON.stringify(v) : String(v ?? '—')}
                    </td>
                  ))}
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
    </div>
  );
}

/**
 * Agent-configured detail view.
 * Renders sections defined in viewConfig.detail_sections,
 * then shows any remaining fields not covered by the sections.
 */
function ConfiguredDetail({ data, viewConfig, currency }) {
  const sections = viewConfig.detail_sections;

  // Track which fields are covered by configured sections
  const coveredFields = new Set();
  const alwaysSkip = new Set([
    'id', 'service', 'status', 'user_name', 'user_id', 'user', 'client',
    'cost', 'currency', 'rating', 'created_at', 'updated_at', 'completed_at',
    '_file', 'items', 'sub_transactions', 'files', 'dispute', 'dispute_reason',
  ]);

  for (const section of sections) {
    for (const f of section.fields) coveredFields.add(f);
  }

  // Remaining fields not in any section
  const remaining = Object.entries(data).filter(([k, v]) =>
    !coveredFields.has(k) && !alwaysSkip.has(k) && !k.startsWith('_') &&
    v !== null && v !== undefined
  );

  return (
    <>
      {sections.map((section, i) => {
        const fields = section.fields.filter(k => data[k] !== undefined && data[k] !== null);
        if (fields.length === 0) return null;
        return (
          <div key={i} className="card">
            <div className="card-title">{section.title}</div>
            <div className="txn-fields">
              {fields.map(k => (
                <Field key={k} label={getLabel(viewConfig, k)} value={data[k]} fieldKey={k} viewConfig={viewConfig} currency={currency} />
              ))}
            </div>
          </div>
        );
      })}

      {/* Notes */}
      {data.notes && (
        <div className="card">
          <div className="card-title">Notes</div>
          <div style={{ fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{data.notes}</div>
        </div>
      )}

      {/* Delivery / Payment objects */}
      <FieldGroup title="Delivery" data={data.delivery} viewConfig={viewConfig} currency={currency} />
      <FieldGroup title="Payment" data={data.payment} viewConfig={viewConfig} currency={currency} />

      {/* Uncovered fields */}
      {remaining.length > 0 && (
        <div className="card">
          <div className="card-title">Other</div>
          <div className="txn-fields">
            {remaining.map(([k, v]) => (
              <Field key={k} label={getLabel(viewConfig, k)} value={v} fieldKey={k} viewConfig={viewConfig} currency={currency} />
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Auto-detected detail view (fallback when no agent config exists).
 * Groups fields by type and renders them in a sensible order.
 */
function AutoDetail({ data, viewConfig, currency }) {
  const skipKeys = new Set(['_file']);
  const dateKeys = new Set(['created_at', 'updated_at', 'completed_at']);
  const objectKeys = new Set(['details', 'delivery', 'payment']);
  const tableKeys = new Set(['items', 'sub_transactions', 'files']);
  const topKeys = new Set(['id', 'service', 'status', 'user_name', 'user_id', 'user', 'client', 'cost', 'currency', 'rating']);
  const textKeys = new Set(['notes', 'dispute', 'dispute_reason']);

  const serviceFields = Object.entries(data).filter(([k]) =>
    !skipKeys.has(k) && !dateKeys.has(k) && !objectKeys.has(k) &&
    !tableKeys.has(k) && !topKeys.has(k) && !textKeys.has(k) &&
    !k.startsWith('_') && data[k] !== null && data[k] !== undefined
  );

  return (
    <>
      {serviceFields.length > 0 && (
        <div className="card">
          <div className="card-title">Details</div>
          <div className="txn-fields">
            {serviceFields.map(([k, v]) => (
              <Field key={k} label={getLabel(viewConfig, k)} value={v} fieldKey={k} viewConfig={viewConfig} currency={currency} />
            ))}
          </div>
        </div>
      )}

      <FieldGroup title="Details" data={data.details} viewConfig={viewConfig} currency={currency} />

      {data.notes && (
        <div className="card">
          <div className="card-title">Notes</div>
          <div style={{ fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{data.notes}</div>
        </div>
      )}

      <FieldGroup title="Delivery" data={data.delivery} viewConfig={viewConfig} currency={currency} />
      <FieldGroup title="Payment" data={data.payment} viewConfig={viewConfig} currency={currency} />
    </>
  );
}
