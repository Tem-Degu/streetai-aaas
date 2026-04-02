import React, { useState } from 'react';
import { useFetch, useApi } from '../hooks/useApi.js';

const TYPES = [
  { value: 'api', label: 'API', desc: 'External REST API' },
  { value: 'agent', label: 'Agent', desc: 'Another AaaS agent' },
  { value: 'human', label: 'Human', desc: 'Human escalation contact' },
  { value: 'tool', label: 'Tool', desc: 'Local script or binary' },
];

const AUTH_TYPES = [
  { value: 'none', label: 'None' },
  { value: 'bearer', label: 'Bearer Token' },
  { value: 'header', label: 'Custom Header' },
  { value: 'query', label: 'Query Parameter' },
  { value: 'basic', label: 'Basic Auth' },
];

const EMPTY_EXT = {
  name: '', type: 'api', description: '', endpoint: '', address: '', command: '',
  capabilities: '', cost_model: 'free', cost: '', notes: '',
  authType: 'none', authKey: '', authHeader: '',
  headers: '',
};

function formFromExt(ext) {
  return {
    name: ext.name || '',
    type: ext.type || 'api',
    description: ext.description || '',
    endpoint: ext.endpoint || '',
    address: ext.address || '',
    command: ext.command || '',
    capabilities: (ext.capabilities || []).join(', '),
    cost_model: ext.cost_model || ext.cost_per_call ? 'per_request' : 'free',
    cost: ext.cost || ext.cost_per_call || '',
    notes: ext.notes || '',
    authType: ext.auth?.type || (ext.auth?.apiKey ? 'bearer' : 'none'),
    authKey: ext.auth?.apiKey || '',
    authHeader: ext.auth?.header || '',
    headers: ext.headers ? Object.entries(ext.headers).map(([k, v]) => `${k}: ${v}`).join('\n') : '',
  };
}

function extFromForm(form) {
  const ext = {
    name: form.name.trim(),
    type: form.type,
  };

  if (form.description.trim()) ext.description = form.description.trim();

  // Type-specific fields
  if (form.type === 'api' && form.endpoint.trim()) {
    ext.endpoint = form.endpoint.trim();
  }
  if ((form.type === 'agent' || form.type === 'human') && form.address.trim()) {
    ext.address = form.address.trim();
  }
  if (form.type === 'tool' && form.command.trim()) {
    ext.command = form.command.trim();
  }

  // Capabilities
  const caps = form.capabilities.split(',').map(s => s.trim()).filter(Boolean);
  if (caps.length > 0) ext.capabilities = caps;

  // Cost
  if (form.cost_model && form.cost_model !== 'free') {
    ext.cost_model = form.cost_model;
    if (form.cost.trim()) ext.cost = form.cost.trim();
  } else {
    ext.cost_model = 'free';
  }

  // Notes
  if (form.notes.trim()) ext.notes = form.notes.trim();

  // Auth
  if (form.authType !== 'none' && form.authKey.trim()) {
    ext.auth = {
      type: form.authType,
      apiKey: form.authKey.trim(),
    };
    if ((form.authType === 'header' || form.authType === 'query') && form.authHeader.trim()) {
      ext.auth.header = form.authHeader.trim();
    }
  }

  // Custom headers
  if (form.headers.trim()) {
    const headers = {};
    for (const line of form.headers.trim().split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) {
        headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }
    if (Object.keys(headers).length > 0) ext.headers = headers;
  }

  return ext;
}

// Type-specific icons
function TypeIcon({ type }) {
  const icons = { api: '⚡', agent: '🤖', human: '👤', tool: '🔧' };
  return <span style={{ fontSize: 18, marginRight: 6 }}>{icons[type] || '📦'}</span>;
}

