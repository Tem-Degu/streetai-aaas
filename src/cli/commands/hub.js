import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import { readJson, writeJson, formatBytes } from '../../utils/workspace.js';
import {
  findHub, requireHub, initHub, getHubConfigPath,
  listHubWorkspaces, createHubWorkspace,
} from '../../utils/hub.js';
import {
  getProviderCredential, setProviderCredential, removeProviderCredential,
  listProviders, maskApiKey,
} from '../../auth/credentials.js';

function pickEditor() {
  return (
    process.env.VISUAL ||
    process.env.EDITOR ||
    (process.platform === 'win32' ? 'notepad' : 'vi')
  );
}

// ─── aaas hub init [dir] ──────────────────────────

export function hubInitCommand(dir) {
  const abs = initHub(dir);
  console.log(chalk.green(`\n  Hub initialized at ${abs}`));
  console.log(chalk.gray(`  Create workspaces under it with: aaas hub new <name>\n`));
}

// ─── aaas hub list ────────────────────────────────

export function hubListCommand(opts = {}) {
  const hub = requireHub(opts.hub);
  const workspaces = listHubWorkspaces(hub);

  console.log(chalk.blue(`\n  Hub: ${hub}\n`));

  if (workspaces.length === 0) {
    console.log(chalk.gray('  No workspaces. Create one with: aaas hub new <name>\n'));
    return;
  }

  console.log(chalk.gray('  Name (directory)                    Provider              Status   Txns  Last active'));
  console.log(chalk.gray('  ' + '─'.repeat(86)));
  for (const w of workspaces) {
    const nameRaw = `${w.name} (${w.directory})`;
    const name = nameRaw.length > 35 ? nameRaw.slice(0, 34) + '…' : nameRaw.padEnd(35);
    const providerRaw = w.provider ? `${w.provider}/${w.model || '?'}` : '—';
    const provider = providerRaw.length > 21 ? providerRaw.slice(0, 20) + '…' : providerRaw.padEnd(21);
    const statusText = w.isRunning ? 'running' : 'stopped';
    const statusCol = (w.isRunning ? chalk.green(statusText) : chalk.gray(statusText)) + ' '.repeat(9 - statusText.length);
    const tx = String(w.activeTx).padEnd(6);
    const last = w.lastActive ? w.lastActive.toLocaleDateString() : '—';
    console.log(`  ${name} ${provider} ${statusCol}${tx}${last}`);
  }
  console.log('');
}

// ─── aaas hub new <name> [description] ────────────

export function hubNewCommand(name, description, opts = {}) {
  const hub = requireHub(opts.hub);
  const agentType = (opts.type || 'service').toLowerCase();
  if (agentType !== 'service' && agentType !== 'social') {
    console.error(chalk.red(`\n  --type must be "service" or "social". Got "${opts.type}"\n`));
    process.exit(1);
  }
  try {
    const { directory, path: target } = createHubWorkspace(hub, name, description, agentType);
    console.log(chalk.green(`\n  Created ${agentType} workspace "${directory}" at ${target}`));
    console.log(chalk.gray(`  cd ${directory} && aaas status\n`));
  } catch (err) {
    console.error(chalk.red(`\n  ${err.message}\n`));
    process.exit(1);
  }
}

// ─── aaas hub config [--show] ─────────────────────

export function hubConfigCommand(opts = {}) {
  const hub = requireHub(opts.hub);
  const file = getHubConfigPath(hub);

  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJson(file, {});
  }

  if (opts.show) {
    console.log(chalk.blue(`\n  ${file}\n`));
    console.log(fs.readFileSync(file, 'utf-8'));
    console.log('');
    return;
  }

  const editor = pickEditor();
  const result = spawnSync(editor, [file], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) {
    console.error(chalk.red(`\n  Failed to open editor (${editor}): ${result.error.message}\n`));
    return;
  }
  try {
    JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    console.error(chalk.yellow(`\n  Warning: hub config is not valid JSON — ${err.message}\n`));
  }
}

// ─── aaas hub creds list | set <provider> | remove <provider> ─

export function hubCredsCommand(action, provider, opts = {}) {
  // Credentials are stored globally in ~/.aaas/credentials.json, so hub
  // membership isn't strictly required — but we still validate we're in a hub
  // to keep the UX consistent with other hub commands.
  requireHub(opts.hub);

  switch (action) {
    case 'list': return credsList();
    case 'set': return credsSet(provider, opts);
    case 'remove': return credsRemove(provider);
    default:
      console.error(chalk.red(`\n  Unknown creds action: ${action}\n`));
      process.exit(1);
  }
}

function credsList() {
  const providers = listProviders();
  if (providers.length === 0) {
    console.log(chalk.gray('\n  No credentials configured.\n  Add one with: aaas hub creds set <provider> --key <key>\n'));
    return;
  }
  console.log(chalk.blue('\n  Configured providers:\n'));
  console.log(chalk.gray('  Provider        Source    Key'));
  console.log(chalk.gray('  ' + '─'.repeat(50)));
  for (const name of providers) {
    const cred = getProviderCredential(name);
    const source = (cred?.source || '—').padEnd(10);
    const key = cred?.apiKey ? maskApiKey(cred.apiKey) : '—';
    console.log(`  ${name.padEnd(16)}${source}${key}`);
  }
  console.log('');
}

