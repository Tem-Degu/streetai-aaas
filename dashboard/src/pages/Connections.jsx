import React, { useState, useEffect } from 'react';
import { useApi } from '../hooks/useApi.js';

const PLATFORM_INFO = {
  truuze: { label: 'Truuze', color: '#4a9eff', desc: 'Social platform for AI agents' },
  http: { label: 'HTTP API', color: '#10b981', desc: 'REST API endpoint' },
  openclaw: { label: 'OpenClaw', color: '#f59e0b', desc: 'Agent gateway' },
};

export default function Connections() {
  const api = useApi();
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(null); // 'truuze' | 'http' | 'openclaw' | null
  const [saving, setSaving] = useState(false);
  const [formMsg, setFormMsg] = useState('');

  // Truuze form
  const [truuzeMode, setTruuzeMode] = useState('token'); // 'token' | 'key'
  const [truuzeToken, setTruuzeToken] = useState('');
  const [truuzeKey, setTruuzeKey] = useState('');
  const [truuzeUrl, setTruuzeUrl] = useState('https://origin.truuze.com/api/v1');
  const [truuzeUsername, setTruuzeUsername] = useState('');
  const [truuzeFirstName, setTruuzeFirstName] = useState('');
  const [truuzeLastName, setTruuzeLastName] = useState('');

  // HTTP form
  const [httpPort, setHttpPort] = useState('3300');

  const loadConnections = async () => {
    try {
      const data = await api.get('/api/connections');
      setConnections(data);
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => { loadConnections(); }, []);

  const connect = async (platform) => {
    setSaving(true);
    setFormMsg('');
    try {
      let body = {};
      if (platform === 'truuze') {
        body.baseUrl = truuzeUrl;
        if (truuzeMode === 'token') {
          body.token = truuzeToken;
          if (truuzeUsername) body.username = truuzeUsername;
          if (truuzeFirstName) body.first_name = truuzeFirstName;
          if (truuzeLastName) body.last_name = truuzeLastName;
        } else {
          body.agentKey = truuzeKey;
        }
      } else if (platform === 'http') {
        body.port = parseInt(httpPort) || 3300;
      }

      await api.post(`/api/connections/${platform}`, body);
      setShowForm(null);
      setTruuzeToken('');
      setTruuzeKey('');
      setTruuzeUsername('');
      setTruuzeFirstName('');
      setTruuzeLastName('');
      loadConnections();
    } catch (err) {
      setFormMsg('Error: ' + err.message);
    }
    setSaving(false);
  };

  const disconnect = async (platform) => {
    if (!confirm(`Disconnect from ${PLATFORM_INFO[platform]?.label || platform}?`)) return;
    try {
      await api.del(`/api/connections/${platform}`);
      loadConnections();
    } catch (err) {
      alert('Failed: ' + err.message);
    }
  };

  if (loading) return <div className="page-loading">Loading...</div>;

  return (
    <div>
      <div className="page-header">
        <h1>Connections</h1>
        <p className="page-subtitle">Connect your agent to platforms</p>
      </div>

      {/* Active Connections */}
      {connections.length > 0 && (
        <>
          <h3>Active Connections</h3>
          <div className="connections-grid">
            {connections.map(({ platform, config }) => {
              const info = PLATFORM_INFO[platform] || { label: platform, color: '#888', desc: '' };

              return (
                <div key={platform} className="card connection-card connected">
                  <div className="card-header">
                    <span className="connection-dot" style={{ background: info.color }} />
                    {info.label}
                    <span className="badge badge-green">connected</span>
                  </div>
                  <div className="card-body">
                    <p className="form-hint">{info.desc}</p>
                    <div className="status-list">
                      {config.baseUrl && (
                        <div className="status-item">
                          <span className="status-label">URL</span>
                          <span className="mono">{config.baseUrl}</span>
                        </div>
                      )}
                      {config.port && (
                        <div className="status-item">
                          <span className="status-label">Port</span>
                          <span>{config.port}</span>
                        </div>
                      )}
                      {config.agentId && (
                        <div className="status-item">
                          <span className="status-label">Agent ID</span>
                          <span>{config.agentId}</span>
                        </div>
                      )}
                      {config.ownerUsername && (
                        <div className="status-item">
                          <span className="status-label">Owner</span>
                          <span>@{config.ownerUsername}</span>
                        </div>
                      )}
                      {config.heartbeatInterval && (
                        <div className="status-item">
                          <span className="status-label">Poll interval</span>
                          <span>{config.heartbeatInterval}s</span>
                        </div>
                      )}
                      {config.connectedAt && (
                        <div className="status-item">
                          <span className="status-label">Connected</span>
                          <span>{new Date(config.connectedAt).toLocaleString()}</span>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="card-footer">
                    <button className="btn btn-danger" onClick={() => disconnect(platform)}>Disconnect</button>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="section-divider" />
        </>
      )}

      {/* Available Platforms */}
      <h3>Available Platforms</h3>
      <div className="connections-grid">
        {Object.entries(PLATFORM_INFO).map(([key, info]) => {
          const isConnected = connections.some(c => c.platform === key);
          if (isConnected) return null;

          return (
            <div key={key} className="card connection-card available">
              <div className="card-header">
                <span className="connection-dot" style={{ background: '#555' }} />
                {info.label}
              </div>
              <div className="card-body">
                <p className="form-hint">{info.desc}</p>
              </div>
              <div className="card-footer">
                <button className="btn btn-primary" onClick={() => { setShowForm(key); setFormMsg(''); }}>Connect</button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Connect Forms */}
      {showForm === 'truuze' && (
        <div className="card" style={{ marginTop: '1.5rem' }}>
          <div className="card-header">Connect to Truuze</div>
          <div className="card-body">
            <div className="form-group">
              <label>Connection method</label>
              <select value={truuzeMode} onChange={e => setTruuzeMode(e.target.value)} className="form-select">
                <option value="token">Provisioning token (new agent)</option>
                <option value="key">Existing agent key</option>
              </select>
            </div>

            <div className="form-group">
              <label>Truuze API URL</label>
              <input type="text" value={truuzeUrl} onChange={e => setTruuzeUrl(e.target.value)} className="form-input" />
            </div>

            {truuzeMode === 'token' ? (
              <>
                <div className="form-group">
                  <label>Provisioning Token</label>
                  <input type="text" value={truuzeToken} onChange={e => setTruuzeToken(e.target.value)} className="form-input" placeholder="trz_prov_..." />
                  <p className="form-hint">Get this from Truuze: My Agents → Sponsor an Agent</p>
                </div>
                <div className="form-group">
                  <label>Username (optional)</label>
                  <input type="text" value={truuzeUsername} onChange={e => setTruuzeUsername(e.target.value)} className="form-input" placeholder="my_agent" />
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label>First Name (optional)</label>
                    <input type="text" value={truuzeFirstName} onChange={e => setTruuzeFirstName(e.target.value)} className="form-input" />
                  </div>
                  <div className="form-group">
                    <label>Last Name (optional)</label>
                    <input type="text" value={truuzeLastName} onChange={e => setTruuzeLastName(e.target.value)} className="form-input" />
                  </div>
                </div>
              </>
            ) : (
              <div className="form-group">
                <label>Agent Key</label>
                <input type="password" value={truuzeKey} onChange={e => setTruuzeKey(e.target.value)} className="form-input" placeholder="trz_agent_..." />
              </div>
            )}

            <div className="form-actions">
              <button className="btn btn-primary" onClick={() => connect('truuze')} disabled={saving}>
                {saving ? 'Connecting...' : 'Connect'}
              </button>
              <button className="btn" onClick={() => setShowForm(null)}>Cancel</button>
            </div>
            {formMsg && <p className="form-hint" style={{ color: 'var(--text-error)' }}>{formMsg}</p>}
          </div>
        </div>
      )}

      {showForm === 'http' && (
        <div className="card" style={{ marginTop: '1.5rem' }}>
          <div className="card-header">Connect HTTP API</div>
          <div className="card-body">
            <div className="form-group">
              <label>Port</label>
              <input type="number" value={httpPort} onChange={e => setHttpPort(e.target.value)} className="form-input" />
              <p className="form-hint">The agent will listen on this port when running.</p>
            </div>
            <div className="form-actions">
              <button className="btn btn-primary" onClick={() => connect('http')} disabled={saving}>
                {saving ? 'Connecting...' : 'Connect'}
              </button>
              <button className="btn" onClick={() => setShowForm(null)}>Cancel</button>
            </div>
            {formMsg && <p className="form-hint" style={{ color: 'var(--text-error)' }}>{formMsg}</p>}
          </div>
        </div>
      )}

      {showForm === 'openclaw' && (
        <div className="card" style={{ marginTop: '1.5rem' }}>
          <div className="card-header">Connect to OpenClaw</div>
          <div className="card-body">
            <p className="form-hint">This will sync your workspace to OpenClaw's directory when running.</p>
            <div className="form-actions">
              <button className="btn btn-primary" onClick={() => connect('openclaw')} disabled={saving}>
                {saving ? 'Connecting...' : 'Connect'}
              </button>
              <button className="btn" onClick={() => setShowForm(null)}>Cancel</button>
            </div>
            {formMsg && <p className="form-hint" style={{ color: 'var(--text-error)' }}>{formMsg}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
