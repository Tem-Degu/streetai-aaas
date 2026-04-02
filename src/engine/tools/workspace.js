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

  const safe = file.replace(/\.\./g, '').replace(/[\/\\]/g, '');
  const fp = path.join(paths.data, safe);

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
 * Read the extensions registry.
 */
export function readExtensions(paths) {
  const registry = readJson(paths.extensions);
  return JSON.stringify({ extensions: registry?.extensions || [] });
}

/**
 * Add an extension to the registry.
 */
export function addExtension(paths, { name, type = 'api', endpoint, capabilities = [], description, auth }) {
  if (!name) return JSON.stringify({ error: 'Extension name is required.' });

  fs.mkdirSync(path.dirname(paths.extensions), { recursive: true });
  let registry = readJson(paths.extensions) || { extensions: [] };
  if (!registry.extensions) registry.extensions = [];

  // Check for duplicate
  const existing = registry.extensions.findIndex(e => e.name.toLowerCase() === name.toLowerCase());
  const ext = { name, type, endpoint: endpoint || null, capabilities, description: description || '' };
  if (auth) ext.auth = auth;

  if (existing >= 0) {
    registry.extensions[existing] = ext;
  } else {
    registry.extensions.push(ext);
  }

  writeJson(paths.extensions, registry);
  return JSON.stringify({ ok: true, message: `Extension "${name}" ${existing >= 0 ? 'updated' : 'added'}.`, total: registry.extensions.length });
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

  if (!fs.existsSync(source)) {
    return JSON.stringify({ error: `Source file not found: ${source}` });
  }

  // Allow subdirectories but prevent path traversal
  const safe = destination.replace(/\.\./g, '').replace(/\\/g, '/');
  const dest = path.resolve(paths.data, safe);
  if (!dest.startsWith(path.resolve(paths.data))) {
    return JSON.stringify({ error: 'Invalid destination path.' });
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest);

  const stat = fs.statSync(dest);
  return JSON.stringify({ ok: true, message: `File imported to data/${safe}.`, file: safe, size: stat.size });
}

function listDataFiles(paths) {
  if (!fs.existsSync(paths.data)) return [];
  return fs.readdirSync(paths.data).filter(f => !f.startsWith('.'));
}
