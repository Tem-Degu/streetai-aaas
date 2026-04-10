import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { requireWorkspace, getWorkspacePaths, listFiles, readJson, writeJson, fileStats, formatBytes } from '../../utils/workspace.js';

export function dataCommand(action, arg, extra) {
  const ws = requireWorkspace();
  const paths = getWorkspacePaths(ws);

  switch (action) {
    case 'list': return dataList(paths);
    case 'view': return dataView(paths, arg);
    case 'stats': return dataStats(paths);
    case 'create': return dataCreate(paths, arg);
    case 'add': return dataAdd(paths, arg);
    case 'remove': return dataRemove(paths, arg, extra);
    case 'import': return dataImport(paths, arg, extra);
  }
}

function dataImport(paths, src, renameTo) {
  if (!src) {
    console.error(chalk.red('\n  Usage: aaas data import <source-path> [rename-to]\n'));
    return;
  }
  if (!fs.existsSync(src)) {
    console.error(chalk.red(`\n  Source file not found: ${src}\n`));
    return;
  }
  const stat = fs.statSync(src);
  if (!stat.isFile()) {
    console.error(chalk.red(`\n  Not a file: ${src}\n`));
    return;
  }
  fs.mkdirSync(paths.data, { recursive: true });
  const destName = renameTo || path.basename(src);
  const dest = path.join(paths.data, destName);
  if (fs.existsSync(dest)) {
    console.error(chalk.red(`\n  Destination already exists: data/${destName}\n  Pass a different name as the second argument to rename.\n`));
    return;
  }
  fs.copyFileSync(src, dest);
  console.log(chalk.green(`\n  Imported data/${destName}`) + chalk.gray(`  (${formatBytes(stat.size)})\n`));
}

function dataList(paths) {
  const files = listFiles(paths.data).filter(f => f !== '.gitkeep');

  if (files.length === 0) {
    console.log(chalk.gray('\n  No data files. Add files to data/ to seed your service database.\n'));
    return;
  }

  console.log(chalk.blue('\nService Database:\n'));
  for (const f of files) {
    const fp = path.join(paths.data, f);
    const stat = fileStats(fp);
    const size = stat ? formatBytes(stat.size) : '?';
    let records = '';
    if (f.endsWith('.json')) {
      const data = readJson(fp);
      if (Array.isArray(data)) records = chalk.gray(` (${data.length} records)`);
    }
    console.log(`  ${f}  ${chalk.gray(size)}${records}`);
  }
  console.log('');
}

function dataView(paths, file) {
  const fp = path.join(paths.data, file);

  if (!fs.existsSync(fp)) {
    // Try with common extensions
    for (const ext of ['.json', '.csv', '.txt', '.md']) {
      if (fs.existsSync(fp + ext)) {
        return dataView(paths, file + ext);
      }
    }
    console.error(chalk.red(`\n  File not found: data/${file}\n`));
    return;
  }

  const content = fs.readFileSync(fp, 'utf-8');

  if (file.endsWith('.json')) {
    try {
      const data = JSON.parse(content);
      if (Array.isArray(data)) {
        console.log(chalk.blue(`\n${file}`) + chalk.gray(` — ${data.length} records\n`));
        for (let i = 0; i < data.length; i++) {
          const item = data[i];
          const id = item.id || item.name || item.title || `[${i}]`;
          // Show a compact summary
          const keys = Object.keys(item).filter(k => k !== 'id').slice(0, 4);
          const summary = keys.map(k => {
            const v = item[k];
            if (typeof v === 'string' && v.length > 40) return `${k}: "${v.slice(0, 40)}..."`;
            if (Array.isArray(v)) return `${k}: [${v.length}]`;
            if (typeof v === 'object' && v !== null) return `${k}: {...}`;
            return `${k}: ${v}`;
          }).join(', ');
          console.log(`  ${chalk.bold(String(id))}  ${chalk.gray(summary)}`);
        }
      } else {
        console.log(chalk.blue(`\n${file}\n`));
        console.log(JSON.stringify(data, null, 2));
      }
    } catch {
      console.log(content);
    }
  } else {
    console.log(chalk.blue(`\n${file}\n`));
    console.log(content);
  }
  console.log('');
}

