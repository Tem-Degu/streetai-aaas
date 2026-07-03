import React, { useState, useEffect, useRef, useContext } from 'react';
import { useSearchParams } from 'react-router-dom';
import { marked } from 'marked';
import { useFetch, useResolveUrl, useApi, WorkspaceContext } from '../hooks/useApi.js';
import { withBase } from '../base.js';
import { getTableColumns, getLabel, formatCellWithConfig, formatCurrency, prettyKey } from '../utils/transactionView.js';
import { setLastSeen, getLastSeen } from '../utils/unseenTransactions.js';
import TransactionViewEditor from '../components/TransactionViewEditor.jsx';

/** Extract unique statuses from actual transaction data */
/**
 * Format the per-row sequence label shown in the `#` column.
 *
 * New rows (engine-assigned ids) have a digit-only string `id`. Legacy rows
 * have an opaque string `id` plus a backfilled numeric `display_index`.
 * This helper picks whichever sequence value exists.
 */
export function formatSeq(t) {
  if (typeof t.id === 'number' && Number.isFinite(t.id)) return `#${t.id}`;
  if (typeof t.id === 'string' && /^\d+$/.test(t.id)) return `#${t.id}`;
  if (Number.isFinite(t.display_index)) return `#${t.display_index}`;
  return '';
}

/**
 * Client-side substring filter for the Transactions list. Matches against
 * the row's most-likely-identifying fields (id, user, service, status) plus
 * any other string/number field on the row. Case-insensitive. Nested objects
 * and arrays are intentionally skipped to keep the filter cheap and the
 * matches predictable — searching for "sparkling water" against an items
 * array would be surprising both when it hits and when it doesn't.
 */
function applyQuery(rows, query) {
  if (!rows) return rows;
  const q = (query || '').trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(t => rowMatchesQuery(t, q));
}

function rowMatchesQuery(t, q) {
  for (const v of Object.values(t)) {
    if (v == null) continue;
    if (typeof v === 'string') {
      if (v.toLowerCase().includes(q)) return true;
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      if (String(v).toLowerCase().includes(q)) return true;
    }
    // Arrays/objects skipped: cheaper, less surprising. The id-by-number
    // case is covered by the top-level `id` field being a string of digits.
  }
  return false;
}

function getStatuses(txns) {
  if (!txns || txns.length === 0) return [];
  const seen = new Set();
  for (const t of txns) {
    if (t.status) seen.add(t.status);
  }
  return [...seen];
}

