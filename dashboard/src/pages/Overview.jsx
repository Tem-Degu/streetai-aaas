import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useFetch } from '../hooks/useApi.js';
import { getTableColumns, getLabel, formatCellWithConfig } from '../utils/transactionView.js';

export default function Overview() {
  const { data, loading, error } = useFetch('/api/overview');

  if (loading) return <div className="loading">Loading overview</div>;
  if (error) return <div className="empty">Error: {error}</div>;
  if (!data) return null;

  const { name, data: db, transactions: tx, extensions, memory, sessions, messages } = data;
  const cur = tx.currency || '';

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{name}</h1>
        <p className="page-desc">Agent workspace overview</p>
      </div>

      <div className="txn-summary">
        <div className="txn-summary-item">
          <div className="txn-summary-label">Revenue</div>
          <div className="txn-summary-value" style={{ color: 'var(--green)' }}>{cur}{tx.revenue}</div>
        </div>
        <div className="txn-summary-item">
          <div className="txn-summary-label">Transactions</div>
          <div className="txn-summary-value" style={{ color: 'var(--green)' }}>{tx.completed}</div>
        </div>
        <div className="txn-summary-item">
          <div className="txn-summary-label">Messages</div>
          <div className="txn-summary-value" style={{ color: 'var(--accent)' }}>{messages || 0}</div>
        </div>
        <div className="txn-summary-item">
          <div className="txn-summary-label">Sessions</div>
          <div className="txn-summary-value" style={{ color: 'var(--accent)' }}>{sessions || 0}</div>
        </div>
      </div>

      <div className="stat-grid">
        <div className="stat">
          <div className="stat-label">Data Files</div>
          <div className="stat-value">{db.files}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Records</div>
          <div className="stat-value">{db.records}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Extensions</div>
          <div className="stat-value">{extensions}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Memory Facts</div>
          <div className="stat-value">{memory}</div>
        </div>
      </div>

      <ConnectionStatus />
      <TransactionList currency={cur} />
    </div>
  );
}

function ConnectionStatus() {
  const { data } = useFetch('/api/connections');

  if (!data || data.length === 0) return null;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-title" style={{ padding: '16px 18px 8px' }}>Connected Platforms</div>
      <div style={{ padding: '0 18px 16px', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {data.map((conn) => (
          <div
            key={conn.platform}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 14px',
              background: 'var(--bg-secondary)',
              borderRadius: 8,
              fontSize: 13,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: 'var(--green)',
                flexShrink: 0,
              }}
            />
            <span style={{ fontWeight: 500, textTransform: 'capitalize' }}>{conn.platform}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TransactionList({ currency }) {
  const navigate = useNavigate();
  const { data, loading } = useFetch('/api/transactions');
  const { data: viewConfig } = useFetch('/api/transaction-view');

  if (loading) return <div className="loading">Loading transactions</div>;
  if (!data || data.length === 0) {
    return (
      <div className="card">
        <div className="empty" style={{ padding: 30 }}>No active transactions yet</div>
      </div>
    );
  }

  const extraCols = getTableColumns(viewConfig, data);

  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="card-title" style={{ padding: '16px 18px 0' }}>Active Transactions</div>
      <table className="table">
        <thead>
          <tr>
            <th>Service</th>
            <th>User</th>
            <th>Status</th>
            {extraCols.map(k => <th key={k}>{getLabel(viewConfig, k)}</th>)}
            <th>Cost</th>
            <th>Date</th>
          </tr>
        </thead>
        <tbody>
          {data.slice(0, 10).map((t, i) => (
            <tr key={t.id || i} onClick={() => navigate(`transactions?id=${encodeURIComponent(t.id || t._file)}`)} style={{ cursor: 'pointer' }}>
              <td>{t.service || ''}</td>
              <td>{t.user_name || t.user || t.client || ''}</td>
              <td><span className={`badge ${t.status}`}>{t.status?.replace(/_/g, ' ')}</span></td>
              {extraCols.map(k => (
                <td key={k} style={{ fontSize: 13 }}>{formatCellWithConfig(t[k], k, viewConfig, currency)}</td>
              ))}
              <td>{t.cost ? `${currency}${t.cost}` : 'Free'}</td>
              <td>{t.created_at ? new Date(t.created_at).toLocaleDateString() : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
