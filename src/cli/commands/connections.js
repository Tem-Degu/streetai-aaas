import chalk from 'chalk';
import { requireWorkspace } from '../../utils/workspace.js';
import { listConnections } from '../../auth/connections.js';

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
