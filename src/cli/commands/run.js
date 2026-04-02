import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { requireWorkspace, readJson } from '../../utils/workspace.js';
import { getProviderCredential } from '../../auth/credentials.js';
import { AgentEngine } from '../../engine/index.js';
import { loadAllConnectors } from '../../connectors/index.js';

export async function runCommand(opts) {
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
    try {
      process.kill(existingPid, 0); // Check if process exists
      console.error(chalk.red(`\n  Agent already running (PID ${existingPid}). Run: aaas stop\n`));
      return;
    } catch {
      // Process doesn't exist — clean up stale PID file
      fs.unlinkSync(pidFile);
    }
  }

  // 4. Initialize engine
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

  // 5. Load and start connectors
  const connectors = await loadAllConnectors(ws, engine);

  if (connectors.length === 0) {
    console.log(chalk.yellow('\n  No connections configured. Run: aaas connect <platform>'));
    console.log(chalk.gray('  Available: truuze, http, openclaw\n'));
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

  // 6. Write PID file
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, String(process.pid));

  // 7. Status summary
  console.log(chalk.blue(`\n  ${engine.agentName} running with ${connected.length} connection(s)`));

  if (opts.daemon) {
    console.log(chalk.gray(`  PID: ${process.pid}`));
    console.log(chalk.gray('  Run "aaas stop" to stop the agent.\n'));
    return;
  }

  console.log(chalk.gray('  Press Ctrl+C to stop.\n'));

  // 8. Graceful shutdown
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
