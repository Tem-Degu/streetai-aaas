import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useFetch, useApi } from '../hooks/useApi.js';
import { HiEllipsisVertical } from 'react-icons/hi2';

const NAME_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#ef4444', '#f97316',
  '#eab308', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6',
];
function nameColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return NAME_COLORS[Math.abs(hash) % NAME_COLORS.length];
}

export default function Hub() {
  const { data, loading, error, refetch } = useFetch('/api/hub/workspaces');
  const api = useApi();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [photo, setPhoto] = useState(null);
  const [photoPreview, setPhotoPreview] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [menuOpen, setMenuOpen] = useState(null);
  const [editing, setEditing] = useState(null);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editPhoto, setEditPhoto] = useState(null);
  const [editPhotoPreview, setEditPhotoPreview] = useState(null);
  const [editPhotoRemoved, setEditPhotoRemoved] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const menuRef = useRef(null);

  // Close menu on outside click
  useEffect(() => {
    const handler = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(null);
    };
    if (menuOpen) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const handleEditPhotoChange = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      setEditPhoto(file);
      setEditPhotoPreview(URL.createObjectURL(file));
    }
  };

  const handleEdit = async (dir) => {
    if (!editName.trim()) return;
    setEditSaving(true);
    try {
      const formData = new FormData();
      formData.append('name', editName.trim());
      formData.append('description', editDesc.trim());
      if (editPhoto) formData.append('photo', editPhoto);
      if (editPhotoRemoved) formData.append('removePhoto', 'true');
      const resp = await fetch(`/api/hub/workspaces/${dir}`, { method: 'PATCH', body: formData });
      const result = await resp.json();
      if (!resp.ok) throw new Error(result.error || 'Failed');
      setEditing(null);
      setEditPhoto(null);
      setEditPhotoPreview(null);
      setEditPhotoRemoved(false);
      refetch();
    } catch (err) {
      alert('Failed: ' + err.message);
    }
    setEditSaving(false);
  };

  const handleDelete = async (dir) => {
    if (deleteConfirm !== dir) {
      setDeleteError(`Type "${dir}" to confirm`);
      return;
    }
    setEditSaving(true);
    try {
      await api.del(`/api/hub/workspaces/${dir}`);
      setDeleting(null);
      setDeleteConfirm('');
      setDeleteError('');
      refetch();
    } catch (err) {
      setDeleteError(err.message);
    }
    setEditSaving(false);
  };

  const navigate = useNavigate();

  if (loading) return <div className="page-loading">Loading...</div>;
  if (error) return <div className="empty">Error: {error}</div>;

  const workspaces = data?.workspaces || [];

  const handlePhotoChange = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      setPhoto(file);
      setPhotoPreview(URL.createObjectURL(file));
    }
  };

  const handleCreate = async () => {
    if (!name.trim()) { setFormError('Name is required'); return; }
    setSaving(true);
    setFormError('');
    try {
      const formData = new FormData();
      formData.append('name', name.trim());
      formData.append('description', description.trim());
      if (photo) formData.append('photo', photo);
      const resp = await fetch('/api/hub/workspaces', { method: 'POST', body: formData });
      const result = await resp.json();
      if (!resp.ok) throw new Error(result.error || 'Failed');
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
              <div className="form-group">
                <label>Photo <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 }}>
                  {photoPreview ? (
                    <img src={photoPreview} alt="Preview" style={{ width: 48, height: 48, borderRadius: 10, objectFit: 'cover' }} />
                  ) : (
                    <div style={{ width: 48, height: 48, borderRadius: 10, background: 'var(--bg-input)', border: '1px dashed var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 18 }}>
                      {name.trim() ? name.trim().charAt(0).toUpperCase() : '?'}
                    </div>
                  )}
                  <div>
                    <label className="btn btn-sm" style={{ cursor: 'pointer' }}>
                      Choose image
                      <input type="file" accept="image/*" onChange={handlePhotoChange} style={{ display: 'none' }} />
                    </label>
                    {photo && (
                      <button className="btn btn-sm" style={{ marginLeft: 6 }} onClick={() => { setPhoto(null); setPhotoPreview(null); }}>Remove</button>
                    )}
                  </div>
                </div>
              </div>
              {formError && <p className="form-hint" style={{ color: 'var(--red)' }}>{formError}</p>}
              <div className="form-actions" style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-primary" onClick={handleCreate} disabled={saving}>{saving ? 'Creating...' : 'Create'}</button>
                <button className="btn" onClick={() => { setCreating(false); setFormError(''); setPhoto(null); setPhotoPreview(null); }}>Cancel</button>
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
        <>
        <div className="deploy-grid">
          {workspaces.map(ws => (
            <div key={ws.directory} className={`card deploy-card ${ws.isRunning ? 'deploy-active' : ''}`} onClick={() => navigate(`/ws/${ws.directory}`)} style={{ cursor: 'pointer', position: 'relative' }}>
              <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {ws.photo ? (
                  <span className="deploy-platform-icon" style={{ padding: 0, overflow: 'hidden' }}>
                    <img src={ws.photo} alt={ws.name} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 8 }} />
                  </span>
                ) : (
                  <span className="deploy-platform-icon" style={{
                    background: nameColor(ws.name),
                    color: '#fff', fontWeight: 700, fontSize: 15,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    {ws.name.charAt(0).toUpperCase()}
                  </span>
                )}
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ws.name}</span>
                <span className={`badge ${ws.isRunning ? 'badge-green' : 'badge-gray'}`}>
                  {ws.isRunning ? 'running' : 'stopped'}
                </span>
                <button
                  className="btn btn-sm"
                  style={{ padding: '2px 4px', minWidth: 0, background: 'transparent', border: 'none', color: 'var(--text)', flexShrink: 0 }}
                  onClick={(e) => { e.stopPropagation(); setMenuOpen(menuOpen === ws.directory ? null : ws.directory); }}
                >
                  <HiEllipsisVertical size={18} />
                </button>
              </div>

              {menuOpen === ws.directory && (
                <div ref={menuRef} style={{
                  position: 'absolute', right: 12, top: 44, zIndex: 10,
                  background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8,
                  boxShadow: '0 4px 16px rgba(0,0,0,0.25)', overflow: 'hidden', minWidth: 140,
                }} onClick={(e) => e.stopPropagation()}>
                  <button style={{
                    display: 'block', width: '100%', padding: '10px 16px', border: 'none',
                    background: 'none', color: 'var(--text)', fontSize: 13, cursor: 'pointer',
                    textAlign: 'left',
                  }} onMouseEnter={e => e.target.style.background = 'var(--bg-secondary)'}
                     onMouseLeave={e => e.target.style.background = 'none'}
                     onClick={() => {
                       setMenuOpen(null);
                       setEditName(ws.name);
                       setEditDesc('');
                       setEditPhoto(null);
                       setEditPhotoPreview(ws.photo || null);
                       setEditPhotoRemoved(false);
                       setEditing(ws.directory);
                     }}>
                    Edit
                  </button>
                  <button style={{
                    display: 'block', width: '100%', padding: '10px 16px', border: 'none',
                    background: 'none', color: 'var(--red)', fontSize: 13, cursor: 'pointer',
                    textAlign: 'left',
                  }} onMouseEnter={e => e.target.style.background = 'var(--bg-secondary)'}
                     onMouseLeave={e => e.target.style.background = 'none'}
                     disabled={ws.isRunning}
                     onClick={() => {
                       if (ws.isRunning) { alert('Stop the agent before deleting.'); return; }
                       setMenuOpen(null);
                       setDeleteConfirm('');
                       setDeleteError('');
                       setDeleting(ws.directory);
                     }}>
                    Delete
                  </button>
                </div>
              )}

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
                    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4, justifyContent: 'flex-end' }}>
                      {ws.connections.map(c => {
                        const running = c.status === 'connected';
                        return (
                          <span
                            key={c.platform}
                            className={`badge ${running ? 'badge-green' : 'badge-gray'}`}
                            title={running ? `${c.platform} is running` : `${c.platform} is stopped`}
                          >
                            {c.platform}
                          </span>
                        );
                      })}
                    </span>
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

        {/* Edit modal */}
        {editing && (
          <div style={{
            position: 'fixed', inset: 0, zIndex: 100,
            background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }} onClick={() => setEditing(null)}>
            <div className="card" style={{ maxWidth: 440, width: '90%' }} onClick={(e) => e.stopPropagation()}>
              <div className="card-header">Edit Agent</div>
              <div className="card-body">
                <div className="form-group">
                  <label>Name</label>
                  <input type="text" value={editName} onChange={e => setEditName(e.target.value)} className="form-input" autoFocus />
                </div>
                <div className="form-group">
                  <label>Description</label>
                  <textarea value={editDesc} onChange={e => setEditDesc(e.target.value)} className="form-input" rows={3} placeholder="What does this agent do?" />
                </div>
                <div className="form-group">
                  <label>Photo</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 }}>
                    {editPhotoPreview ? (
                      <img src={editPhotoPreview} alt="Preview" style={{ width: 48, height: 48, borderRadius: 10, objectFit: 'cover' }} />
                    ) : (
                      <div style={{ width: 48, height: 48, borderRadius: 10, background: nameColor(editName || '?'), display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: 18 }}>
                        {(editName || '?').charAt(0).toUpperCase()}
                      </div>
                    )}
                    <div>
                      <label className="btn btn-sm" style={{ cursor: 'pointer' }}>
                        {editPhotoPreview ? 'Change' : 'Upload'}
                        <input type="file" accept="image/*" onChange={handleEditPhotoChange} style={{ display: 'none' }} />
                      </label>
                      {editPhotoPreview && (
                        <button className="btn btn-sm" style={{ marginLeft: 6 }} onClick={() => { setEditPhoto(null); setEditPhotoPreview(null); setEditPhotoRemoved(true); }}>Remove</button>
                      )}
                    </div>
                  </div>
                </div>
                <div className="form-actions" style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-primary" onClick={() => handleEdit(editing)} disabled={editSaving}>
                    {editSaving ? 'Saving...' : 'Save'}
                  </button>
                  <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Delete confirmation modal */}
        {deleting && (
          <div style={{
            position: 'fixed', inset: 0, zIndex: 100,
            background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }} onClick={() => { setDeleting(null); setDeleteError(''); }}>
            <div className="card" style={{ maxWidth: 440, width: '90%' }} onClick={(e) => e.stopPropagation()}>
              <div className="card-header" style={{ color: 'var(--red)' }}>Delete Agent</div>
              <div className="card-body">
                <p style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--text)' }}>
                  This will <strong>permanently delete</strong> the agent workspace <strong>{deleting}/</strong> and all its data, skills, connections, and files. This cannot be undone.
                </p>
                <div className="form-group" style={{ marginTop: 12 }}>
                  <label>Type <strong>{deleting}</strong> to confirm</label>
                  <input
                    type="text"
                    value={deleteConfirm}
                    onChange={e => { setDeleteConfirm(e.target.value); setDeleteError(''); }}
                    className="form-input"
                    placeholder={deleting}
                    autoFocus
                  />
                </div>
                {deleteError && <p className="form-hint" style={{ color: 'var(--red)', marginTop: 4 }}>{deleteError}</p>}
                <div className="form-actions" style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button
                    className="btn btn-danger"
                    onClick={() => handleDelete(deleting)}
                    disabled={editSaving}
                  >
                    {editSaving ? 'Deleting...' : 'Delete Permanently'}
                  </button>
                  <button className="btn" onClick={() => { setDeleting(null); setDeleteError(''); }}>Cancel</button>
                </div>
              </div>
            </div>
          </div>
        )}
        </>
      )}
    </div>
  );
}
