import fs from 'fs';
import { spawnSync } from 'child_process';
import chalk from 'chalk';
import { requireWorkspace, getWorkspacePaths } from '../../utils/workspace.js';

function pickEditor() {
  return (
    process.env.VISUAL ||
    process.env.EDITOR ||
    (process.platform === 'win32' ? 'notepad' : 'vi')
  );
}

export function soulCommand(opts = {}) {
  const ws = requireWorkspace();
  const paths = getWorkspacePaths(ws);
  const file = paths.soul;

  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, '# Soul\n\nDescribe who this agent is — personality, values, voice.\n');
    console.log(chalk.gray(`  Created ${file}`));
  }

  if (opts.show) {
    console.log(chalk.blue('\nSOUL.md\n'));
    console.log(fs.readFileSync(file, 'utf-8'));
    console.log('');
    return;
  }

  const editor = pickEditor();
  const result = spawnSync(editor, [file], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) {
    console.error(chalk.red(`\n  Failed to open editor (${editor}): ${result.error.message}\n`));
  }
}
