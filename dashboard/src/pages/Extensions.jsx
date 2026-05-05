import React, { useState } from 'react';
import { useFetch, useApi } from '../hooks/useApi.js';

const TYPES = [
  { value: 'api', label: 'API', desc: 'External REST API' },
  { value: 'agent', label: 'Agent', desc: 'Another AaaS agent' },
  { value: 'human', label: 'Human', desc: 'Human escalation contact' },
];

const AUTH_TYPES = [
  { value: 'none', label: 'None' },
  { value: 'bearer', label: 'Bearer Token' },
  { value: 'header', label: 'Custom Header' },
  { value: 'query', label: 'Query Parameter' },
  { value: 'basic', label: 'Basic Auth' },
];

const EMPTY_EXT = {
  name: '', type: 'api', description: '', endpoint: '', address: '',
  capabilities: '', cost_model: 'free', cost: '', notes: '',
  authType: 'none', authKey: '', authHeader: '',
  headers: '',
  operations: [],
};

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const OUTPUT_TYPES = [
  { value: 'json', label: 'JSON response' },
  { value: 'text', label: 'Plain text' },
  { value: 'binary', label: 'File download (audio, image, video, etc.)' },
];

function emptyOp() {
  return {
    name: '', description: '', method: 'GET', path: '',
    body: '', returns: '', output_type: 'json', timeout_s: '',
    asyncEnabled: false,
    poll_path: '', ready_field: 'status',
    ready_values: 'completed, succeeded, success, done',
    failure_values: 'failed, error, cancelled',
    result_field: '', interval_s: '', max_wait_s: '',
    expanded: true,
    testing: false, testResult: null,
  };
}

const OP_TEMPLATES = {
  get: {
    label: 'Simple GET',
    desc: 'Read something from the API.',
    fill: () => ({ ...emptyOp(), name: 'fetch_thing', description: 'Read something from the API.', method: 'GET', path: '/path/to/resource' }),
  },
  post: {
    label: 'Simple POST',
    desc: 'Send data to the API.',
    fill: () => ({ ...emptyOp(), name: 'create_thing', description: 'Create or send something to the API.', method: 'POST', path: '/path/to/resource', body: '{\n  "key": "value"\n}' }),
  },
  async: {
    label: 'Async job',
    desc: 'Start a job, then wait for it to finish (e.g. music or image generation).',
    fill: () => ({
      ...emptyOp(),
      name: 'generate_thing', description: 'Start a job and wait for it to finish.',
      method: 'POST', path: '/jobs',
      body: '{\n  "prompt": "your input here"\n}',
      asyncEnabled: true,
      poll_path: '/jobs/{id}', ready_field: 'status',
      ready_values: 'completed, succeeded, success, done',
      failure_values: 'failed, error, cancelled',
      max_wait_s: '180',
    }),
  },
  download: {
    label: 'Download file',
    desc: 'Fetch a binary file (audio, image, video, PDF) and save it for the agent.',
    fill: () => ({ ...emptyOp(), name: 'download_file', description: 'Download a binary file.', method: 'GET', path: '/files/{id}', output_type: 'binary' }),
  },
};

function opFromConfig(op) {
  const a = op.async || {};
  return {
    name: op.name || '',
    description: op.description || '',
    method: (op.method || 'GET').toUpperCase(),
    path: op.path || '',
    body: op.body ? JSON.stringify(op.body, null, 2) : '',
    returns: op.returns || '',
    output_type: op.output_type || 'json',
    timeout_s: op.timeout_s != null ? String(op.timeout_s) : '',
    asyncEnabled: !!op.async,
    poll_path: a.poll_path || '',
    ready_field: a.ready_field || 'status',
    ready_values: Array.isArray(a.ready_values) ? a.ready_values.join(', ') : 'completed, succeeded, success, done',
    failure_values: Array.isArray(a.failure_values) ? a.failure_values.join(', ') : 'failed, error, cancelled',
    result_field: a.result_field || '',
    interval_s: a.interval_s != null ? String(a.interval_s) : '',
    max_wait_s: a.max_wait_s != null ? String(a.max_wait_s) : '',
    expanded: false,
    testing: false, testResult: null,
  };
}

