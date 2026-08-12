import fs from 'fs';
import path from 'path';
import { readText, readJson, writeJson } from '../../utils/workspace.js';
import { reconcileFromSkill, saveOwnerOverrides } from './transaction-view.js';

// Extensions whose contents must never be inlined into tool results. Loading
// the bytes as UTF-8 produces garbled mojibake AND can balloon the next LLM
// call past the provider's context limit (e.g. a 2MB PNG ≈ 2M tokens).
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tif', '.tiff', '.svg',
  '.pdf',
  '.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac',
  '.mp4', '.mov', '.webm', '.avi', '.mkv',
  '.zip', '.tar', '.gz', '.tgz', '.rar', '.7z',
  '.bin', '.exe', '.dll', '.so', '.dylib',
]);

// Hard cap on inlined text reads. Above this, return a size-aware truncation
// notice instead of the full content. 256KB ≈ ~64K tokens — enough room for
// real data files, but a fraction of any provider's context window.
const MAX_TEXT_READ_BYTES = 256 * 1024;

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
  // Reconcile the transaction view config from the new skill content. Best
  // effort — a parser error must not block a successful skill write.
  try { reconcileFromSkill(paths, content); } catch { /* non-fatal */ }
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
 * Apply variable substitutions to a list of workspace files. Used during
 * first-time setup of templated workspaces (e.g. the restaurant template).
 *
 * Reads `data/template.config.json` for the `files_to_substitute` list,
 * then runs a mechanical `{{KEY}}` → value replacement across each file.
 * No LLM-driven rewriting — the substitution preserves frontmatter,
 * section order, whitespace, and every other structural detail exactly.
 *
 * Args:
 *   - values:        { [KEY]: string } — the answers collected from the owner
 *   - files:         optional override of the files list (defaults to the
 *                    files_to_substitute array in template.config.json)
 *
 * Returns a JSON string with:
 *   - ok:             boolean
 *   - files_updated:  [{ file, substitutions }]
 *   - remaining:      [{ file, placeholders: [...] }] — any `{{KEY}}`
 *                     tokens that didn't get substituted (caller should
 *                     surface these so the owner knows what's missing)
 *
 * Admin-only — registered in the admin tool list.
 */
export function applyTemplateVariables(paths, { values, files }) {
  if (!values || typeof values !== 'object') {
    return JSON.stringify({ error: 'values is required (object mapping KEY → value).' });
  }

  let fileList = files;
  if (!Array.isArray(fileList)) {
    const cfgPath = path.join(paths.data, 'template.config.json');
    if (!fs.existsSync(cfgPath)) {
      return JSON.stringify({ error: 'No files list provided and data/template.config.json not found.' });
    }
    const cfg = readJson(cfgPath);
    fileList = cfg?.files_to_substitute;
    if (!Array.isArray(fileList)) {
      return JSON.stringify({ error: 'template.config.json does not contain a files_to_substitute array.' });
    }
  }

  const filesUpdated = [];
  const remaining = [];

  for (const relPath of fileList) {
    // Resolve workspace-root-relative path. Block path traversal.
    const safeRel = String(relPath).replace(/\.\./g, '').replace(/^[\/\\]+/, '');
    const fp = path.resolve(paths.root, safeRel);
    if (!fp.startsWith(path.resolve(paths.root))) {
      remaining.push({ file: relPath, error: 'invalid path' });
      continue;
    }
    if (!fs.existsSync(fp)) {
      remaining.push({ file: relPath, error: 'file not found' });
      continue;
    }

    const original = fs.readFileSync(fp, 'utf-8');
    let updated = original;
    let substitutions = 0;

    // All substitutions operate on the ORIGINAL content per file by
    // accumulating replacements. That stops a value containing a literal
    // {{KEY}} from being touched by a later substitution.
    for (const [key, value] of Object.entries(values)) {
      const token = `{{${key}}}`;
      // Count occurrences in the current state of `updated`
      const parts = updated.split(token);
      if (parts.length > 1) {
        substitutions += parts.length - 1;
        updated = parts.join(String(value ?? ''));
      }
    }

    if (substitutions > 0) {
      fs.writeFileSync(fp, updated, 'utf-8');
    }

    // After substitution, report any leftover {{...}} tokens so the
    // caller can prompt the owner for the missing values.
    const leftoverRe = /\{\{([A-Z_][A-Z0-9_]*)\}\}/g;
    const leftover = new Set();
    let m;
    while ((m = leftoverRe.exec(updated)) !== null) leftover.add(m[1]);
    if (leftover.size > 0) {
      remaining.push({ file: relPath, placeholders: [...leftover] });
    }

    filesUpdated.push({ file: relPath, substitutions });
  }

  return JSON.stringify({ ok: true, files_updated: filesUpdated, remaining });
}

