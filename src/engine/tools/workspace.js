import fs from 'fs';
import path from 'path';
import { readText, readJson, writeJson } from '../../utils/workspace.js';

/**
 * Read the current SKILL.md content.
 */
export function readSkill(paths) {
  const content = readText(paths.skill);
  if (!content) return JSON.stringify({ error: 'SKILL.md not found or empty.' });
  return JSON.stringify({ content });
}

/**
 * Write/replace the entire SKILL.md content.
 */
export function writeSkill(paths, { content }) {
  if (!content) return JSON.stringify({ error: 'content is required.' });
  fs.mkdirSync(path.dirname(paths.skill), { recursive: true });
  fs.writeFileSync(paths.skill, content, 'utf-8');
  return JSON.stringify({ ok: true, message: 'SKILL.md updated.', size: content.length });
}

/**
 * Read the current SOUL.md content.
 */
export function readSoul(paths) {
  const content = readText(paths.soul);
  if (!content) return JSON.stringify({ error: 'SOUL.md not found or empty.' });
  return JSON.stringify({ content });
}

/**
 * Write/replace the entire SOUL.md content.
 */
export function writeSoul(paths, { content }) {
  if (!content) return JSON.stringify({ error: 'content is required.' });
  fs.writeFileSync(paths.soul, content, 'utf-8');
  return JSON.stringify({ ok: true, message: 'SOUL.md updated.', size: content.length });
}

/**
 * Read a data file from the data/ directory.
 */
export function readDataFile(paths, { file }) {
  if (!file) return JSON.stringify({ error: 'file name is required.' });

  // Strip leading "data/" if the agent passes the full relative path
  let cleaned = file.replace(/^data[\/\\]/, '');
  // Block path traversal but allow subdirectories (e.g. inbox/photo.jpg)
  const safe = cleaned.replace(/\.\./g, '');
  const fp = path.resolve(paths.data, safe);

  // Ensure resolved path is still inside data/
  if (!fp.startsWith(path.resolve(paths.data))) {
    return JSON.stringify({ error: 'Invalid file path.' });
  }

  if (!fs.existsSync(fp)) {
    return JSON.stringify({ error: `File "${file}" not found in data/.`, available: listDataFiles(paths) });
  }

  if (safe.endsWith('.json')) {
    const data = readJson(fp);
    return JSON.stringify({ file: safe, data });
  }

  const content = readText(fp);
  return JSON.stringify({ file: safe, content });
}

/**
 * Write/replace a data file in the data/ directory.
 */
export function writeDataFile(paths, { file, data }) {
  if (!file) return JSON.stringify({ error: 'file name is required.' });
  if (data === undefined || data === null) return JSON.stringify({ error: 'data is required.' });

  const safe = file.replace(/\.\./g, '').replace(/[\/\\]/g, '');
  fs.mkdirSync(paths.data, { recursive: true });
  const fp = path.join(paths.data, safe);

  if (typeof data === 'string') {
    fs.writeFileSync(fp, data, 'utf-8');
  } else {
    writeJson(fp, data);
  }

  return JSON.stringify({ ok: true, message: `Data file "${safe}" written.`, file: safe });
}

/**
 * Add a record to a JSON data file (array). Creates the file if it doesn't exist.
 */
export function addDataRecord(paths, { file, record }) {
  if (!file) return JSON.stringify({ error: 'file name is required.' });
  if (!record) return JSON.stringify({ error: 'record is required.' });

  const safe = file.replace(/\.\./g, '').replace(/[\/\\]/g, '');
  fs.mkdirSync(paths.data, { recursive: true });
  const fp = path.join(paths.data, safe);

  let data = readJson(fp);
  if (!Array.isArray(data)) data = [];

  data.push(record);
  writeJson(fp, data);

  return JSON.stringify({ ok: true, message: `Record added to "${safe}".`, total_records: data.length });
}

/**
 * Update or insert a record in a JSON data file (array).
 * Finds an existing record where the key field matches, and updates it.
 * If no match is found, appends a new record.
 */
export function updateDataRecord(paths, { file, key, value, record }) {
  if (!file) return JSON.stringify({ error: 'file name is required.' });
  if (!key) return JSON.stringify({ error: 'key field name is required (e.g. "user_id").' });
  if (value === undefined || value === null) return JSON.stringify({ error: 'value to match is required.' });
  if (!record) return JSON.stringify({ error: 'record is required.' });

  const safe = file.replace(/\.\./g, '').replace(/[\/\\]/g, '');
  fs.mkdirSync(paths.data, { recursive: true });
  const fp = path.join(paths.data, safe);

  let data = readJson(fp);
  if (!Array.isArray(data)) data = [];

  const idx = data.findIndex(r => r && r[key] === value);
  if (idx >= 0) {
    data[idx] = { ...data[idx], ...record };
    writeJson(fp, data);
    return JSON.stringify({ ok: true, action: 'updated', message: `Record with ${key}="${value}" updated in "${safe}".`, total_records: data.length });
  } else {
    data.push(record);
    writeJson(fp, data);
    return JSON.stringify({ ok: true, action: 'inserted', message: `Record with ${key}="${value}" added to "${safe}".`, total_records: data.length });
  }
}

/**
 * Delete a record from a JSON data file (array) by matching a key field.
 */
