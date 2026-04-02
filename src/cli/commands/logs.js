import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { requireWorkspace, getWorkspacePaths, listFiles, readText } from '../../utils/workspace.js';

export function logsCommand(opts) {
  const ws = requireWorkspace();
  const paths = getWorkspacePaths(ws);
  const days = parseInt(opts.days) || 2;

  const memFiles = listFiles(paths.memory, '.md');

  if (memFiles.length === 0) {
    console.log(chalk.gray('\n  No memory files yet. The agent creates these as it works.\n'));
    return;
  }

  // Separate daily logs from long-term memory
  const datePattern = /^\d{4}-\d{2}-\d{2}\.md$/;
  const dailyLogs = memFiles.filter(f => datePattern.test(f)).sort().reverse();
  const otherFiles = memFiles.filter(f => !datePattern.test(f));

  // Show recent daily logs
  const recentLogs = dailyLogs.slice(0, days);

  if (recentLogs.length > 0) {
    console.log(chalk.blue('\nRecent Activity:\n'));
    for (const f of recentLogs) {
      const date = f.replace('.md', '');
      const content = readText(path.join(paths.memory, f));
      console.log(chalk.bold(`  ${date}`));
      if (content) {
        const lines = content.split('\n').filter(l => l.trim());
        for (const line of lines.slice(0, 20)) {
          console.log(chalk.gray(`    ${line}`));
        }
        if (lines.length > 20) {
          console.log(chalk.gray(`    ... ${lines.length - 20} more lines`));
        }
      }
      console.log('');
    }
  }

  // Show long-term memory files
  if (otherFiles.length > 0) {
    console.log(chalk.blue('Long-term Memory:\n'));
    for (const f of otherFiles) {
      const stat = fs.statSync(path.join(paths.memory, f));
      const size = stat.size < 1024 ? `${stat.size} B` : `${(stat.size / 1024).toFixed(1)} KB`;
      console.log(`  ${f}  ${chalk.gray(size)}`);
    }
    console.log('');
  }

  if (recentLogs.length === 0 && otherFiles.length === 0) {
    console.log(chalk.gray('\n  No memory files found.\n'));
  }
}
