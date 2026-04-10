import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import chalk from 'chalk';
import { requireWorkspace } from '../../utils/workspace.js';
import { listConnections, getConnectionsDir } from '../../auth/connections.js';

export function connectionsCommand() {
  const ws = requireWorkspace();
  const connections = listConnections(ws);

  if (connections.length === 0) {
    console.log(chalk.gray('\n  No connections configured.'));
    console.log(chalk.gray('  Run: aaas connect <platform> (truuze, http, openclaw)\n'));
    return;
  }

  console.log(chalk.blue('\n  Connections:\n'));

  for (const { platform, config } of connections) {
    const badge = chalk.green('configured');
    console.log(`  ${chalk.bold(platform)}  ${badge}`);

    if (config.baseUrl) console.log(chalk.gray(`    URL: ${config.baseUrl}`));
    if (config.port) console.log(chalk.gray(`    Port: ${config.port}`));
    if (config.agentId) console.log(chalk.gray(`    Agent ID: ${config.agentId}`));
    if (config.ownerUsername) console.log(chalk.gray(`    Owner: ${config.ownerUsername}`));
    if (config.connectedAt) console.log(chalk.gray(`    Connected: ${new Date(config.connectedAt).toLocaleString()}`));
    console.log('');
  }
}

export function connectionEditCommand(platform) {
  const ws = requireWorkspace();
  const file = path.join(getConnectionsDir(ws), `${platform}.json`);
  if (!fs.existsSync(file)) {
    console.error(chalk.red(`\n  No connection found for "${platform}".`));
    const conns = listConnections(ws);
    if (conns.length > 0) {
      console.log(chalk.gray('  Available: ' + conns.map(c => c.platform).join(', ')));
    }
    console.log('');
    return;
  }
  const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');
  const result = spawnSync(editor, [file], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) {
    console.error(chalk.red(`\n  Failed to open editor (${editor}): ${result.error.message}\n`));
    return;
  }
  try { JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch (err) { console.error(chalk.yellow(`\n  Warning: ${platform}.json is not valid JSON — ${err.message}\n`)); }
}
