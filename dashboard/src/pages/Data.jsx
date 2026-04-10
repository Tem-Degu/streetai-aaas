import React, { useState, useRef, useCallback } from 'react';
import { useFetch, useApi, useResolveUrl } from '../hooks/useApi.js';

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function formatDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fileIcon(entry) {
  if (entry.type === 'folder') return <IconFolder />;
  const ext = entry.name.split('.').pop().toLowerCase();
  if (ext === 'json') return <IconJson />;
  if (['csv', 'tsv'].includes(ext)) return <IconTable />;
  if (['md', 'txt', 'log'].includes(ext)) return <IconText />;
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return <IconImage />;
  return <IconFile />;
}

export default function Data() {
  const api = useApi();
  const resolveUrl = useResolveUrl();
  const [currentPath, setCurrentPath] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const { data: entries, loading, error, refetch } = useFetch(`/api/data?path=${encodeURIComponent(currentPath)}`);
  const [showCreate, setShowCreate] = useState(null); // 'file' | 'folder' | null
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);

  const breadcrumbs = currentPath ? currentPath.split('/') : [];

  function navigateTo(subpath) {
    setCurrentPath(subpath);
    setSelectedFile(null);
    setShowCreate(null);
  }

  function navigateBreadcrumb(index) {
    if (index < 0) navigateTo('');
    else navigateTo(breadcrumbs.slice(0, index + 1).join('/'));
  }

  function handleEntryClick(entry) {
    if (entry.type === 'folder') {
      navigateTo(entry.path);
    } else {
      setSelectedFile(entry);
    }
  }

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const body = { parentPath: currentPath };
      if (showCreate === 'folder') body.folder = newName.trim();
      else body.filename = newName.trim();
      await api.post('/api/data', body);
      setNewName('');
      setShowCreate(null);
      refetch();
    } catch (e) { alert(e.message); }
    setCreating(false);
  }

  async function handleDelete(entry) {
    const label = entry.type === 'folder' ? 'folder and all its contents' : 'file';
    if (!confirm(`Delete ${label} "${entry.name}"?`)) return;
    try {
      await api.del(`/api/data/${entry.path}`);
      refetch();
    } catch (e) { alert(e.message); }
  }

  async function uploadFiles(files) {
    setUploading(true);
    for (const file of files) {
      try {
        const buf = await file.arrayBuffer();
        const res = await fetch(resolveUrl('/api/data/upload'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Filename': file.name,
            'X-Path': currentPath,
          },
          body: buf,
        });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      } catch (e) {
        alert(`Failed to upload ${file.name}: ${e.message}`);
      }
    }
    setUploading(false);
    refetch();
  }

  function handleFileInputChange(e) {
    const files = Array.from(e.target.files);
    if (files.length > 0) uploadFiles(files);
    e.target.value = '';
  }

  function handleDrop(e) {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) uploadFiles(files);
  }

  function handleDragOver(e) {
    e.preventDefault();
    setDragging(true);
  }

  if (selectedFile) {
    return <FileView entry={selectedFile} onBack={() => { setSelectedFile(null); refetch(); }} resolveUrl={resolveUrl} />;
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Data</h1>
        <p className="page-desc">Agent workspace files</p>
      </div>

      {/* Breadcrumb */}
      <div className="explorer-breadcrumb">
        <button className="breadcrumb-item" onClick={() => navigateBreadcrumb(-1)}>
          data
        </button>
        {breadcrumbs.map((seg, i) => (
          <span key={i}>
            <span className="breadcrumb-sep">/</span>
            <button className="breadcrumb-item" onClick={() => navigateBreadcrumb(i)}>
              {seg}
            </button>
          </span>
        ))}
      </div>

      {/* Toolbar */}
      <div className="explorer-toolbar">
        <button className="btn" onClick={() => { setShowCreate('file'); setNewName(''); }}>New File</button>
        <button className="btn" onClick={() => { setShowCreate('folder'); setNewName(''); }}>New Folder</button>
        <input ref={fileInputRef} type="file" multiple onChange={handleFileInputChange} style={{ display: 'none' }} />
        <button className="btn" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
          {uploading ? 'Uploading...' : 'Upload'}
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="explorer-create">
          <input
            className="form-input"
            style={{ flex: 1, maxWidth: 280 }}
            placeholder={showCreate === 'folder' ? 'folder-name' : 'filename.json'}
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setShowCreate(null); }}
            autoFocus
          />
          <button className="btn btn-primary" onClick={handleCreate} disabled={creating}>Create</button>
          <button className="btn" onClick={() => setShowCreate(null)}>Cancel</button>
        </div>
      )}

      {/* File list / drop zone */}
      <div
        className={`explorer-list ${dragging ? 'explorer-list-dragging' : ''}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={() => setDragging(false)}
      >
        {loading ? (
          <div className="explorer-empty">Loading...</div>
        ) : error ? (
          <div className="explorer-empty">Error: {error}</div>
        ) : (!entries || entries.length === 0) ? (
          <div className="explorer-empty">
            {dragging ? 'Drop files here' : 'Empty folder. Create files, upload, or drag & drop.'}
          </div>
        ) : (
          <table className="explorer-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Size</th>
                <th>Modified</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {entries.map(entry => (
                <tr key={entry.name} className="explorer-row" onDoubleClick={() => handleEntryClick(entry)}>
                  <td className="explorer-name" onClick={() => handleEntryClick(entry)}>
                    <span className="explorer-icon">{fileIcon(entry)}</span>
                    <span>{entry.name}</span>
                    {entry.records != null && <span className="explorer-meta">{entry.records} records</span>}
                  </td>
                  <td className="explorer-size">{entry.type === 'folder' ? '' : formatBytes(entry.size)}</td>
                  <td className="explorer-date">{formatDate(entry.modified)}</td>
                  <td className="explorer-actions">
                    <button className="btn-icon" onClick={() => handleDelete(entry)} title="Delete">✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/* ─── File type helpers ─── */

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'];
const AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'webm'];
const VIDEO_EXTS = ['mp4', 'webm', 'ogv', 'mov', 'avi', 'mkv'];
const PDF_EXTS = ['pdf'];

function getFileExt(name) {
  return (name || '').split('.').pop().toLowerCase();
}

function isBinaryFile(name) {
  const ext = getFileExt(name);
  return [...IMAGE_EXTS, ...AUDIO_EXTS, ...VIDEO_EXTS, ...PDF_EXTS,
    'zip', 'tar', 'gz', '7z', 'rar', 'exe', 'dll', 'so', 'dylib',
    'woff', 'woff2', 'ttf', 'otf', 'eot',
    'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  ].includes(ext);
}

/* ─── Binary File View ─── */

function BinaryFileView({ entry, onBack, resolveUrl }) {
  const ext = getFileExt(entry.name);
  const rawUrl = resolveUrl(`/api/data/file/${entry.path}`);

  return (
    <div>
      <div className="detail-header">
        <button className="btn-back" onClick={onBack}>&larr; Back</button>
        <h1 className="page-title">{entry.name}</h1>
      </div>
      <div className="card" style={{ padding: 24 }}>
        {IMAGE_EXTS.includes(ext) ? (
          <div style={{ textAlign: 'center' }}>
            <img
              src={rawUrl}
              alt={entry.name}
              style={{ maxWidth: '100%', maxHeight: 500, borderRadius: 8, background: 'var(--bg-card)' }}
            />
          </div>
        ) : AUDIO_EXTS.includes(ext) ? (
          <div style={{ textAlign: 'center' }}>
            <audio controls src={rawUrl} style={{ width: '100%', maxWidth: 480 }}>
              Your browser does not support audio playback.
            </audio>
          </div>
        ) : VIDEO_EXTS.includes(ext) ? (
          <div style={{ textAlign: 'center' }}>
            <video controls src={rawUrl} style={{ maxWidth: '100%', maxHeight: 500, borderRadius: 8 }}>
              Your browser does not support video playback.
            </video>
          </div>
        ) : PDF_EXTS.includes(ext) ? (
          <iframe
            src={rawUrl}
            title={entry.name}
            style={{ width: '100%', height: 600, border: 'none', borderRadius: 8 }}
          />
        ) : (
          <div className="explorer-empty" style={{ textAlign: 'center' }}>
            <p style={{ marginBottom: 12 }}>This file type cannot be previewed.</p>
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginTop: 16 }}>
          <a href={rawUrl} download={entry.name} className="btn btn-primary" style={{ textDecoration: 'none' }}>
            Download
          </a>
          <span style={{ color: 'var(--text-muted)', fontSize: 13, alignSelf: 'center' }}>
            {formatBytes(entry.size)}
          </span>
        </div>
      </div>
    </div>
  );
}

/* ─── File View ─── */

function FileView({ entry, onBack, resolveUrl }) {
  const { data, loading, error, refetch } = useFetch(`/api/data/${entry.path}`);
  const { put } = useApi();
  const [view, setView] = useState('ui');
  const [editing, setEditing] = useState(null);
  const [editData, setEditData] = useState(null);
  const [adding, setAdding] = useState(false);
  const [addData, setAddData] = useState('');
  const [rawEdit, setRawEdit] = useState('');
  const [rawEditing, setRawEditing] = useState(false);

  if (isBinaryFile(entry.name)) {
    return <BinaryFileView entry={entry} onBack={onBack} resolveUrl={resolveUrl} />;
  }

  if (loading) return <div className="page-loading">Loading {entry.name}</div>;
  if (error) return <div className="explorer-empty">Error: {error}</div>;

  const jsonData = data?.data;
  const rawContent = jsonData ? JSON.stringify(jsonData, null, 2) : data?.content || '';
  const isJsonArray = Array.isArray(jsonData);
  const isJsonObject = jsonData && typeof jsonData === 'object' && !isJsonArray;

  async function saveArray(newArray) {
    await put(`/api/data/${entry.path}`, { data: newArray });
    refetch();
  }

  async function handleDeleteRecord(index) {
    const updated = [...jsonData];
    updated.splice(index, 1);
    await saveArray(updated);
  }

  async function handleSaveEdit() {
    const updated = [...jsonData];
    updated[editing] = editData;
    await saveArray(updated);
    setEditing(null);
    setEditData(null);
  }

  async function handleAddRecord() {
    try {
      const parsed = JSON.parse(addData);
      const updated = [...(jsonData || []), parsed];
      await saveArray(updated);
      setAdding(false);
      setAddData('');
    } catch { alert('Invalid JSON'); }
  }

  async function handleSaveRaw() {
    try {
      if (entry.name.endsWith('.json')) {
        const parsed = JSON.parse(rawEdit);
        await put(`/api/data/${entry.path}`, { data: parsed });
      } else {
        await put(`/api/data/${entry.path}`, { content: rawEdit });
      }
      setRawEditing(false);
      refetch();
    } catch { alert('Invalid JSON'); }
  }

  return (
    <div>
      <div className="detail-header">
        <button className="btn-back" onClick={onBack}>&larr; Back</button>
        <h1 className="page-title">{entry.name}</h1>
      </div>

      {(isJsonArray || isJsonObject) && (
        <div className="btn-group" style={{ marginBottom: 16 }}>
          <button className={`btn ${view === 'ui' ? 'btn-primary' : ''}`} onClick={() => setView('ui')}>Visual</button>
          <button className={`btn ${view === 'raw' ? 'btn-primary' : ''}`} onClick={() => setView('raw')}>Raw JSON</button>
          {isJsonArray && (
            <>
              <span style={{ color: 'var(--text-muted)', fontSize: 13, alignSelf: 'center', marginLeft: 8 }}>
                {jsonData.length} record{jsonData.length !== 1 ? 's' : ''}
              </span>
              {view === 'ui' && (
                <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => { setAdding(true); setAddData('{\n  \n}'); }}>
                  + Add Record
                </button>
              )}
            </>
          )}
          {view === 'raw' && !rawEditing && (
            <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => { setRawEdit(rawContent); setRawEditing(true); }}>Edit</button>
          )}
        </div>
      )}

      {/* Non-JSON files get raw view */}
      {!isJsonArray && !isJsonObject && (
        <div className="btn-group" style={{ marginBottom: 16 }}>
          {!rawEditing ? (
            <button className="btn" onClick={() => { setRawEdit(rawContent); setRawEditing(true); }}>Edit</button>
          ) : null}
        </div>
      )}

      {adding && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-title">New Record (JSON)</div>
          <textarea className="editor" style={{ minHeight: 120 }} value={addData} onChange={e => setAddData(e.target.value)} spellCheck={false} />
          <div className="save-bar">
            <button className="btn btn-primary" onClick={handleAddRecord}>Add</button>
            <button className="btn" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      )}

      {view === 'raw' || (!isJsonArray && !isJsonObject) ? (
        rawEditing ? (
          <div>
            <textarea className="editor" value={rawEdit} onChange={e => setRawEdit(e.target.value)} spellCheck={false} />
            <div className="save-bar">
              <button className="btn btn-primary" onClick={handleSaveRaw}>Save</button>
              <button className="btn" onClick={() => setRawEditing(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <pre className="editor code-block" style={{ overflow: 'auto', cursor: 'default' }}>{rawContent || '(empty file)'}</pre>
        )
      ) : isJsonArray ? (
        <ArrayView
          data={jsonData}
          editing={editing}
          editData={editData}
          onEdit={(i) => { setEditing(i); setEditData({ ...jsonData[i] }); }}
          onEditChange={setEditData}
          onSaveEdit={handleSaveEdit}
          onCancelEdit={() => { setEditing(null); setEditData(null); }}
          onDelete={handleDeleteRecord}
        />
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <ObjectCard data={jsonData} />
        </div>
      )}
    </div>
  );
}

/* ─── Array of objects → card list with edit/delete ─── */

function ArrayView({ data, editing, editData, onEdit, onEditChange, onSaveEdit, onCancelEdit, onDelete }) {
  if (data.length === 0) return <div className="explorer-empty">Empty array. Add a record to get started.</div>;

  if (data.every(item => item && typeof item === 'object' && !Array.isArray(item))) {
    return (
      <div className="data-cards">
        {data.map((item, i) => (
          editing === i ? (
            <RecordEditor key={i} data={editData} onChange={onEditChange} onSave={onSaveEdit} onCancel={onCancelEdit} />
          ) : (
            <RecordCard key={item.id || item.name || i} item={item} index={i} onEdit={() => onEdit(i)} onDelete={() => onDelete(i)} />
          )
        ))}
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: 0 }}>
      {data.map((item, i) => (
        <div key={i} className="data-row"><CellValue value={item} /></div>
      ))}
    </div>
  );
}

function RecordEditor({ data, onChange, onSave, onCancel }) {
  const [json, setJson] = useState(JSON.stringify(data, null, 2));
  function handleSave() {
    try { onChange(JSON.parse(json)); setTimeout(onSave, 0); } catch { alert('Invalid JSON'); }
  }
  return (
    <div className="record-card">
      <div className="record-card-header"><span className="record-card-title">Editing Record</span></div>
      <div style={{ padding: 12 }}>
        <textarea className="editor" style={{ minHeight: 180 }} value={json} onChange={e => setJson(e.target.value)} spellCheck={false} />
        <div className="save-bar">
          <button className="btn btn-primary" onClick={handleSave}>Save</button>
          <button className="btn" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function RecordCard({ item, index, onEdit, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  const title = item.name || item.title || item.id || `Record ${index + 1}`;
  const subtitle = item.type || item.role || item.status || item.category || null;
  const entries = Object.entries(item);
  const titleKeys = ['name', 'title', 'id'];
  const simpleFields = [];
  const complexFields = [];

  for (const [key, val] of entries) {
    if (titleKeys.includes(key)) continue;
    if (val === null || val === undefined) continue;
    if (Array.isArray(val) || (typeof val === 'object' && val !== null)) complexFields.push([key, val]);
    else simpleFields.push([key, val]);
  }

  const previewFields = expanded ? simpleFields : simpleFields.slice(0, 6);
  const hasMore = !expanded && (simpleFields.length > 6 || complexFields.length > 0);

  return (
    <div className="record-card">
      <div className="record-card-header" onClick={() => setExpanded(!expanded)}>
        <div>
          <span className="record-card-title">{title}</span>
          {subtitle && <span className="record-card-subtitle">{subtitle}</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button className="btn-inline" onClick={e => { e.stopPropagation(); onEdit(); }}>Edit</button>
          <button className="btn-inline danger" onClick={e => { e.stopPropagation(); onDelete(); }}>Delete</button>
          <span className="record-card-toggle">{expanded ? '\u25B2' : '\u25BC'}</span>
        </div>
      </div>
      <div className="record-card-body">
        {previewFields.map(([key, val]) => (
          <div key={key} className="field-row">
            <span className="field-key">{formatKey(key)}</span>
            <span className="field-value"><CellValue value={val} /></span>
          </div>
        ))}
        {expanded && complexFields.map(([key, val]) => (
          <div key={key} className="field-row field-row-complex">
            <span className="field-key">{formatKey(key)}</span>
            <div className="field-value">
              {Array.isArray(val) ? <TagList items={val} /> : <NestedObject data={val} />}
            </div>
          </div>
        ))}
        {hasMore && (
          <div className="record-card-more" onClick={() => setExpanded(true)}>
            Show all fields ({simpleFields.length + complexFields.length - 6} more)
          </div>
        )}
      </div>
    </div>
  );
}

function ObjectCard({ data }) {
  return (
    <div style={{ padding: 4 }}>
      {Object.entries(data).map(([key, val]) => (
        <div key={key} className="field-row" style={{ padding: '10px 18px' }}>
          <span className="field-key">{formatKey(key)}</span>
          <span className="field-value">
            {Array.isArray(val) ? <TagList items={val} /> : (val && typeof val === 'object') ? <NestedObject data={val} /> : <CellValue value={val} />}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ─── Sub-components ─── */

function TagList({ items }) {
  if (items.length === 0) return <span className="field-empty">—</span>;
  if (items.every(i => typeof i !== 'object')) {
    return <div className="tag-list">{items.map((item, i) => <span key={i} className="tag">{String(item)}</span>)}</div>;
  }
  return <span style={{ color: 'var(--text-muted)' }}>{items.length} items</span>;
}

function NestedObject({ data }) {
  if (!data || typeof data !== 'object') return <CellValue value={data} />;
  return (
    <div className="nested-obj">
      {Object.entries(data).map(([key, val]) => (
        <div key={key} className="nested-row">
          <span className="nested-key">{formatKey(key)}</span>
          {Array.isArray(val) ? <TagList items={val} /> : (typeof val === 'object' && val !== null) ? <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{JSON.stringify(val)}</span> : <CellValue value={val} />}
        </div>
      ))}
    </div>
  );
}

function CellValue({ value }) {
  if (value === null || value === undefined) return <span className="field-empty">null</span>;
  if (typeof value === 'boolean') return <span className={value ? 'val-true' : 'val-false'}>{String(value)}</span>;
  if (typeof value === 'number') return <span className="val-number">{value}</span>;
  return <span>{String(value)}</span>;
}

function formatKey(key) {
  return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/* ─── File Icons ─── */

function IconFolder() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M2 5.5V14a1 1 0 001 1h12a1 1 0 001-1V7a1 1 0 00-1-1H9L7.5 4H3a1 1 0 00-1 1.5z" fill="#c9a84c" opacity="0.7" />
    </svg>
  );
}

function IconJson() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="#6a9fd8" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 4a2 2 0 00-2 2v1.5a1.5 1.5 0 01-1 1.5 1.5 1.5 0 011 1.5V12a2 2 0 002 2" />
      <path d="M13 4a2 2 0 012 2v1.5a1.5 1.5 0 001 1.5 1.5 1.5 0 00-1 1.5V12a2 2 0 01-2 2" />
    </svg>
  );
}

function IconTable() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="#5cba72" strokeWidth="1.5" strokeLinecap="round">
      <rect x="2" y="3" width="14" height="12" rx="1.5" />
      <line x1="2" y1="7" x2="16" y2="7" />
      <line x1="6" y1="3" x2="6" y2="15" />
    </svg>
  );
}

function IconText() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M5 3h8a1 1 0 011 1v10a1 1 0 01-1 1H5a1 1 0 01-1-1V4a1 1 0 011-1z" />
      <line x1="6.5" y1="7" x2="11.5" y2="7" />
      <line x1="6.5" y1="9.5" x2="10" y2="9.5" />
      <line x1="6.5" y1="12" x2="11" y2="12" />
    </svg>
  );
}

function IconImage() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="#9a9a9f" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="14" height="12" rx="1.5" />
      <circle cx="6" cy="7" r="1.5" />
      <path d="M16 12l-4-4-6 6" />
    </svg>
  );
}

function IconFile() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 2H5a1 1 0 00-1 1v12a1 1 0 001 1h8a1 1 0 001-1V6l-4-4z" />
      <polyline points="10,2 10,6 14,6" />
    </svg>
  );
}
