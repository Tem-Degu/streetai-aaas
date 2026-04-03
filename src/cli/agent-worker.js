#!/usr/bin/env node

/**
 * Agent background worker.
 * Spawned by `aaas run --daemon` or by the dashboard.
 * Runs the engine + all configured connectors as a standalone process.
 *
 * Usage: node agent-worker.js <workspace-path>
 */

import fs from 'fs';
import path from 'path';
import { AgentEngine } from '../engine/index.js';
import { loadAllConnectors } from '../connectors/index.js';
import { getProviderCredential } from '../auth/credentials.js';

const workspace = process.argv[2];
if (!workspace || !fs.existsSync(workspace)) {
  console.error('Usage: node agent-worker.js <workspace-path>');
  process.exit(1);
}

const pidFile = path.join(workspace, '.aaas', 'agent.pid');
const logFile = path.join(workspace, '.aaas', 'agent.log');

// Simple log function that writes to file
function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  fs.appendFileSync(logFile, line);
}

async function main() {
  // Write PID
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, String(process.pid));

  // Clear previous log
  fs.writeFileSync(logFile, '');
  log(`Agent worker started (PID ${process.pid})`);
  log(`Workspace: ${workspace}`);

  // Load config
  const configPath = path.join(workspace, '.aaas', 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  if (!config?.provider) {
    log('ERROR: No LLM configured.');
    cleanup();
    process.exit(1);
  }

  // Verify credentials
  const credential = getProviderCredential(config.provider);
  if (!credential && config.provider !== 'ollama') {
    log(`ERROR: No API key for ${config.provider}.`);
    cleanup();
    process.exit(1);
  }

  // Initialize engine
  let engine;
  try {
    engine = new AgentEngine({ workspace, provider: config.provider, config });
    await engine.initialize();
    log(`Engine ready (${config.provider}/${config.model})`);
  } catch (err) {
    log(`ERROR: Failed to start engine: ${err.message}`);
    cleanup();
    process.exit(1);
  }

  // Load and start connectors
  const connectors = await loadAllConnectors(workspace, engine);

  if (connectors.length === 0) {
    log('WARNING: No connections configured.');
    cleanup();
    process.exit(1);
  }

  let connected = 0;
  for (const connector of connectors) {
    try {
      await connector.connect();
      const status = connector.getStatus();
      let info = status.platform;
      if (status.url) info += ` (${status.url})`;
      log(`Connected: ${info}`);
      connected++;
    } catch (err) {
      log(`FAILED: ${connector.platformName} — ${err.message}`);
    }
  }

  if (connected === 0) {
    log('ERROR: No connectors started successfully.');
    cleanup();
    process.exit(1);
  }

  log(`Agent running with ${connected} connection(s)`);

  // Graceful shutdown
  const shutdown = async (signal) => {
    log(`Received ${signal}, shutting down...`);
    for (const connector of connectors) {
      try { await connector.disconnect(); } catch { /* ignore */ }
    }
    cleanup();
    log('Agent stopped.');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Keep alive
  setInterval(() => {}, 1 << 30);
}

function cleanup() {
  try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
}

main().catch(err => {
  log(`FATAL: ${err.message}`);
  cleanup();
  process.exit(1);
});
