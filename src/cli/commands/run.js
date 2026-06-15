import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { requireWorkspace, readJson } from '../../utils/workspace.js';
import { getProviderCredential } from '../../auth/credentials.js';
import { listConnections } from '../../auth/connections.js';
import { ensureServer, apiCall } from '../server-client.js';
import { errorLogPath } from '../../utils/errlog.js';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Start connectors through the dashboard runtime — the same place the dashboard
 * "Start" button runs them, so the CLI and the dashboard share one runtime and
 * one state. (Replaces the old separate daemon: `aaas run` no longer spawns its
 * own process; it ensures the dashboard server is up and asks it to start.)
 *
 *   aaas run                    → start all configured connectors
 *   aaas run truuze whatsapp    → start just those
 *   aaas run truuze --autostart → also enable auto-start for truuze (= the checkbox)
 *   aaas run truuze --attach    → start, then tail the agent error log (Ctrl+C detaches)
 */
export async function runCommand(platforms, opts) {
  // Back-compat with the old single-arg signature: run(opts)
  if (platforms && !Array.isArray(platforms) && typeof platforms === 'object') {
    opts = platforms;
    platforms = [];
  }
  platforms = platforms || [];
  opts = opts || {};

  const ws = requireWorkspace();
  const name = path.basename(ws);

  // 1. Config + credentials (clear errors before we touch the server)
  const config = readJson(path.join(ws, '.aaas', 'config.json'));
  if (!config?.provider) {
    console.error(chalk.red('\n  No LLM configured. Run: aaas config\n'));
    return;
  }
  const credential = getProviderCredential(config.provider);
  if (!credential && config.provider !== 'ollama') {
    console.error(chalk.red(`\n  No API key for ${config.provider}. Run: aaas config\n`));
    return;
  }

  // 2. Resolve target platforms
  let connections;
  try { connections = listConnections(ws); } catch { connections = []; }
  if (connections.length === 0) {
    console.log(chalk.yellow('\n  No connections configured. Run: aaas connect <platform>'));
    console.log(chalk.gray('  Available: truuze, http, whatsapp, telegram, discord, slack, relay, openclaw\n'));
    return;
  }
  const configured = connections.map((c) => c.platform);
  let targets = platforms.length ? platforms : configured;
  const unknown = targets.filter((p) => !configured.includes(p));
  if (unknown.length) {
    console.log(chalk.yellow(`\n  No connection configured for: ${unknown.join(', ')}`));
    targets = targets.filter((p) => configured.includes(p));
  }
  if (targets.length === 0) {
    console.log(chalk.gray('  Nothing to start.\n'));
    return;
  }

  // 3. Ensure the dashboard runtime is up (starts it headless if needed)
  console.log(chalk.gray('\n  Connecting to the agent runtime...'));
  let port;
  try {
    port = await ensureServer({ name });
  } catch (e) {
    console.error(chalk.red(`\n  ${e.message}\n`));
    return;
  }

  // 4. Optionally enable auto-start (same as ticking the dashboard checkbox)
  if (opts.autostart) {
    for (const p of targets) {
      try { await apiCall(name, `/deploy/${p}/autostart`, { body: { enabled: true } }); }
      catch { /* non-fatal */ }
    }
  }

  // 5. Start each connector via the runtime
  let started = 0;
  for (const p of targets) {
    try {
      const r = await apiCall(name, `/deploy/${p}/start`, { body: {} });
      const tag = r?.alreadyRunning ? 'already running' : (r?.status || 'started');
      console.log(chalk.green(`  ${p}: ${tag}`));
      started++;
    } catch (e) {
      console.error(chalk.red(`  ${p}: ${e.message}`));
    }
  }

  if (started === 0) {
    console.error(chalk.red('\n  No connectors started.\n'));
    return;
  }

  console.log(chalk.blue(`\n  Running in the agent runtime on port ${port}.`));
  console.log(chalk.gray('  This survives closing the terminal. Use "aaas stop" or the dashboard to stop it.'));
  if (opts.daemon) {
    console.log(chalk.gray('  (--daemon is no longer needed — connectors already run in the background runtime.)'));
  }

  // 6. Optional: tail the curated error log until Ctrl+C (detaches only)
  if (opts.attach) {
    await attachLog(ws);
  } else {
    console.log('');
  }
}

/** Tail the workspace error log; Ctrl+C detaches the view (connector keeps running). */
async function attachLog(ws) {
  const file = errorLogPath(ws);
  console.log(chalk.gray(`\n  Attached to ${file}`));
  console.log(chalk.gray('  Press Ctrl+C to detach (the connector keeps running).\n'));

  let pos = 0;
  try { pos = fs.statSync(file).size; } catch { /* not created yet */ }

  let stop = false;
  process.on('SIGINT', () => {
    stop = true;
    console.log(chalk.gray('\n  Detached. The connector is still running.\n'));
    process.exit(0);
  });

  while (!stop) {
    try {
      const size = fs.statSync(file).size;
      if (size > pos) {
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(size - pos);
        fs.readSync(fd, buf, 0, buf.length, pos);
        fs.closeSync(fd);
        pos = size;
        process.stdout.write(buf.toString('utf-8'));
      } else if (size < pos) {
        pos = size; // rotated
      }
    } catch { /* file may not exist yet */ }
    await sleep(1000);
  }
}
