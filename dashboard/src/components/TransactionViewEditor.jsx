import React, { useMemo, useState, useEffect } from 'react';
import { useApi } from '../hooks/useApi.js';
import { prettyKey } from '../utils/transactionView.js';

const FORMAT_OPTIONS = ['', 'currency', 'percentage', 'rating', 'date', 'datetime', 'boolean', 'list'];

/**
 * Editor for the owner-overrides layer of the transaction view config.
 *
 * Reads viewConfig (the merged + layered response from /api/transaction-view)
 * and lets the owner reorder columns, toggle visibility, rename labels, and
 * pick a format hint. Saves via PUT /api/transaction-view. The derived layer
 * (from SKILL.md's `## Transaction Fields` block) is never modified here —
 * those changes belong in the skill.
 */
export default function TransactionViewEditor({ viewConfig, onSaved }) {
  const { put } = useApi();
  const derived = viewConfig?._skill_derived || null;
  const overrides = viewConfig?._owner_overrides || {};

  // Master list of fields: pulled from derived detail_sections so the owner
  // can see every captured field, not just the current column set.
  const allFields = useMemo(() => {
    if (!derived) return Array.isArray(viewConfig?.table_columns) ? viewConfig.table_columns : [];
    const set = new Set();
    for (const s of derived.detail_sections || []) {
      for (const k of s.fields || []) set.add(k);
    }
    for (const k of derived.table_columns || []) set.add(k);
    return [...set];
  }, [viewConfig, derived]);

  // Build the initial ordered list. Honors saved column_order, then derived
  // table_columns, then appends remaining detail fields at the end.
  const initialOrder = useMemo(() => {
    const seen = new Set();
    const out = [];
    const push = (k) => { if (!seen.has(k) && allFields.includes(k)) { seen.add(k); out.push(k); } };
    (overrides.column_order || []).forEach(push);
    (derived?.table_columns || []).forEach(push);
    allFields.forEach(push);
    return out;
  }, [allFields, derived, overrides]);

  const [order, setOrder] = useState(initialOrder);
  const [hidden, setHidden] = useState(new Set(overrides.hidden || []));
  const [labels, setLabels] = useState({ ...(overrides.labels || {}) });
  const [formats, setFormats] = useState({ ...(overrides.formats || {}) });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [savedAt, setSavedAt] = useState(null);

  // Re-seed state when viewConfig changes (e.g. after SKILL.md edit).
  useEffect(() => {
    setOrder(initialOrder);
    setHidden(new Set(overrides.hidden || []));
    setLabels({ ...(overrides.labels || {}) });
    setFormats({ ...(overrides.formats || {}) });
  }, [viewConfig]); // eslint-disable-line react-hooks/exhaustive-deps

  const derivedLabels = derived?.labels || {};
  const derivedFormats = derived?.formats || {};

  const isDirty = useMemo(() => {
    const sameOrder = JSON.stringify(order) === JSON.stringify(initialOrder);
    const sameHidden = JSON.stringify([...hidden].sort()) === JSON.stringify([...(overrides.hidden || [])].sort());
    const sameLabels = JSON.stringify(labels) === JSON.stringify(overrides.labels || {});
    const sameFormats = JSON.stringify(formats) === JSON.stringify(overrides.formats || {});
    return !(sameOrder && sameHidden && sameLabels && sameFormats);
  }, [order, hidden, labels, formats, initialOrder, overrides]);

  const move = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j], next[i]];
    setOrder(next);
  };

  const toggleHidden = (k) => {
    const next = new Set(hidden);
    if (next.has(k)) next.delete(k); else next.add(k);
    setHidden(next);
  };

  const setLabel = (k, v) => {
    const next = { ...labels };
    if (v && v.trim() && v.trim() !== (derivedLabels[k] || '')) next[k] = v.trim();
    else delete next[k];
    setLabels(next);
  };

  const setFormat = (k, v) => {
    const next = { ...formats };
    if (v && v !== (derivedFormats[k] || '')) next[k] = v;
    else delete next[k];
    setFormats(next);
  };

  const reset = () => {
    setOrder(initialOrder);
    setHidden(new Set(overrides.hidden || []));
    setLabels({ ...(overrides.labels || {}) });
    setFormats({ ...(overrides.formats || {}) });
    setError(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      // column_order should reflect the user's preferred ordering of the
      // column-eligible fields (i.e. things in derived.table_columns or the
      // flat legacy config). Skip persisting it if it matches the derived
      // order exactly — keeps the JSON file clean.
      const knownColumns = derived?.table_columns || viewConfig?.table_columns || [];
      const knownSet = new Set(knownColumns);
      const samples = order.filter(k => knownSet.has(k) && !hidden.has(k));
      const derivedOrderStr = JSON.stringify(knownColumns.filter(k => !hidden.has(k)));
      const column_order = JSON.stringify(samples) === derivedOrderStr ? undefined : samples;
      const body = {
        ...(column_order ? { column_order } : {}),
        hidden: [...hidden],
        labels,
        formats,
      };
      await put('/api/transaction-view', body);
      setSavedAt(Date.now());
      if (onSaved) onSaved();
    } catch (e) {
      setError(e.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  if (!allFields.length) {
    return (
      <div style={{ padding: '12px 14px', fontSize: 13, color: 'var(--text-muted)' }}>
        No fields configured yet. Add a <code>## Transaction Fields</code> block to your SKILL.md to declare the
        fields you capture per transaction; they will appear here for customization.
      </div>
    );
  }

  return (
    <div style={{ padding: '8px 4px' }}>
      {!derived && (
        <div style={{ padding: '10px 12px', marginBottom: 12, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13, color: 'var(--text-muted)' }}>
          No <code>## Transaction Fields</code> block in SKILL.md yet. Edits here will be saved as owner overrides,
          but adding the block to SKILL.md is the recommended way to define the field set.
        </div>
      )}

      <table className="table" style={{ fontSize: 13 }}>
        <thead>
          <tr>
            <th style={{ width: 60 }}>Order</th>
            <th>Field</th>
            <th>Label</th>
            <th style={{ width: 130 }}>Format</th>
            <th style={{ width: 80, textAlign: 'center' }}>Column</th>
          </tr>
        </thead>
        <tbody>
          {order.map((k, i) => {
            const isHidden = hidden.has(k);
            const effectiveLabel = labels[k] ?? derivedLabels[k] ?? prettyKey(k);
            const effectiveFormat = formats[k] ?? derivedFormats[k] ?? '';
            return (
              <tr key={k} style={isHidden ? { opacity: 0.5 } : undefined}>
                <td>
                  <button className="btn" onClick={() => move(i, -1)} disabled={i === 0} title="Move up" style={{ padding: '2px 6px' }}>↑</button>
                  <button className="btn" onClick={() => move(i, 1)} disabled={i === order.length - 1} title="Move down" style={{ padding: '2px 6px', marginLeft: 4 }}>↓</button>
                </td>
                <td className="txn-mono" style={{ fontSize: 12 }}>{k}</td>
                <td>
                  <input
                    className="input"
                    value={effectiveLabel}
                    onChange={e => setLabel(k, e.target.value)}
                    placeholder={derivedLabels[k] || prettyKey(k)}
                    style={{ width: '100%', fontSize: 13 }}
                  />
                </td>
                <td>
                  <select
                    className="input"
                    value={effectiveFormat}
                    onChange={e => setFormat(k, e.target.value)}
                    style={{ width: '100%', fontSize: 13 }}
                  >
                    {FORMAT_OPTIONS.map(opt => (
                      <option key={opt || '_none'} value={opt}>{opt || '— none —'}</option>
                    ))}
                  </select>
                </td>
                <td style={{ textAlign: 'center' }}>
                  <input
                    type="checkbox"
                    checked={!isHidden}
                    onChange={() => toggleHidden(k)}
                    title={isHidden ? 'Hidden — click to show in the table' : 'Visible in the table'}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, marginTop: 14,
        paddingTop: 12, borderTop: '1px solid var(--border)', flexWrap: 'wrap',
      }}>
        <button
          type="button"
          className="btn btn-primary"
          onClick={save}
          disabled={!isDirty || saving}
          title={!isDirty ? 'Make a change first — reorder a row, toggle Column, edit a label, or change a format' : 'Save your changes'}
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        <button
          type="button"
          className="btn"
          onClick={reset}
          disabled={!isDirty || saving}
          title={!isDirty ? 'Nothing to reset — no unsaved changes' : 'Discard your unsaved changes'}
        >
          Reset
        </button>
        <span style={{ fontSize: 13, minHeight: 18 }}>
          {error && <span style={{ color: 'var(--red)' }}>{error}</span>}
          {!error && isDirty && <span style={{ color: 'var(--accent)' }}>Unsaved changes</span>}
          {!error && !isDirty && savedAt && <span style={{ color: 'var(--green)' }}>✓ Saved</span>}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>
          Order &amp; visibility apply to the main table. Labels and formats apply everywhere.
        </span>
      </div>
    </div>
  );
}