function configFromOp(formOp) {
  if (!formOp.name?.trim() || !formOp.path?.trim()) return null;
  const op = {
    name: formOp.name.trim(),
    method: (formOp.method || 'GET').toUpperCase(),
    path: formOp.path.trim(),
  };
  if (formOp.description?.trim()) op.description = formOp.description.trim();
  if (formOp.body?.trim()) {
    try {
      op.body = JSON.parse(formOp.body);
    } catch {
      // Allow saving with a malformed body — surface error at save time, not silently
      throw new Error(`Operation "${op.name}": body is not valid JSON.`);
    }
  }
  if (formOp.returns?.trim()) op.returns = formOp.returns.trim();
  if (formOp.output_type && formOp.output_type !== 'json') op.output_type = formOp.output_type;
  if (formOp.timeout_s) op.timeout_s = Number(formOp.timeout_s) || undefined;
  if (formOp.asyncEnabled) {
    const cfg = {};
    if (formOp.poll_path?.trim()) cfg.poll_path = formOp.poll_path.trim();
    if (formOp.ready_field?.trim() && formOp.ready_field.trim() !== 'status') cfg.ready_field = formOp.ready_field.trim();
    const rv = formOp.ready_values?.split(',').map(s => s.trim()).filter(Boolean);
    if (rv?.length) cfg.ready_values = rv;
    const fv = formOp.failure_values?.split(',').map(s => s.trim()).filter(Boolean);
    if (fv?.length) cfg.failure_values = fv;
    if (formOp.result_field?.trim()) cfg.result_field = formOp.result_field.trim();
    if (formOp.interval_s) cfg.interval_s = Number(formOp.interval_s) || undefined;
    if (formOp.max_wait_s) cfg.max_wait_s = Number(formOp.max_wait_s) || undefined;
    op.async = cfg;
  }
  return op;
}

