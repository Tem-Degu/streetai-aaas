import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import { requireWorkspace, readJson } from '../../utils/workspace.js';
import { getProviderCredential } from '../../auth/credentials.js';
import { AgentEngine } from '../../engine/index.js';
import { loadAllConnectors } from '../../connectors/index.js';

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function runCommand(platforms, opts) {
  // Backwards compatibility: if called with only opts (old single-arg signature), shift args
  if (platforms && !Array.isArray(platforms) && typeof platforms === 'object') {
    opts = platforms;
    platforms = [];
  }
  platforms = platforms || [];
  opts = opts || {};

  const ws = requireWorkspace();

  // 1. Load config
  const configPath = path.join(ws, '.aaas', 'config.json');
  const config = readJson(configPath);

  if (!config?.provider) {
    console.error(chalk.red('\n  No LLM configured. Run: aaas config\n'));
    return;
  }

  // 2. Verify credentials
  const credential = getProviderCredential(config.provider);
  if (!credential && config.provider !== 'ollama') {
    console.error(chalk.red(`\n  No API key for ${config.provider}. Run: aaas config\n`));
    return;
  }

  // 3. Check PID file — prevent duplicate instances
  const pidFile = path.join(ws, '.aaas', 'agent.pid');
  if (fs.existsSync(pidFile)) {
    const existingPid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim());
    let alive = false;
    try {
      process.kill(existingPid, 0); // Check if process exists
      alive = true;
    } catch {
      // Process doesn't exist — clean up stale PID file
      fs.unlinkSync(pidFile);
    }

    if (alive) {
      // If --daemon is set with a platform filter, offer to replace the running daemon.
      if (opts.daemon && platforms.length > 0) {
        const answer = await prompt(
          chalk.yellow(`\n  A daemon is already running (PID ${existingPid}).\n`) +
          chalk.yellow(`  Stop it and start a new daemon with: ${platforms.join(', ')}? (y/N) `)
        );
        if (answer.trim().toLowerCase() !== 'y') {
          console.log(chalk.gray('\n  Keeping existing daemon. Nothing changed.\n'));
          return;
        }

        console.log(chalk.gray(`\n  Stopping PID ${existingPid}...`));
        try { process.kill(existingPid, 'SIGTERM'); } catch { /* already gone */ }
        // Wait briefly for the daemon to shut down and release its connectors
        await sleep(1500);
        try { fs.unlinkSync(pidFile); } catch { /* already gone */ }
      } else {
        console.error(chalk.red(`\n  Agent already running (PID ${existingPid}). Run: aaas stop\n`));
        return;
      }
    }
  }

  // 4. Daemon mode — spawn detached worker process, fall back to foreground if it fails
  if (opts.daemon) {
    try {
      const workerPath = path.join(__dirname, '..', 'agent-worker.js');
      const logPath = path.join(ws, '.aaas', 'agent.log');

      fs.mkdirSync(path.dirname(logPath), { recursive: true });

      const out = fs.openSync(logPath, 'a');
      const err = fs.openSync(logPath, 'a');

      const child = spawn(process.execPath, [workerPath, ws, ...platforms], {
        detached: true,
        stdio: ['ignore', out, err],
        cwd: ws,
      });

      child.unref();

      console.log(chalk.green(`\n  Agent started in background (PID ${child.pid})`));
      if (platforms.length > 0) console.log(chalk.gray(`  Platforms: ${platforms.join(', ')}`));
      console.log(chalk.gray(`  Log: ${logPath}`));
      console.log(chalk.gray('  Run "aaas stop" to stop the agent.\n'));
      return;
    } catch (e) {
      console.log(chalk.yellow(`\n  Background mode unavailable. Running in this terminal session instead.`));
      console.log(chalk.yellow(`  The agent will stop when you close this window.`));
    }
  }

  // 5. Foreground mode — run directly in this process
  console.log(chalk.gray('\n  Starting agent...'));

  let engine;
  try {
    engine = new AgentEngine({ workspace: ws, provider: config.provider, config });
    await engine.initialize();
    console.log(chalk.green(`  Engine ready (${config.provider}/${config.model})`));
  } catch (err) {
    console.error(chalk.red(`\n  Failed to start engine: ${err.message}\n`));
    return;
  }

  // 6. Load and start connectors
  const connectors = await loadAllConnectors(ws, engine, { platforms });

  if (connectors.length === 0) {
    if (platforms.length > 0) {
      console.log(chalk.yellow(`\n  No connection configured for: ${platforms.join(', ')}`));
      console.log(chalk.gray('  Run: aaas connect <platform>\n'));
    } else {
      console.log(chalk.yellow('\n  No connections configured. Run: aaas connect <platform>'));
      console.log(chalk.gray('  Available: truuze, http, openclaw\n'));
    }
    return;
  }

  for (const connector of connectors) {
    try {
      await connector.connect();
      const status = connector.getStatus();
      let info = status.platform;
      if (status.url) info += ` (${status.url})`;
      console.log(chalk.green(`  Connected: ${info}`));
    } catch (err) {
      console.error(chalk.red(`  Failed: ${connector.platformName} — ${err.message}`));
    }
  }

  const connected = connectors.filter(c => c.status === 'connected');
  if (connected.length === 0) {
    console.error(chalk.red('\n  No connectors started successfully. Exiting.\n'));
    return;
  }

  // 7. Write PID file
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, String(process.pid));

  // 8. Status summary
  console.log(chalk.blue(`\n  ${engine.agentName} running with ${connected.length} connection(s)`));
  console.log(chalk.gray('  Press Ctrl+C to stop.\n'));

  // 9. Graceful shutdown
  const shutdown = async () => {
    console.log(chalk.gray('\n  Shutting down...'));
    for (const connector of connectors) {
      try {
        await connector.disconnect();
      } catch { /* ignore */ }
    }
    // Clean up PID file
    try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
    console.log(chalk.gray('  Stopped.\n'));
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep process alive
  setInterval(() => {}, 1 << 30);
}
