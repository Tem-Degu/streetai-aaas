import React, { useState, useEffect } from 'react';
import { useFetch, useApi } from '../hooks/useApi.js';

export default function Soul() {
  const { data, loading, error, refetch } = useFetch('/api/soul');
  const { put } = useApi();
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    if (data) setContent(data.content || '');
  }, [data]);

  async function handleSave() {
    setSaving(true);
    setMessage(null);
    try {
      await put('/api/soul', { content });
      setMessage({ type: 'success', text: 'Saved successfully' });
      refetch();
    } catch (e) {
      setMessage({ type: 'error', text: e.message });
    }
    setSaving(false);
  }

  if (loading) return <div className="loading">Loading SOUL.md</div>;
  if (error) return <div className="empty">Error: {error}</div>;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">SOUL.md</h1>
        <p className="page-desc">Personality, communication style, and core principles</p>
      </div>

      <textarea
        className="editor"
        value={content}
        onChange={e => setContent(e.target.value)}
        spellCheck={false}
      />

      <div className="save-bar">
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
        {message && (
          <span className={`save-msg ${message.type}`}>{message.text}</span>
        )}
      </div>
    </div>
  );
}