export function deleteDataRecord(paths, { file, key, value }) {
  if (!file) return JSON.stringify({ error: 'file name is required.' });
  if (!key) return JSON.stringify({ error: 'key field name is required (e.g. "user_id").' });
  if (value === undefined || value === null) return JSON.stringify({ error: 'value to match is required.' });

  const safe = file.replace(/\.\./g, '').replace(/[\/\\]/g, '');
  const fp = path.join(paths.data, safe);

  let data = readJson(fp);
  if (!Array.isArray(data)) return JSON.stringify({ error: `File "${safe}" not found or is not an array.` });

  const before = data.length;
  data = data.filter(r => !(r && r[key] === value));

  if (data.length === before) {
    return JSON.stringify({ error: `No record found with ${key}="${value}" in "${safe}".` });
  }

  writeJson(fp, data);
  return JSON.stringify({ ok: true, message: `Record with ${key}="${value}" deleted from "${safe}".`, removed: before - data.length, total_records: data.length });
}

/**
 * Read the extensions registry.
 */
export function readExtensions(paths) {
  const registry = readJson(paths.extensions);
  return JSON.stringify({ extensions: registry?.extensions || [] });
}

/**
 * Add or update an extension in the registry. Accepts the full extension
 * schema, including operations, headers, output_type, and notes. All fields
 * other than `name` are optional. Strings may use `{{ENV_VAR}}` substitution.
 */
export function addExtension(paths, args) {
  const {
    name,
    type = 'api',
    endpoint,
    address,
    capabilities = [],
    description,
    auth,
    headers,
    operations,
    output_type,
    notes,
    cost_model,
    cost,
  } = args || {};

  if (!name) return JSON.stringify({ error: 'Extension name is required.' });

  fs.mkdirSync(path.dirname(paths.extensions), { recursive: true });
  let registry = readJson(paths.extensions) || { extensions: [] };
  if (!registry.extensions) registry.extensions = [];

  const ext = { name, type };
  if (description) ext.description = description;
  if (endpoint) ext.endpoint = endpoint;
  if (address) ext.address = address;
  if (Array.isArray(capabilities) && capabilities.length) ext.capabilities = capabilities;
  if (auth && typeof auth === 'object') ext.auth = auth;
  if (headers && typeof headers === 'object' && Object.keys(headers).length) ext.headers = headers;
  if (Array.isArray(operations) && operations.length) ext.operations = operations;
  if (output_type) ext.output_type = output_type;
  if (notes) ext.notes = notes;
  if (cost_model) ext.cost_model = cost_model;
  if (cost) ext.cost = cost;

  const existing = registry.extensions.findIndex(e => (e.name || '').toLowerCase() === name.toLowerCase());
  if (existing >= 0) {
    registry.extensions[existing] = ext;
  } else {
    registry.extensions.push(ext);
  }

  writeJson(paths.extensions, registry);
  return JSON.stringify({
    ok: true,
    message: `Extension "${name}" ${existing >= 0 ? 'updated' : 'added'}.`,
    total: registry.extensions.length,
    extension: ext,
  });
}

/**
 * Remove an extension from the registry.
 */
export function removeExtension(paths, { name }) {
  if (!name) return JSON.stringify({ error: 'Extension name is required.' });

  let registry = readJson(paths.extensions) || { extensions: [] };
  if (!registry.extensions) registry.extensions = [];

  const before = registry.extensions.length;
  registry.extensions = registry.extensions.filter(e => e.name.toLowerCase() !== name.toLowerCase());

  if (registry.extensions.length === before) {
    return JSON.stringify({ error: `Extension "${name}" not found.` });
  }

  writeJson(paths.extensions, registry);
  return JSON.stringify({ ok: true, message: `Extension "${name}" removed.`, total: registry.extensions.length });
}

/**
 * Import (copy) a file from uploads into the data/ directory.
 */
export function importFile(paths, { source, destination }) {
  if (!source) return JSON.stringify({ error: 'source path is required.' });
  if (!destination) return JSON.stringify({ error: 'destination filename is required.' });

  // Resolve workspace-relative paths (e.g. "data/inbox/photo.jpg" from [Attached files:])
  const resolvedSource = path.isAbsolute(source) ? source : path.resolve(paths.root, source);

  if (!fs.existsSync(resolvedSource)) {
    return JSON.stringify({ error: `Source file not found: ${source}` });
  }

  // Allow subdirectories but prevent path traversal
  const safe = destination.replace(/\.\./g, '').replace(/\\/g, '/');
  const dest = path.resolve(paths.data, safe);
  if (!dest.startsWith(path.resolve(paths.data))) {
    return JSON.stringify({ error: 'Invalid destination path.' });
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(resolvedSource, dest);

  const stat = fs.statSync(dest);
  return JSON.stringify({ ok: true, message: `File imported to data/${safe}.`, file: safe, size: stat.size });
}

/**
 * Save or update the transaction view configuration.
 * This tells the dashboard how to display transactions for this specific service.
 */
export function saveTransactionView(paths, config) {
  if (!config || typeof config !== 'object') {
    return JSON.stringify({ error: 'config object is required.' });
  }

  // Read existing config and merge
  const existing = readJson(paths.transactionView) || {};
  const merged = { ...existing, ...config };

  // Validate structure
  if (merged.table_columns && !Array.isArray(merged.table_columns)) {
    return JSON.stringify({ error: 'table_columns must be an array of field names.' });
  }
  if (merged.detail_sections && !Array.isArray(merged.detail_sections)) {
    return JSON.stringify({ error: 'detail_sections must be an array.' });
  }

  fs.mkdirSync(path.dirname(paths.transactionView), { recursive: true });
  writeJson(paths.transactionView, merged);
  return JSON.stringify({ ok: true, message: 'Transaction view configuration saved.' });
}

function listDataFiles(paths) {
  if (!fs.existsSync(paths.data)) return [];
  return fs.readdirSync(paths.data).filter(f => !f.startsWith('.'));
}
