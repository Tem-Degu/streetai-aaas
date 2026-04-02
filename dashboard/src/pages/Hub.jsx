import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useFetch, useApi } from '../hooks/useApi.js';

export default function Hub() {
  const { data, loading, error, refetch } = useFetch('/api/hub/workspaces');
  const api = useApi();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const navigate = useNavigate();

  if (loading) return <div className="page-loading">Loading...</div>;
  if (error) return <div className="empty">Error: {error}</div>;

  const workspaces = data?.workspaces || [];

  const handleCreate = async () => {
    if (!name.trim()) { setFormError('Name is required'); return; }
    setSaving(true);
    setFormError('');
    try {
      const result = await api.post('/api/hub/workspaces', { name: name.trim(), description: description.trim() });
      navigate(`/ws/${result.directory}`);
    } catch (err) {
      setFormError(err.message);
    }
    setSaving(false);
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Your Agents</h1>
        <p className="page-desc">Manage all your AaaS service agents</p>
      </div>

      <div style={{ marginBottom: 16 }}>
        {!creating ? (
          <button className="btn btn-primary" onClick={() => setCreating(true)}>+ New Agent</button>
        ) : (
          <div className="card" style={{ maxWidth: 500 }}>
            <div className="card-header">Create New Agent</div>
            <div className="card-body">
              <div className="form-group">
                <label>Agent Name</label>
                <input type="text" value={name} onChange={e => setName(e.target.value)} className="form-input" placeholder="e.g. My Travel Agent" autoFocus />
              </div>
              <div className="form-group">
                <label>Description</label>
                <textarea value={description} onChange={e => setDescription(e.target.value)} className="form-input" rows={3} placeholder="What service does this agent provide?" />
              </div>
              {formError && <p className="form-hint" style={{ color: 'var(--red)' }}>{formError}</p>}
              <div className="form-actions" style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-primary" onClick={handleCreate} disabled={saving}>{saving ? 'Creating...' : 'Create'}</button>
                <button className="btn" onClick={() => { setCreating(false); setFormError(''); }}>Cancel</button>
              </div>
            </div>
          </div>
        )}
      </div>

      {workspaces.length === 0 && !creating ? (
        <div className="empty">
          <p>No agent workspaces found.</p>
          <p className="form-hint">Click "+ New Agent" to create your first service agent.</p>
        </div>
      ) : (
        <div className="deploy-grid">
          {workspaces.map(ws => (
            <div key={ws.directory} className={`card deploy-card ${ws.isRunning ? 'deploy-active' : ''}`} onClick={() => navigate(`/ws/${ws.directory}`)} style={{ cursor: 'pointer' }}>
              <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="deploy-platform-icon" style={{ background: ws.isRunning ? '#10b981' : '#555' }}>
                  {ws.name.charAt(0).toUpperCase()}
                </span>
                <span style={{ flex: 1 }}>{ws.name}</span>
                <span className={`badge ${ws.isRunning ? 'badge-green' : 'badge-gray'}`}>
                  {ws.isRunning ? 'running' : 'stopped'}
                </span>
              </div>
              <div className="card-body">
                <div className="deploy-detail">
                  <span>Directory</span>
                  <span className="mono">{ws.directory}/</span>
                </div>
                {ws.provider && (
                  <div className="deploy-detail">
                    <span>Provider</span>
                    <span>{ws.provider}{ws.model ? ` (${ws.model.split('/').pop().split('-').slice(0, 2).join('-')})` : ''}</span>
                  </div>
                )}
                {ws.connections.length > 0 && (
                  <div className="deploy-detail">
                    <span>Platforms</span>
                    <span>{ws.connections.map(c => c.platform).join(', ')}</span>
                  </div>
                )}
                <div className="deploy-detail">
                  <span>Data</span>
                  <span>{ws.dataFiles} files, {ws.factCount} facts</span>
                </div>
                {ws.activeTx > 0 && (
                  <div className="deploy-detail">
                    <span>Active Jobs</span>
                    <span>{ws.activeTx}</span>
                  </div>
                )}
                {ws.lastActive && (
                  <div className="deploy-detail">
                    <span>Last Active</span>
                    <span>{new Date(ws.lastActive).toLocaleDateString()}</span>
                  </div>
                )}
              </div>
              <div className="card-footer">
                <button className="btn btn-primary btn-sm" onClick={(e) => { e.stopPropagation(); navigate(`/ws/${ws.directory}`); }}>Open Dashboard</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
