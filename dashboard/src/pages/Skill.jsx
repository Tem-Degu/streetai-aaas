import React, { useState, useEffect } from 'react';
import { useFetch, useApi } from '../hooks/useApi.js';

const REQUIRED_SECTIONS = [
  'Identity', 'Service Catalog', 'Domain Knowledge',
  'Pricing', 'Boundaries', 'AaaS Protocol'
];

export default function Skill() {
  const { data, loading, error, refetch } = useFetch('/api/skill');
  const { put } = useApi();
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    if (data?.content) setContent(data.content);
  }, [data]);

  const validation = validateSkill(content);

  async function handleSave() {
    setSaving(true);
    setMessage(null);
    try {
      await put('/api/skill', { content });
      setMessage({ type: 'success', text: 'Saved successfully' });
      refetch();
    } catch (e) {
      setMessage({ type: 'error', text: e.message });
    }
    setSaving(false);
  }

  if (loading) return <div className="loading">Loading skill</div>;
  if (error) return <div className="empty">Error: {error}</div>;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">SKILL.md</h1>
        <p className="page-desc">Your agent's service definition and capabilities</p>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">Validation</div>
        <div className="validation-grid">
          {REQUIRED_SECTIONS.map(s => {
            const found = validation.found.includes(s);
            return (
              <span key={s} className={`chip ${found ? 'pass' : 'fail'}`}>
                {found ? '\u2713' : '\u2717'} {s}
              </span>
            );
          })}
          <span className={`chip ${validation.hasFrontmatter ? 'pass' : 'fail'}`}>
            {validation.hasFrontmatter ? '\u2713' : '\u2717'} Frontmatter
          </span>
        </div>
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

function validateSkill(content) {
  const found = REQUIRED_SECTIONS.filter(s =>
    content.match(new RegExp(`^##\\s+.*${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'mi'))
  );
  const hasFrontmatter = content.trimStart().startsWith('---');
  return { found, hasFrontmatter };
}
