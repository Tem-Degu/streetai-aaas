import chalk from 'chalk';
import { requireWorkspace } from '../../utils/workspace.js';
import { loadConnection, removeConnection } from '../../auth/connections.js';

export function disconnectCommand(platform) {
  const ws = requireWorkspace();

  if (!platform) {
    console.error(chalk.red('\n  Usage: aaas disconnect <platform>\n'));
    return;
  }

  const existing = loadConnection(ws, platform);
  if (!existing) {
    console.error(chalk.red(`\n  Not connected to ${platform}.\n`));
    return;
  }

  removeConnection(ws, platform);
  console.log(chalk.green(`\n  Disconnected from ${platform}.\n`));
}
