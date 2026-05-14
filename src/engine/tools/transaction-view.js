import fs from 'fs';
import path from 'path';
import { readText, readJson, writeJson } from '../../utils/workspace.js';

/**
 * Transaction view configuration: parser + reconciler + merger.
 *
 * SKILL.md may contain a `## Transaction Fields` block that declares which
 * fields the agent captures per transaction and how the dashboard should
 * render them. The block is the source of truth for the *derived* config.
 * The owner can rearrange/rename/hide via the dashboard, which writes an
 * *overrides* layer. The effective config exposed at the top level of
 * `.aaas/transaction_view.json` is the merge of derived + overrides.
 *
 * File shape:
 *   {
 *     "_skill_derived":   { table_columns, detail_sections, labels, formats },
 *     "_owner_overrides": { column_order?, hidden?, labels?, formats? },
 *     // merged effective config (what the dashboard reads):
 *     "table_columns":   [...],
 *     "detail_sections": [...],
 *     "labels":          {...},
 *     "formats":         {...}
 *   }
 *
 * Backwards compatibility: workspaces with a flat config (just the merged
 * fields, no _skill_derived) are read as-is. The first reconcile call after
 * an upgrade will rebuild _skill_derived from SKILL.md if a block exists,
 * otherwise the flat config is preserved untouched.
 */

const FORMAT_KEYS = new Set(['currency', 'percentage', 'rating', 'date', 'datetime', 'boolean', 'list']);
const DEFAULT_COLUMN_CAP = 4;

/**
 * Parse the `## Transaction Fields` block from SKILL.md.
 *
 * Block format (one field per line, all parts after the key are optional):
 *   - field_key (type, column) — Display Label
 *   - field_key (type) — Display Label
 *   - field_key (column)
 *   - field_key
 *
 * `type` is one of: text, number, currency, percentage, date, datetime,
 * rating, boolean, list. Only the formatting types are written to `formats`;
 * `text` and `number` are accepted but produce no format entry.
 *
 * The `column` flag marks a field as a table column. Fields appear in the
 * table in the order listed. If no field carries the flag, the first
 * DEFAULT_COLUMN_CAP fields become columns.
 *
 * Returns:
 *   { found: boolean, fields: [{ key, type, isColumn, label }] }
 */
export function parseTransactionFieldsBlock(skillText) {
  if (!skillText || typeof skillText !== 'string') {
    return { found: false, fields: [] };
  }

  // Match the heading and capture everything until the next H2 / EOF.
  const headingRe = /(^|\n)##\s+Transaction\s+Fields\s*\n([\s\S]*?)(?=\n##\s+|\n#\s+|$)/i;
  const m = skillText.match(headingRe);
  if (!m) return { found: false, fields: [] };

  const body = m[2];
  const lineRe = /^\s*[-*]\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\(([^)]*)\))?\s*(?:[—–-]\s*(.+?))?\s*$/;
  const fields = [];
  const seen = new Set();

  for (const raw of body.split('\n')) {
    const lm = raw.match(lineRe);
    if (!lm) continue;

    const key = lm[1];
    if (seen.has(key)) continue;
    seen.add(key);

    const parens = (lm[2] || '').toLowerCase();
    const label = (lm[3] || '').trim() || null;

    let type = null;
    let isColumn = false;
    if (parens) {
      const parts = parens.split(',').map(s => s.trim()).filter(Boolean);
      for (const p of parts) {
        if (p === 'column') isColumn = true;
        else if (!type) type = p; // first non-flag token is the type
      }
    }

    fields.push({ key, type, isColumn, label });
  }

  return { found: fields.length > 0, fields };
}

/**
 * Build a fresh derived config object from a parsed block. Pure function.
 */
export function buildDerivedConfig(parsed) {
  if (!parsed || !parsed.fields || parsed.fields.length === 0) {
    return null;
  }

  const explicitColumns = parsed.fields.filter(f => f.isColumn).map(f => f.key);
  const tableColumns = explicitColumns.length
    ? explicitColumns
    : parsed.fields.slice(0, DEFAULT_COLUMN_CAP).map(f => f.key);

  const labels = {};
  const formats = {};
  for (const f of parsed.fields) {
    if (f.label) labels[f.key] = f.label;
    if (f.type && FORMAT_KEYS.has(f.type)) formats[f.key] = f.type;
  }

  const detailSections = [{
    title: 'Service Details',
    fields: parsed.fields.map(f => f.key),
  }];

  return {
    table_columns: tableColumns,
    detail_sections: detailSections,
    labels,
    formats,
  };
}

/**
 * Merge derived config with owner overrides into the effective top-level
 * fields that the dashboard reads. Pure function.
 *
 * Override semantics:
 *  - column_order: reorders table_columns. Unknown keys are dropped; derived
 *    columns not listed are appended (so new skill fields auto-appear).
 *  - hidden: keys removed from table_columns (NOT from detail_sections —
 *    to drop a field from the detail view, edit SKILL.md to remove it from
 *    the block).
 *  - labels / formats: shallow-merged on top of derived.
 */