/**
 * Rename or move a file inside the data/ directory. Used when a file
 * landed under a wrong filename (e.g. uploaded with its original
 * generated name) and needs to match a path referenced elsewhere
 * (e.g. menu.json category_images). Path-traversal-guarded.
 */
export function renameDataFile(paths, { from, to }) {
  if (!from || !to) return JSON.stringify({ error: 'from and to are required.' });
  const sanitize = (s) => String(s).replace(/^data[\/\\]/, '').replace(/\.\./g, '');
  const src = path.resolve(paths.data, sanitize(from));
  const dst = path.resolve(paths.data, sanitize(to));
  const dataRoot = path.resolve(paths.data);
  if (!src.startsWith(dataRoot) || !dst.startsWith(dataRoot)) {
    return JSON.stringify({ error: 'Invalid path.' });
  }
  if (!fs.existsSync(src)) return JSON.stringify({ error: `"${from}" not found in data/.` });
  if (fs.existsSync(dst)) return JSON.stringify({ error: `"${to}" already exists.` });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.renameSync(src, dst);
  return JSON.stringify({ ok: true, from: sanitize(from), to: sanitize(to) });
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

  const ext = path.extname(safe).toLowerCase();

  // Binary files: never inline contents. Return metadata + the workspace path
  // the agent should use to reference the file (e.g. in markdown image links).
  if (BINARY_EXTENSIONS.has(ext)) {
    const stat = fs.statSync(fp);
    return JSON.stringify({
      file: safe,
      type: 'binary',
      extension: ext,
      size: stat.size,
      path: `data/${safe}`,
      note: `Binary file — reference by path (e.g. ![label](/api/workspace/data/${safe})). Do not read its contents.`,
    });
  }

  if (safe.endsWith('.json')) {
    const data = readJson(fp);
    return JSON.stringify({ file: safe, data });
  }

  // Text files: cap size to keep tool results from blowing past the context
  // window. If too large, return a truncated head + clear notice so the agent
  // knows the content was partial.
  const stat = fs.statSync(fp);
  if (stat.size > MAX_TEXT_READ_BYTES) {
    const fd = fs.openSync(fp, 'r');
    const buf = Buffer.alloc(MAX_TEXT_READ_BYTES);
    fs.readSync(fd, buf, 0, MAX_TEXT_READ_BYTES, 0);
    fs.closeSync(fd);
    return JSON.stringify({
      file: safe,
      truncated: true,
      size: stat.size,
      returned_bytes: MAX_TEXT_READ_BYTES,
      content: buf.toString('utf-8'),
      note: `File is ${stat.size} bytes; only the first ${MAX_TEXT_READ_BYTES} bytes were returned. Use search_data or run_query for targeted lookups.`,
    });
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

// ── Agent tools (admin-authored code tools) ──

const AGENT_TOOL_NAME = /^[a-zA-Z0-9_-]+$/;

/**
 * Create or replace an "agent tool": a code module at `tools/<name>.js` that
 * default-exports `{ definitions, handlers }`. Writes the file and registers
 * the module name in `.aaas/config.json` under `agentTools`. Does NOT load it —
 * the caller reloads via `ToolRegistry.loadAgentTools()`, which also enforces
 * the `AAAS_ALLOW_AGENT_TOOLS` gate and collision-checks.
 */
export function createAgentTool(paths, { name, code }) {
  if (!name || !AGENT_TOOL_NAME.test(name)) {
    return JSON.stringify({ error: 'A valid tool name is required (letters, numbers, _ or - only).' });
  }
  if (!code || typeof code !== 'string' || !code.trim()) {
    return JSON.stringify({ error: 'code is required — the full JS module that default-exports { definitions, handlers }.' });
  }

  const toolsDir = path.join(paths.root, 'tools');
  const file = path.join(toolsDir, `${name}.js`);
  if (!path.resolve(file).startsWith(path.resolve(toolsDir) + path.sep)) {
    return JSON.stringify({ error: 'Invalid tool name — path escapes tools/.' });
  }

  fs.mkdirSync(toolsDir, { recursive: true });
  fs.writeFileSync(file, code, 'utf-8');

  const config = readJson(paths.config) || {};
  if (!Array.isArray(config.agentTools)) config.agentTools = [];
  if (!config.agentTools.includes(name)) config.agentTools.push(name);
  writeJson(paths.config, config);

  return JSON.stringify({
    ok: true,
    message: `Agent tool "${name}" written to tools/${name}.js and registered.`,
    file: `tools/${name}.js`,
    registered: config.agentTools,
  });
}

/**
 * List the agent tools registered in config, noting which files exist on disk.
 */
export function listAgentTools(paths) {
  const config = readJson(paths.config) || {};
  const registered = Array.isArray(config.agentTools) ? config.agentTools : [];
  const toolsDir = path.join(paths.root, 'tools');
  const files = registered.map(n => ({
    name: n,
    file: `tools/${n}.js`,
    exists: fs.existsSync(path.join(toolsDir, `${n}.js`)),
  }));
  return JSON.stringify({ registered, files });
}

/**
 * Remove an agent tool: delete `tools/<name>.js` and unregister it from
 * `.aaas/config.json`. The caller reloads so it drops from the live toolset.
 */
export function removeAgentTool(paths, { name }) {
  if (!name || !AGENT_TOOL_NAME.test(name)) {
    return JSON.stringify({ error: 'A valid tool name is required.' });
  }
  const toolsDir = path.join(paths.root, 'tools');
  const file = path.join(toolsDir, `${name}.js`);
  if (path.resolve(file).startsWith(path.resolve(toolsDir) + path.sep) && fs.existsSync(file)) {
    try { fs.unlinkSync(file); } catch { /* best-effort */ }
  }

  const config = readJson(paths.config) || {};
  const before = Array.isArray(config.agentTools) ? config.agentTools : [];
  config.agentTools = before.filter(n => n !== name);
  writeJson(paths.config, config);

  return JSON.stringify({
    ok: true,
    message: `Agent tool "${name}" removed (file deleted, unregistered).`,
    registered: config.agentTools,
  });
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
  const requestedDest = path.resolve(paths.data, safe);
  if (!requestedDest.startsWith(path.resolve(paths.data))) {
    return JSON.stringify({ error: 'Invalid destination path.' });
  }

  fs.mkdirSync(path.dirname(requestedDest), { recursive: true });

  // Rename on collision: if "images/foo.png" exists, save as "images/foo-2.png",
  // "foo-3.png", etc. Keeps the agent's intent (original filename) while never
  // silently overwriting a file the owner already attached.
  const { dest, finalRelPath, renamed } = resolveCollision(paths.data, requestedDest, safe);

  fs.copyFileSync(resolvedSource, dest);

  const stat = fs.statSync(dest);
  return JSON.stringify({
    ok: true,
    message: renamed
      ? `File imported to data/${finalRelPath} (renamed from ${safe} — a file with that name already existed).`
      : `File imported to data/${finalRelPath}.`,
    file: finalRelPath,
    renamed,
    size: stat.size,
  });
}

function resolveCollision(dataRoot, requestedAbs, requestedRel) {
  if (!fs.existsSync(requestedAbs)) {
    return { dest: requestedAbs, finalRelPath: requestedRel, renamed: false };
  }
  const dir = path.dirname(requestedAbs);
  const ext = path.extname(requestedAbs);
  const base = path.basename(requestedAbs, ext);
  for (let n = 2; n < 1000; n++) {
    const candidate = path.join(dir, `${base}-${n}${ext}`);
    if (!fs.existsSync(candidate)) {
      const finalRelPath = path.relative(dataRoot, candidate).replace(/\\/g, '/');
      return { dest: candidate, finalRelPath, renamed: true };
    }
  }
  // 1000 collisions is pathological — fall back to a timestamp.
  const candidate = path.join(dir, `${base}-${Date.now()}${ext}`);
  const finalRelPath = path.relative(dataRoot, candidate).replace(/\\/g, '/');
  return { dest: candidate, finalRelPath, renamed: true };
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
