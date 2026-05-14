import path from 'path';

/**
 * Module-level registry of in-process connectors per workspace.
 *
 * Why this exists: `apiRouter(workspace)` tracks connectors started via the
 * Deploy page in a closure-local object. That object is invisible to other
 * routers in the same process — notably `hub.js`, which previously could
 * only detect "running" workspaces via the `.aaas/agent.pid` file (the
 * daemon path). This registry gives the hub read access to in-process
 * connectors so its badge stays accurate.
 *
 * Storage: Map keyed by absolute, resolved workspace path → an object
 * mapping platform name → connector instance. The object reference is
 * stable for the lifetime of the workspace, so `apiRouter` can hold it in
 * its closure and mutate it directly (existing behavior is preserved).
 */

const _connectorsByWorkspace = new Map();

function normalizeKey(workspacePath) {
  return path.resolve(workspacePath);
}

/**
 * Return the per-workspace connector map (creates it on first call).
 * The returned object reference is stable — callers can mutate it directly
 * (`map[platform] = connector`, `delete map[platform]`).
 */
export function getConnectorMap(workspacePath) {
  const key = normalizeKey(workspacePath);
  let map = _connectorsByWorkspace.get(key);
  if (!map) {
    map = {};
    _connectorsByWorkspace.set(key, map);
  }
  return map;
}

/**
 * Read the status of a single platform's connector, or null if not present.
 * Safe to call for workspaces that have never started a connector.
 */
export function getConnectorStatus(workspacePath, platform) {
  const key = normalizeKey(workspacePath);
  const map = _connectorsByWorkspace.get(key);
  if (!map) return null;
  const c = map[platform];
  return c?.status || null;
}

/**
 * True if the workspace has at least one connector currently `connected`.
 */
export function hasRunningConnector(workspacePath) {
  const key = normalizeKey(workspacePath);
  const map = _connectorsByWorkspace.get(key);
  if (!map) return false;
  for (const c of Object.values(map)) {
    if (c?.status === 'connected') return true;
  }
  return false;
}
