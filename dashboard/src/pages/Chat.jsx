import React, { useState, useRef, useEffect, useMemo, useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import { useFetch, useResolveUrl, WorkspaceContext } from '../hooks/useApi.js';
import { marked } from 'marked';

export default function Chat() {
  const { data: overview } = useFetch('/api/overview');
  const { data: config, loading: configLoading } = useFetch('/api/config');
  const resolve = useResolveUrl();
  const navigate = useNavigate();
  const workspace = useContext(WorkspaceContext);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [mode, setMode] = useState('admin');
  const bottomRef = useRef(null);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null);

  const agentName = overview?.name || 'Agent';
  const hasProvider = !!(config?.provider && config?.configuredProviders?.length > 0);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (hasProvider) inputRef.current?.focus();
  }, [hasProvider]);

  // Load chat history from session on mount
  useEffect(() => {
    fetch(resolve(`/api/chat/history?mode=${mode}`))
      .then(r => r.ok ? r.json() : { messages: [] })
      .then(data => {
        const history = (data.messages || []).map(m => ({
          role: m.role === 'assistant' ? 'agent' : m.role,
          text: m.content,
          files: m.files,
          time: m.at ? new Date(m.at) : new Date(),
        }));
        if (history.length > 0) setMessages(history);
      })
      .catch(() => {});
  }, [mode]);

  async function handleFileSelect(e) {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;
    e.target.value = '';

    setUploading(true);
    const uploaded = [];

    for (const file of files) {
      try {
        const formData = new FormData();
        formData.append('file', file);
        const res = await fetch(resolve('/api/chat/upload'), {
          method: 'POST',
          body: formData,
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Upload failed');
        }
        const data = await res.json();
        uploaded.push({ id: data.id, name: data.name, size: data.size });
      } catch (err) {
        setError(`Failed to upload ${file.name}: ${err.message}`);
      }
    }

    setAttachedFiles(prev => [...prev, ...uploaded]);
    setUploading(false);
  }

  function removeFile(id) {
    setAttachedFiles(prev => prev.filter(f => f.id !== id));
  }

  function isImageFile(f) {
    if (f?.type === 'image') return true;
    const name = typeof f === 'string' ? f : f?.name || '';
    return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name);
  }

  function fileSrc(f) {
    return f.url ? resolve(f.url) : resolve(`/api/chat/files/${f.id}`);
  }

  function fileKey(f, i) {
    return f.id || f.url || `f-${i}`;
  }

  function renderMessageText(text) {
    if (!text) return null;
    const html = marked.parse(text, { breaks: true });
    return <div className="chat-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  async function handleSend() {
    const msg = input.trim();
    if ((!msg && attachedFiles.length === 0) || sending) return;

    const files = [...attachedFiles];
    setInput('');
    setAttachedFiles([]);
    setError(null);

    setMessages(prev => [...prev, { role: 'user', text: msg, files, time: new Date() }]);
    setSending(true);

    try {
      const body = { message: msg, mode };
      if (files.length > 0) body.files = files;

      const res = await fetch(resolve('/api/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `${res.status} ${res.statusText}`);
      }

      const data = await res.json();
      setMessages(prev => [...prev, { role: 'agent', text: data.response, files: data.files, time: new Date() }]);
    } catch (e) {
      setError(e.message);
      setMessages(prev => [...prev, { role: 'error', text: e.message, time: new Date(), _retryMsg: msg, _retryFiles: files }]);
    }
    setSending(false);
    inputRef.current?.focus();
  }

  async function handleRetry(errorMsg) {
    setMessages(prev => prev.filter(m => m !== errorMsg));
    setError(null);
    setSending(true);

    try {
      const body = { message: errorMsg._retryMsg, mode };
      if (errorMsg._retryFiles?.length > 0) body.files = errorMsg._retryFiles;

      const res = await fetch(resolve('/api/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `${res.status} ${res.statusText}`);
      }

      const data = await res.json();
      setMessages(prev => [...prev, { role: 'agent', text: data.response, files: data.files, time: new Date() }]);
    } catch (e) {
      setError(e.message);
      setMessages(prev => [...prev, { role: 'error', text: e.message, time: new Date(), _retryMsg: errorMsg._retryMsg, _retryFiles: errorMsg._retryFiles }]);
    }
    setSending(false);
    inputRef.current?.focus();
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  async function handleClearSession() {
    try {
      await fetch(resolve(`/api/chat/session?mode=${mode}`), { method: 'DELETE' });
      setMessages([]);
      setError(null);
      setShowClearConfirm(false);
    } catch (e) {
      setError('Failed to clear session: ' + e.message);
      setShowClearConfirm(false);
    }
  }

  if (configLoading) return <div className="page-loading">Loading...</div>;

  return (
    <div className="chat-container">
      <div className="page-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1 className="page-title">Chat</h1>
          <p className="page-desc">Talk to {agentName}</p>
        </div>
        <div className="chat-mode-toggle">
          <button
            className={`chat-mode-btn ${mode === 'admin' ? 'active' : ''}`}
            onClick={() => setMode('admin')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            Admin
          </button>
          <button
            className={`chat-mode-btn ${mode === 'customer' ? 'active' : ''}`}
            onClick={() => setMode('customer')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
            Customer
          </button>
          <button
            className="chat-mode-btn chat-clear-btn"
            onClick={() => setShowClearConfirm(true)}
            title="Clear session history"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
            </svg>
            Clear
          </button>
        </div>
      </div>

      {/* No LLM configured banner */}
      {!hasProvider && (
        <div className="chat-setup-banner">
          <div className="chat-setup-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <div className="chat-setup-text">
            <strong>No LLM provider configured</strong>
            <p>To chat with your agent, you need to set up an LLM provider first. Add your API key or connect via OAuth.</p>
          </div>
          <button className="btn btn-primary" onClick={() => navigate(workspace ? `/ws/${workspace}/settings` : '/settings')}>
            Go to Settings
          </button>
        </div>
      )}

      {error && (
        <div style={{ padding: '8px 12px', background: 'rgba(212,90,90,0.1)', border: '1px solid var(--red)', borderRadius: 6, color: 'var(--red)', fontSize: 13, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{error}</span>
          <button onClick={() => setError(null)} style={{ background: 'none', border: 'none', color: 'var(--red)', cursor: 'pointer', fontSize: 16 }}>✕</button>
        </div>
      )}

      <div className="chat-messages">
        {messages.length === 0 && hasProvider && (
          <div className="chat-empty">
            {mode === 'admin'
              ? <>Send a message to configure or manage your agent.<p className="form-hint" style={{ marginTop: 8 }}>You can set up services, data, personality, and extensions through chat.</p></>
              : <>Send a message as a customer to test your agent's service.<p className="form-hint" style={{ marginTop: 8 }}>The agent will treat you as a real customer.</p></>
            }
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`chat-msg chat-msg-${msg.role}`}>
            <div className="chat-msg-label">
              {msg.role === 'user' ? (mode === 'admin' ? 'You (Admin)' : 'You (Customer)') : msg.role === 'agent' ? agentName : 'Error'}
            </div>
            <div className="chat-msg-text">
              {msg.text && renderMessageText(msg.text)}
              {msg.files?.length > 0 && (
                <div className="chat-msg-files">
                  {msg.files.filter(f => isImageFile(f)).map((f, i) => (
                    <a key={fileKey(f, i)} className="chat-file-image" href={fileSrc(f)} target="_blank" rel="noopener noreferrer">
                      <img src={fileSrc(f)} alt={f.alt || f.name} />
                    </a>
                  ))}
                  {msg.files.filter(f => !isImageFile(f)).map((f, i) => (
                    <a key={fileKey(f, i)} className="chat-file-badge" href={fileSrc(f)} target="_blank" rel="noopener noreferrer" title={f.size ? `${f.name} (${formatSize(f.size)})` : f.name}>
                      <svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M17 10.5V7.5a5.5 5.5 0 00-11 0v6a3.5 3.5 0 007 0V7a1.5 1.5 0 00-3 0v7" />
                      </svg>
                      {f.name}
                      {f.size && <span className="chat-file-size">{formatSize(f.size)}</span>}
                    </a>
                  ))}
                </div>
              )}
              {msg.role === 'error' && i === messages.length - 1 && !sending && (
                <button className="chat-retry-btn" onClick={() => handleRetry(msg)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="23 4 23 10 17 10" />
                    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                  </svg>
                  Retry
                </button>
              )}
            </div>
          </div>
        ))}

        {sending && (
          <div className="chat-msg chat-msg-agent">
            <div className="chat-msg-label">{agentName}</div>
            <div className="chat-msg-text chat-typing">Thinking...</div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Attached files preview */}
      {attachedFiles.length > 0 && (
        <div className="chat-attachments">
          {attachedFiles.map(f => (
            <div key={f.id} className={`chat-attachment ${isImageFile(f) ? 'chat-attachment-image' : ''}`}>
              {isImageFile(f) && (
                <img src={fileSrc(f)} alt={f.name} className="chat-attachment-thumb" />
              )}
              <span className="chat-attachment-name">{f.name}</span>
              <span className="chat-attachment-size">{formatSize(f.size)}</span>
              <button className="btn-icon" onClick={() => removeFile(f.id)}>✕</button>
            </div>
          ))}
        </div>
      )}

      <div className="chat-input-bar">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileSelect}
          style={{ display: 'none' }}
        />
        <button
          className="chat-attach-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={sending || uploading || !hasProvider}
          title="Attach files"
        >
          {uploading ? (
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <circle cx="10" cy="10" r="7" strokeDasharray="22" strokeDashoffset="11" className="spin" />
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 10.5V7.5a5.5 5.5 0 00-11 0v6a3.5 3.5 0 007 0V7a1.5 1.5 0 00-3 0v7" />
            </svg>
          )}
        </button>
        <textarea
          ref={inputRef}
          className="chat-input"
          placeholder={hasProvider ? 'Type a message...' : 'Configure a provider in Settings first'}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          disabled={sending || !hasProvider}
        />
        <button className="btn btn-primary" onClick={handleSend} disabled={sending || !hasProvider || (!input.trim() && attachedFiles.length === 0)}>
          Send
        </button>
      </div>

      {showClearConfirm && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 100,
          background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onClick={() => setShowClearConfirm(false)}>
          <div className="card" style={{ maxWidth: 420, width: '90%' }} onClick={e => e.stopPropagation()}>
            <div className="card-header">Clear chat session?</div>
            <div className="card-body">
              <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--text)' }}>
                This will permanently delete all messages in your <strong>{mode}</strong> session. The agent will lose context of this conversation. This cannot be undone.
              </p>
              <div className="form-actions" style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-danger" onClick={handleClearSession}>Clear Session</button>
                <button className="btn" onClick={() => setShowClearConfirm(false)}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