function dataStats(paths) {
  const files = listFiles(paths.data).filter(f => f !== '.gitkeep');
  let totalSize = 0;
  let totalRecords = 0;
  let fileDetails = [];

  for (const f of files) {
    const fp = path.join(paths.data, f);
    const stat = fileStats(fp);
    const size = stat ? stat.size : 0;
    totalSize += size;
    let records = null;
    if (f.endsWith('.json')) {
      const data = readJson(fp);
      if (Array.isArray(data)) { records = data.length; totalRecords += records; }
    }
    fileDetails.push({ name: f, size, records, modified: stat?.modified });
  }

  console.log(chalk.blue('\nDatabase Statistics:\n'));
  console.log(`  Files: ${files.length}`);
  console.log(`  Total size: ${formatBytes(totalSize)}`);
  console.log(`  Total records: ${totalRecords}`);
  console.log('');

  if (fileDetails.length > 0) {
    console.log(chalk.gray('  File                        Size       Records  Modified'));
    console.log(chalk.gray('  ' + '─'.repeat(68)));
    for (const f of fileDetails) {
      const name = f.name.padEnd(28);
      const size = formatBytes(f.size).padEnd(11);
      const records = f.records !== null ? String(f.records).padEnd(9) : '—'.padEnd(9);
      const modified = f.modified ? f.modified.toLocaleDateString() : '—';
      console.log(`  ${name}${size}${records}${modified}`);
    }
  }
  console.log('');
}

function dataCreate(paths, filename) {
  if (!filename) {
    console.error(chalk.red('\n  Usage: aaas data create <filename>\n'));
    return;
  }
  const name = filename.endsWith('.json') ? filename : `${filename}.json`;
  const fp = path.join(paths.data, name);
  if (fs.existsSync(fp)) {
    console.error(chalk.red(`\n  File already exists: data/${name}\n`));
    return;
  }
  writeJson(fp, []);
  console.log(chalk.green(`\n  Created data/${name}\n`));
}

function dataAdd(paths, file) {
  if (!file) {
    console.error(chalk.red('\n  Usage: echo \'{"key":"value"}\' | aaas data add <file>\n'));
    return;
  }

  const fp = path.join(paths.data, file);
  if (!fs.existsSync(fp)) {
    for (const ext of ['.json']) {
      if (fs.existsSync(fp + ext)) { return dataAdd(paths, file + ext); }
    }
    console.error(chalk.red(`\n  File not found: data/${file}\n`));
    return;
  }

  let input = '';
  try {
    input = fs.readFileSync(0, 'utf-8').trim();
  } catch {
    console.error(chalk.red('\n  No input received. Pipe JSON to stdin:\n  echo \'{"name":"test"}\' | aaas data add ' + file + '\n'));
    return;
  }

  if (!input) {
    console.error(chalk.red('\n  Empty input. Pipe JSON to stdin.\n'));
    return;
  }

  let record;
  try {
    record = JSON.parse(input);
  } catch {
    console.error(chalk.red('\n  Invalid JSON input.\n'));
    return;
  }

  const data = readJson(fp);
  if (!Array.isArray(data)) {
    console.error(chalk.red(`\n  ${file} is not a JSON array.\n`));
    return;
  }

  data.push(record);
  writeJson(fp, data);
  console.log(chalk.green(`\n  Added record to data/${file} (${data.length} total)\n`));
}

function dataRemove(paths, file, indexStr) {
  if (!file || indexStr === undefined) {
    console.error(chalk.red('\n  Usage: aaas data remove <file> <index>\n'));
    return;
  }

  const fp = path.join(paths.data, file);
  if (!fs.existsSync(fp)) {
    for (const ext of ['.json']) {
      if (fs.existsSync(fp + ext)) { return dataRemove(paths, file + ext, indexStr); }
    }
    console.error(chalk.red(`\n  File not found: data/${file}\n`));
    return;
  }

  const data = readJson(fp);
  if (!Array.isArray(data)) {
    console.error(chalk.red(`\n  ${file} is not a JSON array.\n`));
    return;
  }

  const index = parseInt(indexStr, 10);
  if (isNaN(index) || index < 0 || index >= data.length) {
    console.error(chalk.red(`\n  Invalid index. File has ${data.length} records (0-${data.length - 1}).\n`));
    return;
  }

  const removed = data.splice(index, 1)[0];
  const label = removed.name || removed.title || removed.id || `[${index}]`;
  writeJson(fp, data);
  console.log(chalk.green(`\n  Removed "${label}" from data/${file} (${data.length} remaining)\n`));
}