export default function Transactions() {
  const workspace = useContext(WorkspaceContext);
  const [filter, setFilter] = useState('all');
  // View mode toggle: 'active' (default) shows non-archived rows;
  // 'archived' shows archived rows only. There is no mixed mode — the
  // previous "show all" was confusing because archive icons differed per row.
  const [viewMode, setViewMode] = useState('active');
  const showArchived = viewMode === 'archived';
  const [searchParams, setSearchParams] = useSearchParams();
  const selected = searchParams.get('id');

  // ── "New / changed since last visit" highlight ──
  // Snapshot the last-seen timestamp at mount, BEFORE the sidebar-badge effect
  // advances it. Rows get a subtle accent based on what changed:
  //   • created after highlightSince  → 'new'       (pink, pulsing)
  //   • updated after highlightSince  → 'updated'   (amber)
  //   • updated + status cancelled    → 'cancelled' (red, pulsing)
  // The highlight clears when the user opens the row or revisits the tab
  // (next mount captures the advanced lastSeen).
  const [highlightSince] = useState(() => getLastSeen(workspace));
  // Per-row "seen up to" watermark: id -> the activity timestamp
  // (max of created_at / updated_at) at the moment the row was opened. A row
  // re-highlights only when it changes again past this point, so a later
  // cancellation lights up even on a row that was opened earlier.
  const [dismissed, setDismissed] = useState(() => new Map());
  const activityOf = (t) => {
    const c = t.created_at, u = t.updated_at;
    if (c && u) return u > c ? u : c;
    return u || c || null;
  };
  const dismissRow = (t) => {
    const id = t.id || t._file;
    if (!id) return;
    const ts = activityOf(t);
    setDismissed(prev => {
      if (prev.get(id) === ts) return prev;
      const next = new Map(prev);
      next.set(id, ts);
      return next;
    });
  };
  // Returns 'new' | 'updated' | 'cancelled' | null for a row's highlight.
  const rowState = (t) => {
    if (!highlightSince) return null;
    const id = t.id || t._file;
    const seen = dismissed.get(id);
    const since = seen && seen > highlightSince ? seen : highlightSince;
    if (t.created_at && t.created_at > since) return 'new';
    if (t.updated_at && t.updated_at > since) {
      return t.status === 'cancelled' ? 'cancelled' : 'updated';
    }
    return null;
  };

  const setSelected = (id) => {
    if (id) setSearchParams({ id });
    else setSearchParams({});
  };
  const openTxn = (t) => {
    dismissRow(t);
    setSelected(t.id || t._file);
  };

  const [editorOpen, setEditorOpen] = useState(false);
  const [query, setQuery] = useState('');
  const url = showArchived ? '/api/transactions?archived=true' : '/api/transactions';
  const { data: allTxns, loading, error, refetch: refetchTxns } = useFetch(url);
  const { data: stats, refetch: refetchStats } = useFetch('/api/transactions-stats');
  const { data: viewConfig, refetch: refetchView } = useFetch('/api/transaction-view');

  // Background poll while this tab is open. Cheap count-check against the
  // frozen highlightSince — when the server reports new rows since then we
  // refetch the full list. New arrivals automatically pick up the highlight
  // because `highlightSince` doesn't move while the user is on this tab.
  // Paused when the tab/window is hidden so we don't churn in the background.
  useEffect(() => {
    if (showArchived) return; // archived view is static — no need to poll
    const POLL_MS = 15000;
    const resolveCount = (since) => {
      const base = since
        ? `/api/transactions/count?since=${encodeURIComponent(since)}`
        : '/api/transactions/count';
      return withBase(workspace ? base.replace('/api/', `/api/ws/${workspace}/`) : base);
    };
    let lastKnown = highlightSince || null;
    let cancelled = false;

    const tick = async () => {
      if (document.visibilityState === 'hidden') return;
      try {
        const r = await fetch(resolveCount(lastKnown));
        if (!r.ok || cancelled) return;
        const d = await r.json();
        if (d.count > 0) {
          refetchTxns();
          refetchStats();
          // Advance our local watermark so the next tick only flags rows
          // newer than what this tick already triggered a refetch for.
          if (d.latestAt) lastKnown = d.latestAt;
        }
      } catch { /* network blip — next tick retries */ }
    };

    const interval = setInterval(tick, POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [workspace, showArchived, highlightSince, refetchTxns, refetchStats]);
  const api = useApi();

  // Optimistic archive state. While `pendingArchive` is set, the row is
  // hidden client-side; an undo banner lets the user revert before the
  // server change settles into the next refetch.
  const [pendingArchive, setPendingArchive] = useState(null); // { id, wasArchived }
  const undoTimerRef = useRef(null);
  useEffect(() => () => clearTimeout(undoTimerRef.current), []);

  // Mark all currently-loaded transactions as seen for the sidebar badge.
  // Re-runs whenever the transaction list updates, so the badge stays at 0
  // while the user is sitting on this page even as new/changed txns arrive.
  // Uses the activity timestamp (max of created_at / updated_at) so customer
  // edits and cancellations clear the badge the same way new rows do.
  useEffect(() => {
    if (!allTxns) return;
    let latest = null;
    for (const t of allTxns) {
      const ts = activityOf(t);
      if (ts && (!latest || ts > latest)) latest = ts;
    }
    setLastSeen(workspace, latest || new Date().toISOString());
  }, [allTxns, workspace]);

  const cur = stats?.currency || '';
  const statuses = getStatuses(allTxns);
  const visibleTxns = pendingArchive
    ? allTxns?.filter(t => (t.id || t._file) !== pendingArchive.id)
    : allTxns;
  const statusFiltered = filter === 'all' ? visibleTxns : visibleTxns?.filter(t => t.status === filter);
  const txns = applyQuery(statusFiltered, query);
  const extraCols = getTableColumns(viewConfig, allTxns);

  // ── Pagination ──
  const PAGE_SIZE = 20;
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil((txns?.length || 0) / PAGE_SIZE));
  // Reset to page 1 whenever the filter / archive toggle / search query changes the row set
  useEffect(() => { setPage(1); }, [filter, viewMode, query]);
  // Clamp when the underlying list shrinks (e.g. after archiving the last row on a page)
  useEffect(() => { if (page > totalPages) setPage(totalPages); }, [page, totalPages]);
  const pageStart = (page - 1) * PAGE_SIZE;
  const pagedTxns = txns?.slice(pageStart, pageStart + PAGE_SIZE);

  const archiveTxn = async (txn, e) => {
    if (e) e.stopPropagation();
    const id = txn.id || txn._file;
    const wasArchived = txn.archived === true;
    // If another archive is still pending, finalize it first — refetch so its
    // row stays hidden via the fresh data (not via pendingArchive, which can
    // only track one id at a time).
    if (pendingArchive && pendingArchive.id !== id) {
      clearTimeout(undoTimerRef.current);
      refetchTxns();
      refetchStats();
    }
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
            <div className="stat-value green">{formatCurrency(stats.revenue, cur)}</div>
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

      <div className="btn-group" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
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
        <div
          style={{
            marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6,
            position: 'relative',
          }}
        >
          <input
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search id, user, service…"
            aria-label="Search transactions"
            style={{
              width: 220, padding: '6px 28px 6px 10px',
              border: '1px solid var(--border)', borderRadius: 6,
              background: 'var(--bg-secondary)', color: 'var(--text)',
              fontSize: 13, outline: 'none',
            }}
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              aria-label="Clear search"
              title="Clear"
              style={{
                position: 'absolute', right: 6,
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--text-muted)', fontSize: 16, lineHeight: 1, padding: '0 4px',
              }}
            >×</button>
          )}
        </div>
        <button
          className="btn"
          onClick={() => setViewMode(showArchived ? 'active' : 'archived')}
          title={showArchived ? 'Back to active transactions' : 'View archived transactions only'}
        >
          {showArchived ? 'Active' : 'Archived'}
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
                <th style={{ width: 56 }}>#</th>
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
                const hlState = rowState(t);
                const rowClass = hlState === 'new' ? 'txn-row-new'
                  : hlState === 'updated' ? 'txn-row-updated'
                  : hlState === 'cancelled' ? 'txn-row-cancelled'
                  : undefined;
                const seq = formatSeq(t);
                return (
                <tr
                  key={t.id || i}
                  onClick={() => openTxn(t)}
                  className={rowClass}
                  style={{ cursor: 'pointer' }}
                >
                  <td
                    title={t.id || ''}
                    style={{
                      fontVariantNumeric: 'tabular-nums',
                      fontSize: 13,
                      color: 'var(--text-muted)',
                      width: hlState ? 124 : 56,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {seq}
                    {hlState === 'new' && <span className="txn-new-pill">NEW</span>}
                    {hlState === 'updated' && <span className="txn-updated-pill">UPDATED</span>}
                    {hlState === 'cancelled' && <span className="txn-cancelled-pill">CANCELLED</span>}
                  </td>
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
                  <td>{t.cost ? formatCurrency(t.cost, cur) : 'Free'}</td>
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
                  <td style={{ color: 'var(--green)', fontWeight: 600 }}>{formatCurrency(rev, cur)}</td>
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
  if (fmt === 'currency' && value != null) return formatCurrency(value, currency);
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
  const { data, loading, error, refetch } = useFetch(`/api/transactions/${id}`);
  const { data: lifecycle } = useFetch('/api/transactions/lifecycle');
  const api = useApi();
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
        <StatusSelector
          status={data.status}
          allowed={lifecycle?.transitions?.[data.status] || []}
          onChange={async (next, reason) => {
            try {
              await api.patch(`/api/transactions/${encodeURIComponent(id)}/status`, { status: next, reason });
            } catch (e) {
              alert(e.message || 'Status change failed');
            }
            refetch();
          }}
        />
        <div style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
          {onCompleted && (
            <button
              className="btn btn-sm"
              onClick={async () => {
                if (isCompleted) return;
                try { await onCompleted(data); } finally { refetch(); }
              }}
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
            {data.cost ? formatCurrency(data.cost, currency) : 'Free'}
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

      {/* Items section. Renders three shapes:
          - array of objects → table (keys become columns)
          - array of scalars (strings/numbers/booleans) → bulleted list
          - mixed → bulleted list, JSON-stringify non-strings
        Strings are array-like in JS, so the previous unconditional Object.keys/
        Object.values path would render each character as a cell — guarding by
        shape avoids that and accepts any reasonable agent output. */}
      {data.items && Array.isArray(data.items) && data.items.length > 0 && (
        <ItemsCard items={data.items} viewConfig={viewConfig} currency={currency} />
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
                        : k === 'cost' ? (v ? formatCurrency(v, currency) : 'Free')
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

      {/* Conversation thread — placed at the end so staff scrolls past the
          structured transaction data first, then sees/manages the live
          customer↔agent thread. Read-only history + staff message input. */}
      <ConversationCard transactionId={id} />
    </div>
  );
}

/**
 * Items card renderer. The agent may save items as:
 *  - an array of objects ({ name, qty, price, ... })  → table
 *  - an array of scalars  ("Sparkling Water")          → bulleted list
 *  - a mixed array                                     → bulleted list,
 *    with non-string entries JSON-stringified for safety.
 *
 * Caller must pre-check that `items` is a non-empty array.
 */
/**
 * Clickable status badge in the detail header. Opens a small popover with
 * the transitions allowed from the current status (driven by the server's
 * lifecycle map). Cancelling prompts for a reason.
 *
 * Terminal statuses (completed/cancelled) show no menu — they're closed.
 */
function StatusSelector({ status, allowed, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onClickAway = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onClickAway);
    return () => document.removeEventListener('mousedown', onClickAway);
  }, [open]);

  const hasOptions = Array.isArray(allowed) && allowed.length > 0;
  const label = (status || '').replace(/_/g, ' ');

  const pick = (next) => {
    setOpen(false);
    let reason;
    if (next === 'cancelled') {
      const r = window.prompt('Cancellation reason (optional):', '');
      if (r === null) return; // user cancelled the prompt
      reason = r || undefined;
    }
    onChange(next, reason);
  };

  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        onClick={() => hasOptions && setOpen(v => !v)}
        className={`badge ${status}`}
        title={hasOptions ? 'Click to change status' : 'Status is final'}
        style={{
          border: 'none',
          cursor: hasOptions ? 'pointer' : 'default',
          padding: '3px 9px',
          font: 'inherit',
        }}
      >
        {label}{hasOptions ? ' ▾' : ''}
      </button>
      {open && hasOptions && (
        <div
          style={{
            position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 20,
            background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8,
            boxShadow: '0 4px 16px rgba(0,0,0,0.15)', minWidth: 160, padding: 4,
          }}
        >
          <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '4px 10px 2px' }}>
            Change status to…
          </div>
          {allowed.map(next => (
            <button
              key={next}
              type="button"
              onClick={() => pick(next)}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '6px 10px', background: 'none', border: 'none',
                color: 'var(--text)', cursor: 'pointer', fontSize: 13,
                borderRadius: 4,
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-card-hover)'}
              onMouseLeave={e => e.currentTarget.style.background = 'none'}
            >
              {next.replace(/_/g, ' ')}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

// Item columns that hold money, so the Items table shows e.g. "AED 24.00"
// instead of a bare "24". Used as a fallback when the agent didn't declare a
// field's type as `currency` in SKILL.md.
const MONEY_ITEM_KEYS = new Set([
  'price', 'cost', 'amount', 'total', 'subtotal', 'sub_total',
  'unit_price', 'line_total', 'rate', 'fee',
]);

function ItemsCard({ items, viewConfig, currency }) {
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const allObjects = items.every(isObject);

  if (allObjects) {
    // Prefer the declared `item_fields` order/labels from SKILL.md when
    // present. Falls back to the union of keys seen on actual items so
    // partially-shaped objects still render and any extra keys the agent
    // attached are not silently dropped.
    const declared = Array.isArray(viewConfig?.item_fields) ? viewConfig.item_fields : [];
    const declaredKeys = declared.map(f => f.key);
    // Map of key -> declared type (e.g. 'currency') for format decisions.
    const typeByKey = {};
    for (const f of declared) { if (f?.key && f.type) typeByKey[f.key] = f.type; }
    // A column is money if declared `currency`, or (when undeclared) its name
    // is a common price field. Quantities/names are left untouched.
    const isMoneyKey = (k) =>
      typeByKey[k] === 'currency' || (!typeByKey[k] && MONEY_ITEM_KEYS.has(k.toLowerCase()));
    const seen = new Set(declaredKeys);
    const extras = [];
    for (const item of items) {
      for (const k of Object.keys(item)) {
        if (!seen.has(k)) { seen.add(k); extras.push(k); }
      }
    }
    const keys = [...declaredKeys, ...extras];
    return (
      <div className="card" style={{ padding: 0 }}>
        <div className="card-title" style={{ padding: '16px 18px 0' }}>Items</div>
        <table className="table">
          <thead>
            <tr>{keys.map(k => <th key={k}>{getLabel(viewConfig, k)}</th>)}</tr>
          </thead>
          <tbody>
            {items.map((item, i) => (
              <tr key={i}>
                {keys.map(k => {
                  const v = item[k];
                  let display;
                  if (v == null) display = '—';
                  else if (typeof v === 'object') display = JSON.stringify(v);
                  else if (isMoneyKey(k) && Number.isFinite(Number(v))) display = formatCurrency(v, currency);
                  else display = String(v);
                  return <td key={k}>{display}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  // Scalar or mixed list → render as a clean bulleted list.
  return (
    <div className="card" style={{ padding: '16px 18px' }}>
      <div className="card-title" style={{ paddingBottom: 8 }}>Items</div>
      <ul style={{ margin: 0, paddingLeft: 20, fontSize: 14, lineHeight: 1.7 }}>
        {items.map((it, i) => (
          <li key={i}>
            {it == null
              ? '—'
              : (typeof it === 'object' ? JSON.stringify(it) : String(it))}
          </li>
        ))}
      </ul>
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
  // Fields rendered as their own dedicated cards lower on the page. Even
  // when SKILL.md's `## Transaction Fields` declares them (e.g. `items`),
  // they must be omitted from inline detail_sections to avoid double render.
  const renderedSeparately = new Set(['items', 'sub_transactions', 'files']);

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
        const fields = section.fields.filter(k =>
          data[k] !== undefined && data[k] !== null && !renderedSeparately.has(k)
        );
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

/**
 * Conversation thread for a transaction.
 *
 * Renders the customer↔agent session that produced this transaction and
 * lets staff send instructions to the agent (which the agent acts on —
 * messaging the customer, updating the row, looking something up).
 *
 * Polling: every 5s while the tab is visible. Stops when hidden.
 * Source of truth: the customer's session file on disk; this card is just
 * a viewer + injector. Nothing is duplicated in the dashboard's storage.
 *
 * Staff messages are detected by their `[ADMIN MESSAGE FROM DASHBOARD` or
 * `[ADMIN GUIDANCE` content prefix — both shapes already used by the
 * existing owner-reply path (Telegram/WhatsApp). The header is stripped
 * for display so staff sees the actual message text.
 */
function ConversationCard({ transactionId }) {
  const api = useApi();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(null);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [pauseError, setPauseError] = useState(null);
  const scrollRef = useRef(null);

  const refresh = async () => {
    try {
      const r = await api.get(`/api/transactions/${encodeURIComponent(transactionId)}/conversation`);
      setData(r);
      setError(null);
    } catch (e) {
      setError(e.message || 'Failed to load conversation');
    }
  };

  useEffect(() => {
    refresh();
    // Re-fetch every 5s while the tab is visible. Pauses when hidden so we
    // don't hammer the server when the user is on another tab.
    const id = setInterval(() => {
      if (!document.hidden) refresh();
    }, 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactionId]);

  // Auto-scroll to newest message when message count grows.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [data?.messages?.length]);

  const paused = !!data?.paused;

  const togglePause = async () => {
    if (pauseBusy) return;
    setPauseBusy(true);
    setPauseError(null);
    const path = paused ? 'unpause' : 'pause';
    try {
      await api.post(`/api/transactions/${encodeURIComponent(transactionId)}/${path}`, {});
      await refresh();
    } catch (e) {
      setPauseError(e.message || `Failed to ${path}`);
    } finally {
      setPauseBusy(false);
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await api.post(`/api/transactions/${encodeURIComponent(transactionId)}/admin-message`, { message: text });
      setDraft('');
      await refresh();
    } catch (e) {
      setSendError(e.message || 'Failed to send');
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e) => {
    // Cmd/Ctrl+Enter sends. Plain Enter inserts a newline so multi-line
    // messages are easy to type.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  };

  const messages = data?.messages || [];
  const customerLabel = data?.customer?.user_name || data?.customer?.user_id || 'Customer';
  const inputDisabled = !paused || sending;

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div
        style={{
          padding: '14px 18px',
          borderBottom: '1px solid var(--border-subtle)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          background: 'var(--bg-surface)',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>Conversation</span>
        {data?.customer?.platform && (
          <span
            style={{
              fontSize: 11,
              padding: '2px 8px',
              borderRadius: 999,
              background: 'var(--accent-muted)',
              color: 'var(--text-secondary)',
              textTransform: 'capitalize',
            }}
          >
            {data.customer.platform}
          </span>
        )}
        {paused && (
          <span
            style={{
              fontSize: 11,
              padding: '2px 8px',
              borderRadius: 999,
              background: 'var(--yellow-muted)',
              color: 'var(--yellow)',
              fontWeight: 600,
              letterSpacing: 0.3,
              textTransform: 'uppercase',
            }}
            title={data?.paused_at ? `Paused at ${formatDate(data.paused_at)}` : ''}
          >
            Agent paused
          </span>
        )}
        <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 'auto' }}>
          {messages.length > 0
            ? `${messages.length} message${messages.length === 1 ? '' : 's'} with ${customerLabel}`
            : 'No messages yet'}
        </span>
      </div>

      {pauseError && (
        <div style={{ padding: '8px 18px', fontSize: 12, color: 'var(--red)', background: 'var(--red-muted)' }}>
          {pauseError}
        </div>
      )}

      {error && (
        <div
          style={{
            padding: '10px 18px',
            fontSize: 13,
            color: 'var(--red)',
            background: 'var(--red-muted)',
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          {error}
        </div>
      )}

      <div
        ref={scrollRef}
        style={{
          maxHeight: 440,
          minHeight: 120,
          overflowY: 'auto',
          padding: '16px 18px',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          background: 'var(--bg-main)',
        }}
      >
        {messages.length === 0 && !error && (
          <div
            style={{
              padding: '24px 0',
              fontSize: 13,
              color: 'var(--text-muted)',
              textAlign: 'center',
            }}
          >
            No conversation yet.
          </div>
        )}
        {messages.map((m, i) => (
          <MessageBubble key={i} message={m} />
        ))}
      </div>

      <div
        style={{
          padding: '12px 18px 16px',
          borderTop: '1px solid var(--border-subtle)',
          background: 'var(--bg-surface)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
          <textarea
            className="input"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={paused
              ? 'Message the customer directly… (Ctrl/Cmd+Enter to send)'
              : 'Pause the agent to talk to the customer.'}
            rows={2}
            disabled={inputDisabled}
            style={{
              flex: 1,
              maxWidth: 520,
              resize: 'none',
              fontFamily: 'inherit',
              fontSize: 13,
              lineHeight: 1.5,
              boxSizing: 'border-box',
              opacity: paused ? 1 : 0.6,
            }}
          />
          <button
            className="btn btn-primary"
            onClick={send}
            disabled={inputDisabled || !draft.trim()}
            style={{
              minWidth: 140,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              fontWeight: 600,
              fontSize: 13,
              padding: '10px 16px',
              borderRadius: 8,
              cursor: (inputDisabled || !draft.trim()) ? 'not-allowed' : 'pointer',
              transition: 'transform 0.06s ease, opacity 0.2s ease, filter 0.2s ease',
              flexShrink: 0,
              // Explicit enabled/disabled visuals so pausing/resuming the
              // agent reads as a state change on this button too.
              opacity: (inputDisabled || !draft.trim()) ? 0.45 : 1,
              filter: !paused ? 'grayscale(0.6)' : 'none',
            }}
            onMouseDown={e => { if (!e.currentTarget.disabled) e.currentTarget.style.transform = 'translateY(1px)'; }}
            onMouseUp={e => { e.currentTarget.style.transform = ''; }}
            onMouseLeave={e => { e.currentTarget.style.transform = ''; }}
          >
            {sending ? (
              <>
                <span
                  style={{
                    width: 12,
                    height: 12,
                    border: '2px solid currentColor',
                    borderTopColor: 'transparent',
                    borderRadius: '50%',
                    display: 'inline-block',
                    animation: 'spin 0.8s linear infinite',
                  }}
                />
                Sending
              </>
            ) : (
              'Send to customer'
            )}
          </button>
          <button
            onClick={togglePause}
            disabled={pauseBusy}
            title={paused
              ? 'Resume the agent. It will pick up the conversation with full history.'
              : 'Pause the agent so you can talk to the customer directly.'}
            style={{
              minWidth: 130,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              fontWeight: 600,
              fontSize: 13,
              padding: '10px 16px',
              borderRadius: 8,
              cursor: pauseBusy ? 'wait' : 'pointer',
              flexShrink: 0,
              // Stateful color: paused → green (action: resume), not paused → yellow (action: pause)
              background: paused ? 'var(--green-muted)' : 'var(--yellow-muted)',
              color: paused ? 'var(--green)' : 'var(--yellow)',
              border: `1px solid ${paused ? 'var(--green)' : 'var(--yellow)'}`,
              transition: 'background 0.15s ease, filter 0.15s ease',
            }}
            onMouseEnter={e => { if (!e.currentTarget.disabled) e.currentTarget.style.filter = 'brightness(1.08)'; }}
            onMouseLeave={e => { e.currentTarget.style.filter = ''; }}
          >
            <span
              aria-hidden
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: paused ? 'var(--green)' : 'var(--yellow)',
                display: 'inline-block',
              }}
            />
            {pauseBusy ? '…' : paused ? 'Resume agent' : 'Pause agent'}
          </button>
        </div>
        {!paused && !sendError && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
            Pause the agent to message the customer.
          </div>
        )}
        {sendError && (
          <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 8 }}>
            {sendError}
          </div>
        )}
      </div>
    </div>
  );
}


/**
 * Render a single message bubble. Three visual variants:
 *   - Staff (admin-injected from dashboard or owner reply via Telegram/WA)
 *     → right-aligned amber bubble, header stripped from display
 *   - Customer (any other user-role message)
 *     → left-aligned gray bubble
 *   - Agent (assistant-role)
 *     → left-aligned themed bubble
 */
function MessageBubble({ message }) {
  const isAssistant = message.role === 'assistant';
  const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);

  // Detect admin-injected user messages by their header. Two formats:
  //   - New direct-intervention: `[ADMIN MESSAGE FROM DASHBOARD] <body>`
  //     (single-line, no quote markers — what the pause/intervention flow
  //     saves today)
  //   - Legacy owner-reply via Telegram/WhatsApp: `[ADMIN GUIDANCE ...]`
  //     header followed by a `> <body>` quote block (still in some old
  //     sessions)
  // The bubble color + role label already say "Admin" — we strip the
  // header text from the body so the bubble just shows the actual message.
  const isStaffMessage = !isAssistant && (
    content.startsWith('[ADMIN MESSAGE FROM DASHBOARD') ||
    content.startsWith('[ADMIN GUIDANCE')
  );

  let displayText = content;
  if (isStaffMessage) {
    // Newer single-line format: strip the bracketed prefix exactly.
    const directPrefix = /^\[ADMIN MESSAGE FROM DASHBOARD\]\s*/;
    if (directPrefix.test(content)) {
      displayText = content.replace(directPrefix, '').trim();
    } else {
      // Legacy quoted-body format: pull out the `> ...` lines.
      const quoteIdx = content.indexOf('\n> ');
      if (quoteIdx !== -1) {
        displayText = content
          .slice(quoteIdx + 1)
          .split('\n')
          .map(l => l.startsWith('> ') ? l.slice(2) : l)
          .join('\n')
          .trim();
      }
    }
  }

  // Pick role + visual style. Bubble styling lives in styles.css
  // (.conv-bubble-customer / -agent / -admin) so light + dark each have
  // explicit, distinct backgrounds — the muted tokens alone aren't
  // pronounced enough in light mode.
  let role, bubbleClass, accent, align;
  if (isAssistant) {
    role = 'Agent';
    bubbleClass = 'conv-bubble-agent';
    accent = 'var(--blue)';
    align = 'flex-start';
  } else if (isStaffMessage) {
    role = 'Admin';
    bubbleClass = 'conv-bubble-admin';
    accent = 'var(--yellow)';
    align = 'flex-end';
  } else {
    role = 'Customer';
    bubbleClass = 'conv-bubble-customer';
    accent = 'var(--text-secondary)';
    align = 'flex-start';
  }

  const ts = message.timestamp || message.at;

  // Extract Truuze/connector-style attached-file markers so we can render
  // images/file pills instead of leaking the raw "[Attached files: ...]"
  // line into the bubble. Format produced by the truuze connector:
  //   "[Attached files: image: data/inbox/foo.jpg, audio: data/inbox/bar.m4a]"
  // First pull transcribed voice notes (their own format) into a clean
  // transcript + playable audio clip, then the standard "[Attached files: …]"
  // markers. Order matters: voice extraction removes the raw audio path so the
  // marker pass doesn't see it.
  const { cleanText: afterVoice, files: voiceFiles } = extractVoiceNotes(displayText);
  const { cleanText, files: markerFiles } = extractAttachedFiles(afterVoice);
  // Combine voice clips, inline markers, and backend-resolved agent files
  // (markdown images / data paths the conversation endpoint already extracted).
  const files = [...voiceFiles, ...markerFiles, ...(Array.isArray(message.files) ? message.files : [])];

  // Markdown rendering matches the main Chat page so agent responses with
  // lists / bold / code render properly. `breaks: true` preserves soft
  // line breaks the way the rest of the dashboard does.
  const renderedHtml = cleanText ? marked.parse(cleanText, { breaks: true }) : '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: align, maxWidth: '100%', marginTop: 2 }}>
      <div
        style={{
          fontSize: 10,
          color: accent,
          marginBottom: 4,
          padding: '0 4px',
          fontWeight: 600,
          letterSpacing: 0.4,
          textTransform: 'uppercase',
        }}
      >
        {role}
        {ts && (
          <span style={{ marginLeft: 8, color: 'var(--text-muted)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
            {formatDate(ts)}
          </span>
        )}
      </div>
      <div className={`conv-bubble ${bubbleClass} chat-markdown`} style={{ color: 'var(--text)' }}>
        {renderedHtml ? (
          <div dangerouslySetInnerHTML={{ __html: renderedHtml }} />
        ) : (
          !files.length && <span style={{ opacity: 0.5 }}>(empty)</span>
        )}
        {files.length > 0 && <AttachedFiles files={files} />}
      </div>
    </div>
  );
}

/**
 * Pull transcribed voice notes out of a message and turn them into a clean
 * transcript line plus a playable audio attachment.
 *
 * The connector (inbound-media.js) stores a transcribed voice note as:
 *   🎤 Customer voice message [data/inbox/x.ogg]: "the transcript"
 * or, when no speech was understood:
 *   🎤 Customer sent a voice message [data/inbox/x.ogg] but no speech was detected.
 *
 * Without this, the raw file path leaks into the bubble and there's no way to
 * listen to the clip. We render the audio (so it's playable) and show just the
 * transcript text (or a short placeholder when nothing was transcribed).
 *
 * Returns { cleanText, files } with files entries shaped { type:'audio', path }.
 */
function extractVoiceNotes(text) {
  if (!text) return { cleanText: text, files: [] };
  const files = [];
  const voiceRe = /🎤\s*Customer (?:voice message|sent a voice message)\s*\[([^\]]+)\](?::\s*"([^"]*)"|[^\n]*)?/g;
  const cleanText = text
    .replace(voiceRe, (_match, filePath, transcript) => {
      files.push({ type: 'audio', path: filePath.trim() });
      const t = (transcript || '').trim();
      return t ? `🎤 "${t}"` : '🎤 Voice message';
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { cleanText, files };
}

/**
 * Pull `[Attached files: type: path, ...]` blocks out of a message string.
 * Returns the cleaned text (with all markers removed and surrounding blank
 * lines collapsed) plus a list of `{ type, path }` entries.
 *
 * The marker format is emitted by the truuze connector when downloading
 * inbound media into `data/inbox/`. Other connectors may surface files
 * differently — those go through markdown rendering as-is.
 */
function extractAttachedFiles(text) {
  if (!text) return { cleanText: '', files: [] };
  const markerRe = /\[Attached files:\s*([^\]]+)\]/g;
  const files = [];
  let m;
  while ((m = markerRe.exec(text)) !== null) {
    for (const part of m[1].split(',')) {
      const [type, ...rest] = part.split(':');
      const filePath = rest.join(':').trim();
      if (filePath) files.push({ type: (type || 'file').trim(), path: filePath });
    }
  }
  const cleanText = text.replace(markerRe, '').replace(/\n{3,}/g, '\n\n').trim();
  return { cleanText, files };
}

/**
 * Render attached files inside a bubble. Reuses the .chat-file-image and
 * .chat-file-badge CSS classes from the Chat page so images and document
 * pills look identical to those in /chat.
 */
function AttachedFiles({ files }) {
  const resolveUrl = useResolveUrl();
  // Entries come in two shapes:
  //   - inline markers from customer messages → { type, path }   (workspace path)
  //   - backend-resolved agent files          → { type, url, name } (ready URL)
  const urlFor = (f) => (f.url ? resolveUrl(f.url) : resolveUrl(`/api/workspace/${f.path}`));
  const nameFor = (f) => f.name || (f.path ? f.path.split('/').pop() : 'file');
  const refOf = (f) => f.path || f.url || f.name || '';
  const isImage = (f) => f.type === 'image' || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(refOf(f));
  const isAudio = (f) => f.type === 'audio' || /\.(mp3|wav|m4a|ogg|flac)$/i.test(refOf(f));
  const isVideo = (f) => f.type === 'video' || /\.(mp4|webm|mov|avi)$/i.test(refOf(f));

  return (
    <div className="chat-msg-files" style={{ marginTop: 8 }}>
      {files.map((f, i) => {
        const url = urlFor(f);
        const name = nameFor(f);
        if (isImage(f)) {
          return (
            <a key={i} className="chat-file-image" href={url} target="_blank" rel="noopener noreferrer">
              <img src={url} alt={name} />
            </a>
          );
        }
        if (isAudio(f)) {
          return (
            <div key={i} style={{ minWidth: 220, padding: 8, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-input)' }}>
              <div style={{ fontSize: 11, marginBottom: 4, color: 'var(--text-secondary)', wordBreak: 'break-all' }}>{name}</div>
              <audio controls src={url} style={{ width: '100%' }} />
            </div>
          );
        }
        if (isVideo(f)) {
          return (
            <a key={i} className="chat-file-image" href={url} target="_blank" rel="noopener noreferrer">
              <video src={url} style={{ width: '100%', maxHeight: 240, objectFit: 'cover', display: 'block' }} />
            </a>
          );
        }
        return (
          <a key={i} className="chat-file-badge" href={url} target="_blank" rel="noopener noreferrer" title={name}>
            <svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 10.5V7.5a5.5 5.5 0 00-11 0v6a3.5 3.5 0 007 0V7a1.5 1.5 0 00-3 0v7" />
            </svg>
            {name}
          </a>
        );
      })}
    </div>
  );
}
