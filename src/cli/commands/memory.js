import fs from 'fs';
import path from 'path';
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

export function memoryCommand(opts = {}) {
  const ws = requireWorkspace();
  const paths = getWorkspacePaths(ws);
  const file = path.join(paths.memory, 'facts.json');

  if (!fs.existsSync(file)) {
    fs.mkdirSync(paths.memory, { recursive: true });
    fs.writeFileSync(file, '{}\n');
    console.log(chalk.gray(`  Created ${file}`));
  }

  if (opts.show) {
    console.log(chalk.blue('\nmemory/facts.json\n'));
    console.log(fs.readFileSync(file, 'utf-8'));
    console.log('');
    return;
  }

  const editor = pickEditor();
  const result = spawnSync(editor, [file], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) {
    console.error(chalk.red(`\n  Failed to open editor (${editor}): ${result.error.message}\n`));
    return;
  }

  // Validate JSON after edit
  try {
    JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    console.error(chalk.yellow(`\n  Warning: facts.json is not valid JSON after edit — ${err.message}\n`));
  }
}
