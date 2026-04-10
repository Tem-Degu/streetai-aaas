import fs from 'fs';
import path from 'path';
import os from 'os';

const REGISTRY_DIR = path.join(os.homedir(), '.aaas');
const REGISTRY_PATH = path.join(REGISTRY_DIR, 'workspaces.json');

/**
 * Read the global workspace registry (~/.aaas/workspaces.json).
 * Returns an array of { path, name, registeredAt }.
 */
export function readRegistry() {
  try {
    if (!fs.existsSync(REGISTRY_PATH)) return [];
    const data = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
    return Array.isArray(data.workspaces) ? data.workspaces : [];
  } catch {
    return [];
  }
}

/**
 * Write the workspace registry to disk.
 */
function writeRegistry(workspaces) {
  fs.mkdirSync(REGISTRY_DIR, { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify({ workspaces }, null, 2) + '\n');
}

/**
 * Register a workspace path in the global registry.
 * Deduplicates by resolved absolute path.
 */
export function registerWorkspace(wsPath, name) {
  const abs = path.resolve(wsPath);
  const workspaces = readRegistry();

  // Check if already registered (by path)
  const existing = workspaces.find(w => path.resolve(w.path) === abs);
  if (existing) {
    // Update name if changed
    if (name && existing.name !== name) {
      existing.name = name;
      writeRegistry(workspaces);
    }
    return;
  }

  workspaces.push({
    path: abs,
    name: name || path.basename(abs),
    registeredAt: new Date().toISOString(),
  });
  writeRegistry(workspaces);
}

/**
 * Unregister a workspace path from the global registry.
 */
export function unregisterWorkspace(wsPath) {
  const abs = path.resolve(wsPath);
  const workspaces = readRegistry();
  const filtered = workspaces.filter(w => path.resolve(w.path) !== abs);
  if (filtered.length !== workspaces.length) {
    writeRegistry(filtered);
  }
}

/**
 * Get all registered workspace paths, removing stale entries
 * (directories that no longer exist or no longer contain skills/aaas/SKILL.md).
 */
export function getValidWorkspaces() {
  const workspaces = readRegistry();
  const valid = [];
  let changed = false;

  for (const entry of workspaces) {
    const skillPath = path.join(entry.path, 'skills', 'aaas', 'SKILL.md');
    if (fs.existsSync(skillPath)) {
      valid.push(entry);
    } else {
      changed = true; // stale entry, will be removed
    }
  }

  if (changed) {
    writeRegistry(valid);
  }

  return valid;
}