export default function Extensions() {
  const { data, loading, error, refetch } = useFetch('/api/extensions');
  const { put } = useApi();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_EXT });
  const [editIndex, setEditIndex] = useState(null);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(null);

  function setField(key, val) {
    setForm(f => ({ ...f, [key]: val }));
  }

  async function handleSave() {
    if (!form.name.trim()) return alert('Name is required');
    if (form.type === 'api' && !form.endpoint.trim()) return alert('Endpoint URL is required for API extensions');
    if (form.type === 'agent' && !form.address.trim()) return alert('Agent address is required');
    if (form.type === 'human' && !form.address.trim()) return alert('Contact address is required');
    if (form.type === 'tool' && !form.command.trim()) return alert('Command is required for tool extensions');

    setSaving(true);
    const ext = extFromForm(form);
    const current = data || [];
    let updated;
    if (editIndex !== null) {
      updated = [...current];
      updated[editIndex] = ext;
    } else {
      updated = [...current, ext];
    }

    await put('/api/extensions', updated);
    setShowForm(false);
    setForm({ ...EMPTY_EXT });
    setEditIndex(null);
    setSaving(false);
    refetch();
  }

  async function handleRemove(index) {
    if (!confirm(`Remove "${data[index].name}"?`)) return;
    const updated = data.filter((_, i) => i !== index);
    await put('/api/extensions', updated);
    refetch();
  }

  function handleEdit(index) {
    setForm(formFromExt(data[index]));
    setEditIndex(index);
    setShowForm(true);
    setTestResult(null);
  }

  function handleCancel() {
    setShowForm(false);
    setForm({ ...EMPTY_EXT });
    setEditIndex(null);
    setTestResult(null);
  }

  async function handleTest(index) {
    const ext = data[index];
    if (ext.type !== 'api' || !ext.endpoint) {
      setTestResult({ index, ok: false, msg: 'Only API extensions can be tested' });
      return;
    }
    setTesting(index);
    setTestResult(null);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const headers = {};
      if (ext.auth?.apiKey) {
        const authType = ext.auth.type || 'bearer';
        if (authType === 'bearer') headers['Authorization'] = `Bearer ${ext.auth.apiKey}`;
        else if (authType === 'header') headers[ext.auth.header || 'X-API-Key'] = ext.auth.apiKey;
        else if (authType === 'basic') headers['Authorization'] = `Basic ${btoa(ext.auth.apiKey)}`;
      }
      const res = await fetch(ext.endpoint, { method: 'GET', headers, signal: controller.signal });
      clearTimeout(timeout);
      setTestResult({ index, ok: res.ok, msg: `${res.status} ${res.statusText}` });
    } catch (err) {
      setTestResult({ index, ok: false, msg: err.name === 'AbortError' ? 'Timeout (10s)' : err.message });
    }
    setTesting(null);
  }

  if (loading) return <div className="loading">Loading extensions</div>;
  if (error) return <div className="empty">Error: {error}</div>;

  const grouped = { api: [], agent: [], human: [], tool: [] };
  (data || []).forEach((ext, i) => {
    const g = grouped[ext.type] || grouped.api;
    g.push({ ...ext, _index: i });
  });

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Extensions</h1>
        <p className="page-desc">External APIs, agents, tools, and contacts your agent can use</p>
      </div>

      {!showForm && (
        <div style={{ marginBottom: 16 }}>
          <button className="btn" onClick={() => { setForm({ ...EMPTY_EXT }); setEditIndex(null); setShowForm(true); }}>+ Add Extension</button>
        </div>
      )}

      {showForm && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-title">{editIndex !== null ? 'Edit Extension' : 'New Extension'}</div>

          {/* Row 1: Name + Type */}
          <div className="form-grid">
            <div className="form-field">
              <label className="form-label">Name *</label>
              <input className="input" value={form.name} onChange={e => setField('name', e.target.value)} placeholder="e.g. Stripe, Delivery API, Weather" />
            </div>
            <div className="form-field">
              <label className="form-label">Type *</label>
              <select className="input" value={form.type} onChange={e => setField('type', e.target.value)}>
                {TYPES.map(t => <option key={t.value} value={t.value}>{t.label} — {t.desc}</option>)}
              </select>
            </div>
          </div>

          {/* Description */}
          <div className="form-grid" style={{ marginTop: 8 }}>
            <div className="form-field" style={{ gridColumn: '1 / -1' }}>
              <label className="form-label">Description</label>
              <input className="input" value={form.description} onChange={e => setField('description', e.target.value)} placeholder="What does this extension do? The agent reads this to decide when to use it." />
            </div>
          </div>

          {/* Type-specific fields */}
          {form.type === 'api' && (
            <>
              <div className="form-grid" style={{ marginTop: 8 }}>
                <div className="form-field" style={{ gridColumn: '1 / -1' }}>
                  <label className="form-label">Endpoint URL *</label>
                  <input className="input" value={form.endpoint} onChange={e => setField('endpoint', e.target.value)} placeholder="https://api.stripe.com/v1" />
                  <span className="form-hint">Base URL. The agent appends specific paths when calling (e.g. /checkout/sessions).</span>
                </div>
              </div>

              {/* Auth section */}
              <div style={{ marginTop: 12, padding: '12px 14px', background: 'var(--bg-secondary)', borderRadius: 8 }}>
                <label className="form-label" style={{ marginBottom: 8, display: 'block' }}>Authentication</label>
                <div className="form-grid">
                  <div className="form-field">
                    <select className="input" value={form.authType} onChange={e => setField('authType', e.target.value)}>
                      {AUTH_TYPES.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
                    </select>
                  </div>
                  {form.authType !== 'none' && (
                    <div className="form-field">
                      <input
                        className="input"
                        type="password"
                        value={form.authKey}
                        onChange={e => setField('authKey', e.target.value)}
                        placeholder={form.authType === 'basic' ? 'username:password' : 'API key or token'}
                      />
                    </div>
                  )}
                </div>
                {(form.authType === 'header') && (
                  <div className="form-grid" style={{ marginTop: 8 }}>
                    <div className="form-field" style={{ gridColumn: '1 / -1' }}>
                      <input className="input" value={form.authHeader} onChange={e => setField('authHeader', e.target.value)} placeholder="Header name (e.g. X-API-Key)" />
                      <span className="form-hint">The header that carries the key. Default: X-API-Key</span>
                    </div>
                  </div>
                )}
                {(form.authType === 'query') && (
                  <div className="form-grid" style={{ marginTop: 8 }}>
                    <div className="form-field" style={{ gridColumn: '1 / -1' }}>
                      <input className="input" value={form.authHeader} onChange={e => setField('authHeader', e.target.value)} placeholder="Query param name (e.g. key, api_key)" />
                      <span className="form-hint">The URL parameter name. Default: key</span>
                    </div>
                  </div>
                )}
                {form.authType !== 'none' && (
                  <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-secondary)' }}>
                    {form.authType === 'bearer' && 'Sent as: Authorization: Bearer <key>'}
                    {form.authType === 'header' && `Sent as: ${form.authHeader || 'X-API-Key'}: <key>`}
                    {form.authType === 'query' && `Sent as: ?${form.authHeader || 'key'}=<key>`}
                    {form.authType === 'basic' && 'Sent as: Authorization: Basic <base64(user:pass)>'}
                  </div>
                )}
              </div>

              {/* Custom headers */}
              <div className="form-grid" style={{ marginTop: 8 }}>
                <div className="form-field" style={{ gridColumn: '1 / -1' }}>
                  <label className="form-label">Custom Headers</label>
                  <textarea
                    className="input"
                    value={form.headers}
                    onChange={e => setField('headers', e.target.value)}
                    placeholder={'Accept: application/json\nX-Custom-Header: value'}
                    rows={2}
                    style={{ fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }}
                  />
                  <span className="form-hint">One per line, format: Header-Name: value. Added to every request.</span>
                </div>
              </div>
            </>
          )}

          {(form.type === 'agent') && (
            <div className="form-grid" style={{ marginTop: 8 }}>
              <div className="form-field" style={{ gridColumn: '1 / -1' }}>
                <label className="form-label">Agent Address *</label>
                <input className="input" value={form.address} onChange={e => setField('address', e.target.value)} placeholder="agent_username or agent@platform" />
                <span className="form-hint">The agent's username or address on the platform. Your agent will message them directly.</span>
              </div>
            </div>
          )}

          {(form.type === 'human') && (
            <div className="form-grid" style={{ marginTop: 8 }}>
              <div className="form-field" style={{ gridColumn: '1 / -1' }}>
                <label className="form-label">Contact Address *</label>
                <input className="input" value={form.address} onChange={e => setField('address', e.target.value)} placeholder="username, email, or phone" />
                <span className="form-hint">How the agent reaches this person. Used for escalation on complex requests.</span>
              </div>
            </div>
          )}

          {(form.type === 'tool') && (
            <div className="form-grid" style={{ marginTop: 8 }}>
              <div className="form-field" style={{ gridColumn: '1 / -1' }}>
                <label className="form-label">Command *</label>
                <input className="input" value={form.command} onChange={e => setField('command', e.target.value)} placeholder="python3 extensions/tools/price_calc.py" style={{ fontFamily: 'monospace', fontSize: 12 }} />
                <span className="form-hint">Shell command to run. The agent passes input via stdin and reads stdout.</span>
              </div>
            </div>
          )}

          {/* Capabilities + Cost */}
          <div className="form-grid" style={{ marginTop: 8 }}>
            <div className="form-field" style={{ gridColumn: '1 / -1' }}>
              <label className="form-label">Capabilities</label>
              <input className="input" value={form.capabilities} onChange={e => setField('capabilities', e.target.value)} placeholder="e.g. create_checkout, verify_payment, refund" />
              <span className="form-hint">Comma-separated list. Helps the agent know what this extension can do.</span>
            </div>
          </div>

          <div className="form-grid" style={{ marginTop: 8 }}>
            <div className="form-field">
              <label className="form-label">Cost Model</label>
              <select className="input" value={form.cost_model} onChange={e => setField('cost_model', e.target.value)}>
                <option value="free">Free</option>
                <option value="per_request">Per Request</option>
                <option value="subscription">Subscription</option>
              </select>
            </div>
            {form.cost_model !== 'free' && (
              <div className="form-field">
                <label className="form-label">Cost</label>
                <input className="input" value={form.cost} onChange={e => setField('cost', e.target.value)} placeholder="e.g. $0.01 per call, 5 TK per search" />
              </div>
            )}
          </div>

          {/* Notes */}
          <div className="form-grid" style={{ marginTop: 8 }}>
            <div className="form-field" style={{ gridColumn: '1 / -1' }}>
              <label className="form-label">Notes</label>
              <textarea
                className="input"
                value={form.notes}
                onChange={e => setField('notes', e.target.value)}
                placeholder="Rate limits, restrictions, availability hours, special instructions..."
                rows={2}
                style={{ resize: 'vertical' }}
              />
              <span className="form-hint">Additional info the agent should know when using this extension.</span>
            </div>
          </div>

          <div className="save-bar">
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>{saving ? 'Saving...' : editIndex !== null ? 'Update' : 'Add Extension'}</button>
            <button className="btn" onClick={handleCancel}>Cancel</button>
          </div>
        </div>
      )}

      {(!data || data.length === 0) ? (
        <div className="empty">
          <p>No extensions registered yet.</p>
          <p style={{ marginTop: 8, fontSize: 13, color: 'var(--text-secondary)' }}>
            Extensions let your agent call external APIs, communicate with other agents, escalate to humans, or run local tools.
          </p>
        </div>
      ) : (
        <>
          {TYPES.map(typeInfo => {
            const items = grouped[typeInfo.value];
            if (!items || items.length === 0) return null;
            return (
              <div key={typeInfo.value} style={{ marginBottom: 20 }}>
                <h3 style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  {typeInfo.label}s ({items.length})
                </h3>
                <div className="card" style={{ padding: 0 }}>
                  {items.map((ext) => (
                    <div key={ext.name || ext._index} className="ext-card">
                      <div style={{ flex: 1 }}>
                        <div className="ext-name">
                          <TypeIcon type={ext.type} />
                          {ext.name}
                          {ext.auth?.apiKey && <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--green)', opacity: 0.8 }}>🔑 auth</span>}
                        </div>
                        <div className="ext-detail">{ext.description || '—'}</div>

                        {ext.endpoint && (
                          <div className="ext-detail" style={{ fontFamily: 'monospace', fontSize: 12, marginTop: 6, opacity: 0.7 }}>{ext.endpoint}</div>
                        )}
                        {ext.address && (
                          <div className="ext-detail" style={{ marginTop: 4 }}>📍 {ext.address}</div>
                        )}
                        {ext.command && (
                          <div className="ext-detail" style={{ fontFamily: 'monospace', fontSize: 12, marginTop: 4 }}>$ {ext.command}</div>
                        )}

                        <div style={{ display: 'flex', gap: 12, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                          {ext.cost_model && ext.cost_model !== 'free' && ext.cost && (
                            <span className="ext-detail" style={{ margin: 0 }}>
                              💰 <span style={{ color: 'var(--yellow)', fontWeight: 500 }}>{ext.cost}</span>
                            </span>
                          )}
                          {ext.cost_model === 'free' && (
                            <span className="ext-detail" style={{ margin: 0, color: 'var(--green)' }}>Free</span>
                          )}
                          {ext.notes && (
                            <span className="ext-detail" style={{ margin: 0, fontStyle: 'italic' }}>📝 {ext.notes}</span>
                          )}
                        </div>

                        {ext.capabilities && ext.capabilities.length > 0 && (
                          <div className="tag-list" style={{ marginTop: 8 }}>
                            {ext.capabilities.map((c, j) => <span key={j} className="tag">{c}</span>)}
                          </div>
                        )}

                        {testResult && testResult.index === ext._index && (
                          <div style={{ marginTop: 8, fontSize: 12, color: testResult.ok ? 'var(--green)' : 'var(--red)' }}>
                            {testResult.ok ? '✓' : '✗'} {testResult.msg}
                          </div>
                        )}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexShrink: 0 }}>
                        <span className={`ext-type ${ext.type || 'tool'}`}>{ext.type || 'tool'}</span>
                        {ext.type === 'api' && ext.endpoint && (
                          <button
                            className="btn-inline"
                            onClick={() => handleTest(ext._index)}
                            disabled={testing === ext._index}
                          >
                            {testing === ext._index ? '...' : 'Test'}
                          </button>
                        )}
                        <button className="btn-inline" onClick={() => handleEdit(ext._index)}>Edit</button>
                        <button className="btn-inline danger" onClick={() => handleRemove(ext._index)}>Remove</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