export function mergeWithOverrides(derived, overrides) {
  const d = derived || {};
  const o = overrides || {};
  const hidden = new Set(Array.isArray(o.hidden) ? o.hidden : []);

  // ── table_columns ──
  const derivedCols = Array.isArray(d.table_columns) ? d.table_columns.filter(k => !hidden.has(k)) : [];
  let tableColumns;
  if (Array.isArray(o.column_order) && o.column_order.length) {
    const ordered = o.column_order.filter(k => derivedCols.includes(k));
    const orderedSet = new Set(ordered);
    const tail = derivedCols.filter(k => !orderedSet.has(k));
    tableColumns = [...ordered, ...tail];
  } else {
    tableColumns = derivedCols;
  }

  // ── detail_sections ──
  // Detail view always shows the full derived set. The owner removes fields
  // from the detail view by editing SKILL.md, not via overrides.
  const detailSections = Array.isArray(d.detail_sections) ? d.detail_sections : [];

  // ── labels / formats ──
  const labels = { ...(d.labels || {}), ...(o.labels || {}) };
  const formats = { ...(d.formats || {}), ...(o.formats || {}) };

  return { table_columns: tableColumns, detail_sections: detailSections, labels, formats };
}

/**
 * Read the on-disk config, normalize legacy flat shape into the new layered
 * shape (without overwriting anything), and return both layers.
 */
function loadLayered(paths) {
  const existing = readJson(paths.transactionView) || {};
  const hasLayers = '_skill_derived' in existing || '_owner_overrides' in existing;

  if (hasLayers) {
    return {
      derived: existing._skill_derived || null,
      overrides: existing._owner_overrides || {},
    };
  }

  // Legacy flat config: treat the whole thing as derived so the dashboard
  // keeps showing the same columns until the next reconcile or save.
  const hasAnyKey = ['table_columns', 'detail_sections', 'labels', 'formats']
    .some(k => existing[k] != null);
  return {
    derived: hasAnyKey ? {
      table_columns: existing.table_columns || [],
      detail_sections: existing.detail_sections || [],
      labels: existing.labels || {},
      formats: existing.formats || {},
    } : null,
    overrides: {},
  };
}

/**
 * Persist the layered config and the merged effective fields to disk.
 */
function persistLayered(paths, { derived, overrides }) {
  const merged = mergeWithOverrides(derived, overrides);
  const out = {
    _skill_derived: derived || null,
    _owner_overrides: overrides || {},
    ...merged,
  };
  fs.mkdirSync(path.dirname(paths.transactionView), { recursive: true });
  writeJson(paths.transactionView, out);
  return out;
}

/**
 * Reconcile transaction_view.json from the current SKILL.md content.
 *
 * Called by writeSkill (after writing) and by the dashboard when reading.
 * If the block is missing, leaves any existing derived config alone — we
 * never silently drop the owner's setup just because they re-saved a skill
 * that forgot the block.
 */
export function reconcileFromSkill(paths, skillText) {
  const parsed = parseTransactionFieldsBlock(skillText);
  const { derived: prevDerived, overrides } = loadLayered(paths);

  let nextDerived = prevDerived;
  if (parsed.found) {
    nextDerived = buildDerivedConfig(parsed);
  }

  // If there's nothing on disk and no block in skill, do nothing — the
  // dashboard's frequency scanner handles this case.
  if (!nextDerived && !prevDerived && (!overrides || Object.keys(overrides).length === 0)) {
    return null;
  }

  return persistLayered(paths, { derived: nextDerived, overrides });
}

/**
 * Save owner overrides (called from the dashboard editor and from
 * saveTransactionView). Re-merges and writes the effective config.
 */
export function saveOwnerOverrides(paths, overrides) {
  const { derived } = loadLayered(paths);
  const clean = sanitizeOverrides(overrides);
  return persistLayered(paths, { derived, overrides: clean });
}

function sanitizeOverrides(o) {
  if (!o || typeof o !== 'object') return {};
  const out = {};
  if (Array.isArray(o.column_order)) {
    out.column_order = o.column_order.filter(k => typeof k === 'string');
  }
  if (Array.isArray(o.hidden)) {
    out.hidden = o.hidden.filter(k => typeof k === 'string');
  }
  if (o.labels && typeof o.labels === 'object') {
    out.labels = {};
    for (const [k, v] of Object.entries(o.labels)) {
      if (typeof k === 'string' && typeof v === 'string' && v.trim()) out.labels[k] = v.trim();
    }
  }
  if (o.formats && typeof o.formats === 'object') {
    out.formats = {};
    for (const [k, v] of Object.entries(o.formats)) {
      if (typeof k === 'string' && typeof v === 'string' && FORMAT_KEYS.has(v)) out.formats[k] = v;
    }
  }
  return out;
}

/**
 * Read the current layered state — used by the dashboard editor to show the
 * derived list separately from the overrides.
 */
export function readLayered(paths) {
  return loadLayered(paths);
}