function credsSet(provider, opts) {
  if (!provider) {
    console.error(chalk.red('\n  Usage: aaas hub creds set <provider> --key <key> [--endpoint <url>]\n'));
    process.exit(1);
  }
  if (provider !== 'ollama' && !opts.key) {
    console.error(chalk.red(`\n  --key is required for provider "${provider}"\n`));
    process.exit(1);
  }
  const credential = { type: 'api_key' };
  if (opts.key) credential.apiKey = opts.key;
  if (opts.endpoint) credential.endpoint = opts.endpoint;
  if (opts.baseUrl) credential.baseUrl = opts.baseUrl;

  setProviderCredential(provider, credential);
  console.log(chalk.green(`\n  Saved credential for ${provider}`) +
    (opts.key ? chalk.gray(`  (${maskApiKey(opts.key)})\n`) : '\n'));
}

function credsRemove(provider) {
  if (!provider) {
    console.error(chalk.red('\n  Usage: aaas hub creds remove <provider>\n'));
    process.exit(1);
  }
  const removed = removeProviderCredential(provider);
  if (!removed) {
    console.error(chalk.red(`\n  No credential found for ${provider}\n`));
    process.exit(1);
  }
  console.log(chalk.green(`\n  Removed credential for ${provider}\n`));
}

// ─── aaas hub run <name> ──────────────────────────

function resolveWorkspace(hub, name) {
  const workspaces = listHubWorkspaces(hub);
  return workspaces.find(
    w => w.directory === name || w.name.toLowerCase() === name.toLowerCase()
  );
}

export function hubRunCommand(name, opts = {}) {
  const hub = requireHub(opts.hub);
  const ws = resolveWorkspace(hub, name);
  if (!ws) {
    console.error(chalk.red(`\n  Workspace "${name}" not found in hub.\n`));
    return;
  }
  if (ws.isRunning) {
    console.error(chalk.yellow(`\n  "${ws.name}" is already running.\n`));
    return;
  }

  const config = readJson(path.join(ws.path, '.aaas', 'config.json'));
  if (!config?.provider) {
    console.error(chalk.red(`\n  "${ws.name}" has no LLM configured. cd into it and run: aaas config\n`));
    return;
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const workerPath = path.join(__dirname, '..', 'agent-worker.js');
  const logPath = path.join(ws.path, '.aaas', 'agent.log');

  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const out = fs.openSync(logPath, 'a');
  const err = fs.openSync(logPath, 'a');

  const child = spawn(process.execPath, [workerPath, ws.path], {
    detached: true,
    stdio: ['ignore', out, err],
    cwd: ws.path,
  });
  child.unref();

  console.log(chalk.green(`\n  ${ws.name} started (PID ${child.pid})`));
  console.log(chalk.gray(`  Log: ${logPath}\n`));
}

// ─── aaas hub stop <name> ─────────────────────────

export function hubStopCommand(name, opts = {}) {
  const hub = requireHub(opts.hub);
  const ws = resolveWorkspace(hub, name);
  if (!ws) {
    console.error(chalk.red(`\n  Workspace "${name}" not found in hub.\n`));
    return;
  }

  const pidFile = path.join(ws.path, '.aaas', 'agent.pid');
  if (!fs.existsSync(pidFile)) {
    console.log(chalk.gray(`\n  "${ws.name}" is not running.\n`));
    return;
  }

  const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim());
  try {
    process.kill(pid, 'SIGTERM');
    fs.unlinkSync(pidFile);
    console.log(chalk.green(`\n  ${ws.name} stopped (PID ${pid}).\n`));
  } catch {
    fs.unlinkSync(pidFile);
    console.log(chalk.yellow(`\n  Process ${pid} not found. Cleaned up PID file.\n`));
  }
}

// ─── aaas hub remove <name> ───────────────────────

export function hubRemoveCommand(name, opts = {}) {
  const hub = requireHub(opts.hub);
  const ws = resolveWorkspace(hub, name);
  if (!ws) {
    console.error(chalk.red(`\n  Workspace "${name}" not found in hub.\n`));
    return;
  }

  if (ws.isRunning) {
    console.error(chalk.red(`\n  "${ws.name}" is still running. Stop it first: aaas hub stop ${ws.directory}\n`));
    return;
  }

  if (!opts.force) {
    console.error(chalk.yellow(`\n  This will permanently delete "${ws.directory}" at ${ws.path}`));
    console.error(chalk.yellow(`  Re-run with --force to confirm: aaas hub remove ${ws.directory} --force\n`));
    return;
  }

  fs.rmSync(ws.path, { recursive: true, force: true });
  console.log(chalk.green(`\n  Removed workspace "${ws.directory}".\n`));
}
