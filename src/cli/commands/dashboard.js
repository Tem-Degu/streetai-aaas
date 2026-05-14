import path from 'path';
import chalk from 'chalk';
import { findWorkspace } from '../../utils/workspace.js';
import { getValidWorkspaces } from '../../utils/registry.js';
import { startServer } from '../../server/index.js';
import { ensureDashboardShortcut } from '../shortcut.js';

export async function dashboardCommand(agentName, opts) {
  const port = parseInt(opts.port) || 3400;
  let hubDir;
  let openPath = '/';

  if (agentName) {
    // Look up agent by name or directory name in the global registry
    const workspaces = getValidWorkspaces();
    const match = workspaces.find(w =>
      path.basename(w.path) === agentName || w.name.toLowerCase() === agentName.toLowerCase()
    );
    if (!match) {
      console.error(chalk.red(`\n  Error: Agent "${agentName}" not found in registry.\n`));
      console.log(chalk.gray('  Registered agents:'));
      for (const w of workspaces) {
        console.log(chalk.gray(`    - ${w.name} (${w.path})`));
      }
      if (workspaces.length === 0) console.log(chalk.gray('    (none)'));
      console.log('');
      process.exit(1);
    }
    hubDir = path.dirname(match.path);
    openPath = `/ws/${path.basename(match.path)}`;
  } else {
    const ws = findWorkspace();
    hubDir = ws ? path.dirname(ws) : process.cwd();
    openPath = ws ? `/ws/${path.basename(ws)}` : '/';
  }

  console.log(chalk.cyan(`\n  Starting AaaS Hub Dashboard...`));
  console.log(chalk.gray(`  Hub: ${hubDir}`));

  // Best-effort: drop a desktop shortcut on first run. Idempotent — won't
  // touch an existing shortcut, won't fail the command if anything goes wrong.
  const shortcut = ensureDashboardShortcut();
  if (shortcut.created) {
    console.log(chalk.gray(`  Added desktop shortcut: ${shortcut.path}`));
  }
  console.log('');

  await startServer(null, port, hubDir, openPath);
}
