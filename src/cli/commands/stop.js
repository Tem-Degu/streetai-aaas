import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { requireWorkspace } from '../../utils/workspace.js';

export function stopCommand() {
  const ws = requireWorkspace();
  const pidFile = path.join(ws, '.aaas', 'agent.pid');

  if (!fs.existsSync(pidFile)) {
    console.log(chalk.gray('\n  Agent not running.\n'));
    return;
  }

  const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim());

  try {
    process.kill(pid, 'SIGTERM');
    fs.unlinkSync(pidFile);
    console.log(chalk.green(`\n  Agent stopped (PID ${pid}).\n`));
  } catch (err) {
    // Process doesn't exist — clean up stale PID file
    fs.unlinkSync(pidFile);
    console.log(chalk.yellow(`\n  Process ${pid} not found. Cleaned up PID file.\n`));
  }
}
