import path from 'path';
import fs from 'fs';
import { getConnectorMap } from './connector-registry.js';
import { loadConnector } from '../connectors/index.js';
import { listConnections } from '../auth/connections.js';
import { readJson } from '../utils/workspace.js';
import { AgentEngine } from '../engine/index.js';

/**
 * Shared connector start logic, used by both the Deploy "Start" route and the
 * server-boot auto-start hook so the two behave identically.
 *
 * The connector tracking state is the module-level registry (getConnectorMap),
 * already shared across the whole process — so starting a connector here is
 * visible to the workspace's API router and the hub badge with no extra wiring.
 */

// One engine per workspace for the whole server process. Both the boot
// auto-start path and the API router share it, so there is exactly ONE engine
// (and ONE scheduler) per workspace — no double-fire of scheduled actions.
const _engineCache = new Map(); // resolved workspace path -> AgentEngine

/**
 * Get (or create) the shared, initialized engine for a workspace.
 * Throws if no provider set. Starts the delayed-event scheduler once — the
 * dashboard server is now the runtime that fires scheduled actions (previously
 * only the daemon did). Skipped if a legacy daemon still owns the workspace so
 * the two can't double-fire.
 */
export async function createWorkspaceEngine(workspace) {
  const key = path.resolve(workspace);
  const cached = _engineCache.get(key);
  if (cached?.initialized) return cached;

  const config = readJson(path.join(workspace, '.aaas', 'config.json'));
  if (!config?.provider) {
    throw new Error('No LLM configured. Set a provider in Settings.');
  }
  const eng = new AgentEngine({ workspace, provider: config.provider, config });
  await eng.initialize();
  if (!daemonRunning(workspace)) {
    try { eng.startScheduler(); } catch { /* non-fatal */ }
  }
  _engineCache.set(key, eng);
  return eng;
}

/**
 * Config keys that are baked into the engine at initialize() (the provider
 * client, the base prompt), so changing them needs the engine rebuilt — i.e. a
 * connector restart. Everything else (voice, greeting, …) is read live per call.
 */
export const RESTART_CONFIG_KEYS = ['provider', 'model', 'agentType'];

/**
 * Apply live-read config changes to the running engine in place — no rebuild.
 * Connectors hold this same engine instance and read fields like `config.voice`
 * per call, so the change takes effect on the next call. Skips the init-baked
 * keys so they stay consistent with the already-built provider client until a
 * restart rebuilds the engine. No-op if the engine isn't running yet.
 */
export function applyLiveConfig(workspace, changed) {
  const eng = _engineCache.get(path.resolve(workspace));
  if (!eng?.config || !changed) return;
  for (const [k, v] of Object.entries(changed)) {
    if (!RESTART_CONFIG_KEYS.includes(k)) eng.config[k] = v;
  }
}

/**
 * Dispose the cached engine so the next createWorkspaceEngine() rebuilds it with
 * fresh config (new provider client). Stops the old scheduler first to keep the
 * one-engine / one-scheduler-per-workspace invariant. No-op if none is cached.
 */
export function resetWorkspaceEngine(workspace) {
  const key = path.resolve(workspace);
  const eng = _engineCache.get(key);
  if (!eng) return;
  try { eng.stopScheduler(); } catch { /* non-fatal */ }
  _engineCache.delete(key);
}

/**
 * Start one connector in-process for a workspace, if not already running.
 * `connConfig` is the connection's saved config object; `engine` is the
 * workspace engine to hand the connector.
 * Returns { ok, status, message, alreadyRunning? }.
 */
export async function startConnector(workspace, platform, engine, connConfig) {
  const active = getConnectorMap(workspace);
  if (active[platform]?.status === 'connected') {
    return { ok: true, status: 'connected', alreadyRunning: true, message: `${platform} already running.` };
  }
  const ConnectorClass = await loadConnector(platform);
  if (!ConnectorClass) throw new Error(`No connector for ${platform}.`);

  const connector = new ConnectorClass({ ...connConfig, platform }, engine);
  await connector.connect();
  active[platform] = connector;
  return { ok: true, status: connector.status, message: `${platform} started.` };
}

/** True if a live agent daemon owns this workspace (separate process). */
export function daemonRunning(workspace) {
  const pidFile = path.join(workspace, '.aaas', 'agent.pid');
  if (!fs.existsSync(pidFile)) return false;
  const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
  if (!Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    try { fs.unlinkSync(pidFile); } catch { /* stale */ }
    return false;
  }
}

/**
 * Auto-start every connector flagged `autoStart` for a workspace, skipping any
 * already running. Never throws — per-connector failures are collected so one
 * bad connector can't block the others (or server boot). Skips the whole
 * workspace if a daemon already owns it (it runs the connectors itself).
 * Returns an array of per-connector result objects.
 */
export async function autoStartConnectors(workspace) {
  const results = [];
  if (daemonRunning(workspace)) return results;

  let connections;
  try { connections = listConnections(workspace); } catch { return results; }
  const flagged = connections.filter(c => c?.config?.autoStart);
  if (flagged.length === 0) return results;

  const active = getConnectorMap(workspace);
  let engine = null;
  for (const conn of flagged) {
    if (active[conn.platform]?.status === 'connected') {
      results.push({ platform: conn.platform, ok: true, skipped: 'already running' });
      continue;
    }
    try {
      if (!engine) engine = await createWorkspaceEngine(workspace);
      const r = await startConnector(workspace, conn.platform, engine, conn.config);
      results.push({ platform: conn.platform, ...r });
    } catch (e) {
      results.push({ platform: conn.platform, ok: false, error: e.message });
    }
  }
  return results;
}
