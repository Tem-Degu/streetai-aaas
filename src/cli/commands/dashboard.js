import chalk from 'chalk';
import { findWorkspace } from '../../utils/workspace.js';
import { startServer } from '../../server/index.js';

export async function dashboardCommand(opts) {
  const ws = findWorkspace();
  const port = parseInt(opts.port) || 3400;

  if (ws) {
    console.log(chalk.cyan(`\n  Starting AaaS Dashboard...`));
    console.log(chalk.gray(`  Workspace: ${ws}\n`));
    await startServer(ws, port);
  } else {
    const cwd = process.cwd();
    console.log(chalk.cyan(`\n  Starting AaaS Hub Dashboard...`));
    console.log(chalk.gray(`  Scanning: ${cwd}\n`));
    await startServer(null, port, cwd);
  }
}