function formFromExt(ext) {
  return {
    name: ext.name || '',
    type: ext.type || 'api',
    description: ext.description || '',
    endpoint: ext.endpoint || '',
    address: ext.address || '',
    capabilities: (ext.capabilities || []).join(', '),
    cost_model: ext.cost_model || ext.cost_per_call ? 'per_request' : 'free',
    cost: ext.cost || ext.cost_per_call || '',
    notes: ext.notes || '',
    authType: ext.auth?.type || (ext.auth?.apiKey ? 'bearer' : 'none'),
    authKey: ext.auth?.apiKey || '',
    authHeader: ext.auth?.header || '',
    headers: ext.headers ? Object.entries(ext.headers).map(([k, v]) => `${k}: ${v}`).join('\n') : '',
    operations: Array.isArray(ext.operations) ? ext.operations.map(opFromConfig) : [],
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

  // Capabilities (API only)
  if (form.type === 'api') {
    const caps = form.capabilities.split(',').map(s => s.trim()).filter(Boolean);
    if (caps.length > 0) ext.capabilities = caps;
  }

  // Cost (API only)
  if (form.type === 'api' && form.cost_model && form.cost_model !== 'free') {
    ext.cost_model = form.cost_model;
    if (form.cost.trim()) ext.cost = form.cost.trim();
  } else if (form.type === 'api') {
    ext.cost_model = 'free';
  }

  // Notes
  if (form.notes.trim()) ext.notes = form.notes.trim();

  // Auth (API and Agent)
  if (form.type !== 'human' && form.authType !== 'none' && form.authKey.trim()) {
    ext.auth = {
      type: form.authType,
      apiKey: form.authKey.trim(),
    };
    if ((form.authType === 'header' || form.authType === 'query') && form.authHeader.trim()) {
      ext.auth.header = form.authHeader.trim();
    }
  }

  // Custom headers (API only)
  if (form.type === 'api' && form.headers.trim()) {
    const headers = {};
    for (const line of form.headers.trim().split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) {
        headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }
    if (Object.keys(headers).length > 0) ext.headers = headers;
  }

  // Operations (API only). configFromOp throws on invalid JSON body — propagate.
  if (form.type === 'api' && Array.isArray(form.operations) && form.operations.length) {
    const ops = form.operations.map(configFromOp).filter(Boolean);
    if (ops.length) ext.operations = ops;
  }

  return ext;
}

// Type-specific icons (SVG)
function TypeIcon({ type }) {
  const colors = { api: '#6366f1', agent: '#8b5cf6', human: '#14b8a6' };
  const color = colors[type] || '#6b7280';
  const common = {
    width: 22,
    height: 22,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: color,
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    style: { marginRight: 8, flexShrink: 0 },
  };
  if (type === 'api') {
    // Lightning bolt / plug
    return (
      <svg {...common}>
        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
      </svg>
    );
  }
  if (type === 'agent') {
    // Robot
    return (
      <svg {...common}>
        <rect x="4" y="7" width="16" height="12" rx="2" />
        <path d="M12 7V3" />
        <circle cx="12" cy="3" r="1" />
        <circle cx="9" cy="12" r="1" fill={color} />
        <circle cx="15" cy="12" r="1" fill={color} />
        <path d="M9 16h6" />
      </svg>
    );
  }
  if (type === 'human') {
    // Person
    return (
      <svg {...common}>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
    </svg>
  );
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

  function updateOp(index, key, val) {
    setForm(f => ({
      ...f,
      operations: f.operations.map((op, i) => i === index ? { ...op, [key]: val } : op),
    }));
  }

  function addOp(template) {
    const op = template ? OP_TEMPLATES[template].fill() : emptyOp();
    setForm(f => ({ ...f, operations: [...(f.operations || []), op] }));
  }

  function removeOp(index) {
    setForm(f => ({ ...f, operations: f.operations.filter((_, i) => i !== index) }));
  }

  async function testOp(index) {
    let opConfig;
    try {
      opConfig = configFromOp(form.operations[index]);
    } catch (err) {
      updateOp(index, 'testResult', { ok: false, msg: err.message });
      return;
    }
    if (!opConfig) {
      updateOp(index, 'testResult', { ok: false, msg: 'Operation needs a name and a path before it can be tested.' });
      return;
    }
    // Build a draft extension from the current form state — so testing works
    // even before the user clicks Save.
    const draftExt = extFromFormSafe(form);
    if (!draftExt) {
      updateOp(index, 'testResult', { ok: false, msg: 'Fix the form errors above before testing.' });
      return;
    }
    if (!Array.isArray(draftExt.operations) || !draftExt.operations.length) {
      draftExt.operations = [opConfig];
    }
    updateOp(index, 'testing', true);
    updateOp(index, 'testResult', null);
    try {
      const res = await fetch('/api/extensions/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          extension: draftExt,
          operation: opConfig.name,
          data: opConfig.body || {},
        }),
      });
      const result = await res.json();
      const ok = result.ok === true || (result.status >= 200 && result.status < 300);
      let msg;
      if (result.error) msg = result.error;
      else if (result.file_path) msg = `Saved file: ${result.file_path} (${result.size || '?'} bytes, ${result.mime || 'unknown type'})`;
      else if (typeof result.data === 'string') msg = `HTTP ${result.status} — ${result.data.slice(0, 120)}`;
      else msg = `HTTP ${result.status} — ${JSON.stringify(result.data || {}).slice(0, 200)}`;
      updateOp(index, 'testResult', { ok, msg });
    } catch (err) {
      updateOp(index, 'testResult', { ok: false, msg: err.message });
    }
    updateOp(index, 'testing', false);
  }

  // Wraps extFromForm so a malformed body in an operation surfaces as a
  // form-level alert instead of crashing the save.
  function extFromFormSafe(formState) {
    try { return extFromForm(formState); }
    catch { return null; }
  }

  async function handleSave() {
    if (!form.name.trim()) return alert('Name is required');
    if (form.type === 'api' && !form.endpoint.trim()) return alert('Endpoint URL is required for API extensions');
    if (form.type === 'agent' && !form.address.trim()) return alert('Agent chat URL is required');
    if (form.type === 'human' && !form.address.trim()) return alert('Contact info is required');

    let ext;
    try {
      ext = extFromForm(form);
    } catch (err) {
      return alert(err.message);
    }

    setSaving(true);
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
    if (ext.type === 'agent') {
      setTesting(index);
      setTestResult(null);
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const headers = { 'Content-Type': 'application/json' };
        if (ext.auth?.apiKey) headers['Authorization'] = `Bearer ${ext.auth.apiKey}`;
        const res = await fetch(ext.address, {
          method: 'POST',
          headers,
          body: JSON.stringify({ message: 'ping' }),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        setTestResult({ index, ok: res.ok, msg: `${res.status} ${res.statusText}` });
      } catch (err) {
        setTestResult({ index, ok: false, msg: err.name === 'AbortError' ? 'Timeout (15s)' : err.message });
      }
      setTesting(null);
      return;
    }
    if (ext.type !== 'api' || !ext.endpoint) {
      setTestResult({ index, ok: false, msg: 'Cannot test this extension type' });
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

  const grouped = { api: [], agent: [], human: [] };
  (data || []).forEach((ext, i) => {
    const g = grouped[ext.type] || grouped.api;
    g.push({ ...ext, _index: i });
  });

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Extensions</h1>
        <p className="page-desc">External APIs, agents, and contacts your agent can use</p>
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
              <input className="input" value={form.name} onChange={e => setField('name', e.target.value)}
                placeholder={form.type === 'api' ? 'e.g. Stripe, Weather API' : form.type === 'agent' ? 'e.g. Delivery Agent, Support Bot' : 'e.g. John (Manager), Support Team'} />
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
              <input className="input" value={form.description} onChange={e => setField('description', e.target.value)}
                placeholder={form.type === 'api' ? 'What does this API do? The agent reads this to decide when to use it.'
                  : form.type === 'agent' ? 'What does this agent do? When should your agent contact it?'
                  : 'Who is this person and when should the agent escalate to them?'} />
            </div>
          </div>

          {/* ─── API fields ─── */}
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

              {/* Capabilities */}
              <div className="form-grid" style={{ marginTop: 8 }}>
                <div className="form-field" style={{ gridColumn: '1 / -1' }}>
                  <label className="form-label">Capabilities</label>
                  <input className="input" value={form.capabilities} onChange={e => setField('capabilities', e.target.value)} placeholder="e.g. create_checkout, verify_payment, refund" />
                  <span className="form-hint">Comma-separated list. Helps the agent know what this extension can do.</span>
                </div>
              </div>

              {/* Cost */}
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
                    <input className="input" value={form.cost} onChange={e => setField('cost', e.target.value)} placeholder="e.g. $0.01 per call" />
                  </div>
                )}
              </div>

              {/* ─── Operations ─── */}
              <div style={{ marginTop: 16, padding: '14px 16px', background: 'var(--bg-secondary)', borderRadius: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <label className="form-label" style={{ marginBottom: 4, display: 'block' }}>
                      Operations
                      <span style={{ marginLeft: 8, fontWeight: 'normal', fontSize: 11, color: 'var(--text-secondary)' }}>
                        ({form.operations?.length || 0})
                      </span>
                    </label>
                    <span className="form-hint" style={{ marginTop: 0 }}>
                      The specific things this API can do. Adding them lets the agent call them by name without guessing URLs or request formats.
                    </span>
                  </div>
                </div>

                {/* Add buttons */}
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
                  <button type="button" className="btn-inline" onClick={() => addOp()}>+ Blank</button>
                  {Object.entries(OP_TEMPLATES).map(([key, tpl]) => (
                    <button
                      type="button"
                      key={key}
                      className="btn-inline"
                      title={tpl.desc}
                      onClick={() => addOp(key)}
                    >
                      + {tpl.label}
                    </button>
                  ))}
                </div>

                {/* Existing operations */}
                {(form.operations || []).map((op, i) => (
                  <OperationCard
                    key={i}
                    index={i}
                    op={op}
                    onChange={(key, val) => updateOp(i, key, val)}
                    onRemove={() => removeOp(i)}
                    onTest={() => testOp(i)}
                    onToggle={() => updateOp(i, 'expanded', !op.expanded)}
                  />
                ))}

                {(!form.operations || form.operations.length === 0) && (
                  <div style={{ marginTop: 10, padding: '14px 12px', background: 'var(--bg-card)', borderRadius: 6, fontSize: 13, color: 'var(--text-secondary)', textAlign: 'center' }}>
                    No operations yet. Click a template above to add one.
                  </div>
                )}

                <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-secondary)' }}>
                  💡 Use <code style={{ background: 'var(--bg-card)', padding: '1px 5px', borderRadius: 3 }}>{'{{ENV_VAR}}'}</code> in any field to pull values from environment variables (great for keeping secrets out of the registry).
                </div>
              </div>
            </>
          )}

          {/* ─── Agent fields ─── */}
          {form.type === 'agent' && (
            <>
              <div className="form-grid" style={{ marginTop: 8 }}>
                <div className="form-field" style={{ gridColumn: '1 / -1' }}>
                  <label className="form-label">Agent Chat URL *</label>
                  <input className="input" value={form.address} onChange={e => setField('address', e.target.value)} placeholder="http://localhost:3001/api/chat or https://agent.example.com/api/chat" />
                  <span className="form-hint">The other agent's HTTP chat endpoint. Your agent sends a message and gets a reply.</span>
                </div>
              </div>

              {/* Optional auth for agent */}
              <div className="form-grid" style={{ marginTop: 8 }}>
                <div className="form-field">
                  <label className="form-label">Authentication</label>
                  <select className="input" value={form.authType} onChange={e => setField('authType', e.target.value)}>
                    <option value="none">None</option>
                    <option value="bearer">Bearer Token</option>
                  </select>
                </div>
                {form.authType !== 'none' && (
                  <div className="form-field">
                    <label className="form-label">API Key</label>
                    <input className="input" type="password" value={form.authKey} onChange={e => setField('authKey', e.target.value)} placeholder="API key or token" />
                  </div>
                )}
              </div>
            </>
          )}

          {/* ─── Human fields ─── */}
          {form.type === 'human' && (
            <>
              <div className="form-grid" style={{ marginTop: 8 }}>
                <div className="form-field" style={{ gridColumn: '1 / -1' }}>
                  <label className="form-label">Contact Info *</label>
                  <input className="input" value={form.address} onChange={e => setField('address', e.target.value)} placeholder="email, phone, or username" />
                  <span className="form-hint">How the agent tells users to reach this person when escalating.</span>
                </div>
              </div>
            </>
          )}

          {/* Notes — shown for all types */}
          <div className="form-grid" style={{ marginTop: 8 }}>
            <div className="form-field" style={{ gridColumn: '1 / -1' }}>
              <label className="form-label">Notes</label>
              <textarea
                className="input"
                value={form.notes}
                onChange={e => setField('notes', e.target.value)}
                placeholder="Additional info the agent should know when using this extension, such as how to call the API, rate limits, or special instructions."
                rows={4}
                style={{ resize: 'vertical' }}
              />
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
            Extensions let your agent call external APIs, communicate with other agents, or escalate to humans.
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
                          <div className="ext-detail" style={{ marginTop: 4, fontFamily: ext.type === 'agent' ? 'monospace' : 'inherit', fontSize: ext.type === 'agent' ? 12 : 'inherit', opacity: ext.type === 'agent' ? 0.7 : 1 }}>
                            {ext.type === 'human' ? '📧 ' : ''}{ext.address}
                          </div>
                        )}

                        <div style={{ display: 'flex', gap: 12, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                          {ext.cost_model && ext.cost_model !== 'free' && ext.cost && (
                            <span className="ext-detail" style={{ margin: 0 }}>
                              💰 <span style={{ color: 'var(--yellow)', fontWeight: 500 }}>{ext.cost}</span>
                            </span>
                          )}
                          {ext.type === 'api' && ext.cost_model === 'free' && (
                            <span className="ext-detail" style={{ margin: 0, color: 'var(--green)' }}>Free</span>
                          )}
                          {ext.notes && (
                            <span className="ext-detail" style={{ margin: 0, fontStyle: 'italic' }}>📝 {ext.notes.length > 80 ? ext.notes.slice(0, 80) + '...' : ext.notes}</span>
                          )}
                        </div>

                        {ext.capabilities && ext.capabilities.length > 0 && (
                          <div className="tag-list" style={{ marginTop: 8 }}>
                            {ext.capabilities.map((c, j) => <span key={j} className="tag">{c}</span>)}
                          </div>
                        )}

                        {Array.isArray(ext.operations) && ext.operations.length > 0 && (
                          <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            {ext.operations.map((op, j) => (
                              <span key={j} title={op.description || ''} style={{
                                fontSize: 11, padding: '3px 8px', borderRadius: 4,
                                background: 'var(--bg-secondary)', color: 'var(--text)',
                                border: '1px solid var(--border)',
                                fontFamily: 'monospace', display: 'inline-flex', alignItems: 'center', gap: 5,
                              }}>
                                <span style={{ color: 'var(--accent)', fontWeight: 600, fontSize: 9, letterSpacing: 0.4 }}>
                                  {(op.method || 'GET').toUpperCase()}
                                </span>
                                {op.name}
                                {op.async && <span style={{ color: '#a855f7', fontSize: 9 }}>async</span>}
                                {op.output_type === 'binary' && <span style={{ color: '#eab308', fontSize: 9 }}>file</span>}
                              </span>
                            ))}
                          </div>
                        )}

                        {testResult && testResult.index === ext._index && (
                          <div style={{ marginTop: 8, fontSize: 12, color: testResult.ok ? 'var(--green)' : 'var(--red)' }}>
                            {testResult.ok ? '✓' : '✗'} {testResult.msg}
                          </div>
                        )}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexShrink: 0 }}>
                        <span className={`ext-type ${ext.type || 'api'}`}>{ext.type || 'api'}</span>
                        {(ext.type === 'api' && ext.endpoint || ext.type === 'agent' && ext.address) && (
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

function OperationCard({ index, op, onChange, onRemove, onTest, onToggle }) {
  const cardStyle = {
    marginTop: 10,
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    overflow: 'hidden',
  };
  const headerStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 14px',
    cursor: 'pointer',
    background: op.expanded ? 'var(--bg-secondary)' : 'transparent',
  };
  const labelStyle = { fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' };
  const tagStyle = {
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: 0.5,
    padding: '2px 6px',
    borderRadius: 3,
    textTransform: 'uppercase',
  };

  const methodColors = {
    GET: { bg: 'rgba(34,197,94,0.12)', fg: '#22c55e' },
    POST: { bg: 'rgba(59,130,246,0.12)', fg: '#3b82f6' },
    PUT: { bg: 'rgba(234,179,8,0.12)', fg: '#eab308' },
    PATCH: { bg: 'rgba(168,85,247,0.12)', fg: '#a855f7' },
    DELETE: { bg: 'rgba(239,68,68,0.12)', fg: '#ef4444' },
  };
  const m = methodColors[op.method] || methodColors.GET;

  return (
    <div style={cardStyle}>
      <div style={headerStyle} onClick={onToggle}>
        <span style={{ fontSize: 11, color: 'var(--text-secondary)', minWidth: 14 }}>{op.expanded ? '▾' : '▸'}</span>
        <span style={{ ...tagStyle, background: m.bg, color: m.fg }}>{op.method || 'GET'}</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
          {op.name || <span style={{ color: 'var(--text-secondary)', fontStyle: 'italic', fontWeight: 'normal' }}>(unnamed operation)</span>}
        </span>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'monospace', marginLeft: 4 }}>{op.path || ''}</span>
        {op.asyncEnabled && <span style={{ ...tagStyle, background: 'rgba(168,85,247,0.12)', color: '#a855f7' }}>async</span>}
        {op.output_type === 'binary' && <span style={{ ...tagStyle, background: 'rgba(234,179,8,0.12)', color: '#eab308' }}>file</span>}
        <div style={{ flex: 1 }} />
        <button type="button" className="btn-inline danger" onClick={(e) => { e.stopPropagation(); onRemove(); }}>Remove</button>
      </div>

      {op.expanded && (
        <div style={{ padding: '12px 14px 14px', borderTop: '1px solid var(--border)' }}>
          {/* Name + Description */}
          <div className="form-grid">
            <div className="form-field">
              <label className="form-label" style={labelStyle}>Operation name *</label>
              <input className="input" value={op.name} onChange={e => onChange('name', e.target.value)} placeholder="e.g. generate_music" />
              <span className="form-hint">Short identifier the agent uses to call this. Snake_case or camelCase.</span>
            </div>
            <div className="form-field">
              <label className="form-label" style={labelStyle}>What does this do?</label>
              <input className="input" value={op.description} onChange={e => onChange('description', e.target.value)} placeholder="One-line summary the agent reads when picking the right operation." />
            </div>
          </div>

          {/* Method + Path */}
          <div className="form-grid" style={{ marginTop: 10 }}>
            <div className="form-field" style={{ maxWidth: 140 }}>
              <label className="form-label" style={labelStyle}>HTTP method</label>
              <select className="input" value={op.method} onChange={e => onChange('method', e.target.value)}>
                {METHODS.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div className="form-field">
              <label className="form-label" style={labelStyle}>Path *</label>
              <input className="input" value={op.path} onChange={e => onChange('path', e.target.value)} placeholder="/v1/something/{id}" style={{ fontFamily: 'monospace' }} />
              <span className="form-hint">
                Relative to the base URL. Use <code style={{ background: 'var(--bg-secondary)', padding: '0 4px', borderRadius: 3 }}>{'{name}'}</code> for placeholders filled from the call body.
              </span>
            </div>
          </div>

          {/* Output type */}
          <div className="form-grid" style={{ marginTop: 10 }}>
            <div className="form-field" style={{ gridColumn: '1 / -1' }}>
              <label className="form-label" style={labelStyle}>Response type</label>
              <select className="input" value={op.output_type} onChange={e => onChange('output_type', e.target.value)}>
                {OUTPUT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              {op.output_type === 'binary' && (
                <span className="form-hint">Files are saved automatically into <code style={{ background: 'var(--bg-secondary)', padding: '0 4px', borderRadius: 3 }}>data/extensions/{'<ext>'}/</code> and the agent gets the file path back.</span>
              )}
            </div>
          </div>

          {/* Body example (only for POST/PUT/PATCH) */}
          {(op.method === 'POST' || op.method === 'PUT' || op.method === 'PATCH') && (
            <div className="form-grid" style={{ marginTop: 10 }}>
              <div className="form-field" style={{ gridColumn: '1 / -1' }}>
                <label className="form-label" style={labelStyle}>Example request body (JSON)</label>
                <textarea
                  className="input"
                  value={op.body}
                  onChange={e => onChange('body', e.target.value)}
                  placeholder={'{\n  "key": "value"\n}'}
                  rows={5}
                  style={{ fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }}
                />
                <span className="form-hint">Shown to the agent as a template for what to send. Used as the default body when testing.</span>
              </div>
            </div>
          )}

          {/* Returns */}
          <div className="form-grid" style={{ marginTop: 10 }}>
            <div className="form-field" style={{ gridColumn: '1 / -1' }}>
              <label className="form-label" style={labelStyle}>What it returns (optional)</label>
              <input className="input" value={op.returns} onChange={e => onChange('returns', e.target.value)} placeholder='e.g. { id, status, audio_file: { url } }' />
              <span className="form-hint">Free-form description of the response shape. Helps the agent know what to do with the result.</span>
            </div>
          </div>

          {/* Async toggle */}
          <div style={{ marginTop: 14, padding: '10px 12px', background: 'var(--bg-secondary)', borderRadius: 6 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={op.asyncEnabled} onChange={e => onChange('asyncEnabled', e.target.checked)} />
              <span style={{ fontSize: 13, fontWeight: 500 }}>This operation is asynchronous</span>
              <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>(starts a job, then we wait for it to finish)</span>
            </label>

            {op.asyncEnabled && (
              <div style={{ marginTop: 10 }}>
                <div className="form-grid">
                  <div className="form-field">
                    <label className="form-label" style={labelStyle}>Polling URL path *</label>
                    <input className="input" value={op.poll_path} onChange={e => onChange('poll_path', e.target.value)} placeholder="/jobs/{id}" style={{ fontFamily: 'monospace' }} />
                    <span className="form-hint">Where to check for job status. Use <code style={{ background: 'var(--bg-card)', padding: '0 4px', borderRadius: 3 }}>{'{id}'}</code> placeholders filled from the initial response.</span>
                  </div>
                  <div className="form-field">
                    <label className="form-label" style={labelStyle}>Status field</label>
                    <input className="input" value={op.ready_field} onChange={e => onChange('ready_field', e.target.value)} placeholder="status" />
                    <span className="form-hint">Field in the polling response that holds the status (default: status).</span>
                  </div>
                </div>
                <div className="form-grid" style={{ marginTop: 10 }}>
                  <div className="form-field">
                    <label className="form-label" style={labelStyle}>"Done" values</label>
                    <input className="input" value={op.ready_values} onChange={e => onChange('ready_values', e.target.value)} placeholder="completed, succeeded, success" />
                    <span className="form-hint">Comma-separated. Polling stops when status equals one of these.</span>
                  </div>
                  <div className="form-field">
                    <label className="form-label" style={labelStyle}>"Failed" values</label>
                    <input className="input" value={op.failure_values} onChange={e => onChange('failure_values', e.target.value)} placeholder="failed, error, cancelled" />
                  </div>
                </div>
                <div className="form-grid" style={{ marginTop: 10 }}>
                  <div className="form-field">
                    <label className="form-label" style={labelStyle}>Useful field in the result (optional)</label>
                    <input className="input" value={op.result_field} onChange={e => onChange('result_field', e.target.value)} placeholder="audio_file.url" />
                    <span className="form-hint">If the response has the result nested somewhere, name it here. Dotted path supported.</span>
                  </div>
                  <div className="form-field" style={{ display: 'flex', gap: 8 }}>
                    <div style={{ flex: 1 }}>
                      <label className="form-label" style={labelStyle}>Check every (seconds)</label>
                      <input className="input" value={op.interval_s} onChange={e => onChange('interval_s', e.target.value)} placeholder="3" />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label className="form-label" style={labelStyle}>Give up after (seconds)</label>
                      <input className="input" value={op.max_wait_s} onChange={e => onChange('max_wait_s', e.target.value)} placeholder="120" />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Test button + result */}
          <div style={{ marginTop: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" className="btn" onClick={onTest} disabled={op.testing}>
              {op.testing ? 'Testing…' : 'Test this operation'}
            </button>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
              Calls the API live using the form above. Async operations may take up to 5 minutes.
            </span>
          </div>
          {op.testResult && (
            <div style={{
              marginTop: 10, padding: '10px 12px', borderRadius: 6,
              background: op.testResult.ok ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
              border: `1px solid ${op.testResult.ok ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
              fontSize: 12, color: op.testResult.ok ? 'var(--green)' : 'var(--red)',
              wordBreak: 'break-all',
            }}>
              {op.testResult.ok ? '✓ ' : '✗ '}{op.testResult.msg}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
