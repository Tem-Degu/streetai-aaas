import React, { useState } from 'react';
import { useFetch } from '../hooks/useApi.js';

export default function Memory() {
  const { data, loading, error } = useFetch('/api/memory/facts');

  if (loading) return <div className="loading">Loading memory</div>;
  if (error) return <div className="empty">Error: {error}</div>;

  var content = '';
  try {
    content = JSON.stringify(data, null, 2);
  } catch (e) {
    content = String(data);
  }

  if (!data || (Array.isArray(data) && data.length === 0)) {
    return (
      <div>
        <div className="page-header">
          <h1 className="page-title">Memory</h1>
          <p className="page-desc">What your agent remembers</p>
        </div>
        <div className="empty">No facts stored yet. Your agent learns from conversations.</div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Memory</h1>
        <p className="page-desc">{Array.isArray(data) ? data.length : 0} facts stored</p>
      </div>
      <div className="card">
        <pre className="code-block" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, maxHeight: 'none' }}>{content}</pre>
      </div>
    </div>
  );
}
