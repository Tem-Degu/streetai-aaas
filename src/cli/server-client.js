// Thin client to the dashboard runtime.
//
// Unified-runtime model: the dashboard server is the single process that runs
// connectors. The CLI (`aaas run`/`aaas stop`/status) is a *client* of it, so
// the CLI and the dashboard always control the same connectors and see the same
// state. This module finds (or starts) that server and talks to its API.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 3400;

/** Read the running dashboard's port from ~/.aaas/dashboard.pid, else default. */
export function dashboardPort() {
  try {
    const pidFile = path.join(os.homedir(), '.aaas', 'dashboard.pid');
    const info = JSON.parse(fs.readFileSync(pidFile, 'utf-8'));
    if (info?.port) return Number(info.port);
  } catch { /* not running / no file */ }
  return DEFAULT_PORT;
}

/** True if an AaaS dashboard answers on this port. */
export async function isServerUp(port = dashboardPort()) {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`http://localhost:${port}/api/health`, { signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) return false;
    const body = await res.json();
    return body && body.service === 'aaas-dashboard';
  } catch {
    return false;
  }
}

/**
 * Ensure the dashboard runtime is running. If it isn't, spawn it **headless**
 * (`--service`: no browser) detached and wait for it to answer.
 * Returns the port it's reachable on. Throws if it can't be started in time.
 */
export async function ensureServer({ name, port = DEFAULT_PORT, timeoutMs = 25_000 } = {}) {
  const existing = dashboardPort();
  if (await isServerUp(existing)) return existing;

  // Spawn the dashboard headless via this same CLI entrypoint. We deliberately
  // do NOT pass the agent name: `aaas dashboard <name>` requires the workspace
  // to be in the global registry and exits if it isn't, whereas the no-name form
  // resolves the workspace from the current directory — so `aaas run` keeps
  // working from any workspace folder, registered or not (as the old daemon did).
  const cliEntry = path.join(__dirname, 'index.js');
  const args = ['dashboard', '--service', '--port', String(port)];

  const child = spawn(process.execPath, [cliEntry, ...args], {
    detached: true,
    stdio: 'ignore',
    cwd: process.cwd(),
  });
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isServerUp(port)) return port;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('Could not start the dashboard runtime (timed out waiting for it to come up).');
}

/**
 * Call a workspace-scoped API route on the running dashboard.
 * `wsName` is the workspace folder name; `apiPath` is like '/deploy/truuze/start'.
 */
export async function apiCall(wsName, apiPath, { method = 'POST', body, port = dashboardPort() } = {}) {
  const url = `http://localhost:${port}/api/ws/${encodeURIComponent(wsName)}${apiPath}`;
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const msg = data?.error || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}
