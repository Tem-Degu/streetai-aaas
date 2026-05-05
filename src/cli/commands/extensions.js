import fs from 'fs';
import { spawnSync } from 'child_process';
import chalk from 'chalk';
import { requireWorkspace, getWorkspacePaths, readJson, writeJson } from '../../utils/workspace.js';

export function extensionsCommand(action, arg, opts) {
  const ws = requireWorkspace();
  const paths = getWorkspacePaths(ws);

  switch (action) {
    case 'list': return extList(paths);
    case 'test': return extTest(paths, arg, opts);
    case 'add': return extAdd(paths, opts);
    case 'remove': return extRemove(paths, arg);
    case 'edit': return extEdit(paths);
  }
}

function extEdit(paths) {
  const file = paths.extensions;
  if (!fs.existsSync(file)) {
    console.error(chalk.red('\n  No extensions registry. Add one with: aaas ext add --name <name>\n'));
    return;
  }
  const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');
  const result = spawnSync(editor, [file], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) {
    console.error(chalk.red(`\n  Failed to open editor (${editor}): ${result.error.message}\n`));
    return;
  }
  try { JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch (err) { console.error(chalk.yellow(`\n  Warning: registry.json is not valid JSON — ${err.message}\n`)); }
}

function extList(paths) {
  const registry = readJson(paths.extensions);
  const extensions = registry?.extensions || [];

  if (extensions.length === 0) {
    console.log(chalk.gray('\n  No extensions registered. Add them to extensions/registry.json\n'));
    return;
  }

  console.log(chalk.blue('\nExtensions:\n'));

  for (const ext of extensions) {
    const typeColors = {
      agent: chalk.magenta,
      api: chalk.cyan,
      human: chalk.yellow,
      tool: chalk.green
    };
    const colorFn = typeColors[ext.type] || chalk.white;

    console.log(`  ${chalk.bold(ext.name)}  ${colorFn(ext.type)}`);

    if (ext.address) console.log(chalk.gray(`    Address: ${ext.address}`));
    if (ext.endpoint) console.log(chalk.gray(`    Endpoint: ${ext.endpoint}`));
    if (ext.capabilities) console.log(chalk.gray(`    Capabilities: ${ext.capabilities.join(', ')}`));
    if (ext.cost_model) console.log(chalk.gray(`    Cost: ${ext.cost || ext.cost_model}`));
    if (ext.notes) console.log(chalk.gray(`    Notes: ${ext.notes}`));
    console.log('');
  }
}

async function extTest(paths, name, opts = {}) {
  const registry = readJson(paths.extensions);
  const extensions = registry?.extensions || [];
  const ext = extensions.find(e =>
    e.name.toLowerCase() === name.toLowerCase() ||
    e.name.toLowerCase().includes(name.toLowerCase())
  );

  if (!ext) {
    console.error(chalk.red(`\n  Extension '${name}' not found.\n`));
    console.log(chalk.gray('  Available:'));
    for (const e of extensions) {
      console.log(chalk.gray(`    ${e.name}`));
    }
    console.log('');
    return;
  }

  console.log(`\n  Testing ${chalk.bold(ext.name)} (${ext.type})...\n`);

  if (ext.type === 'api' && ext.endpoint) {
    // Pick the operation to test:
    //   1. --operation NAME (if provided)
    //   2. First GET operation (safest — read-only)
    //   3. First operation of any kind
    //   4. Fall back to HEAD against the base endpoint
    let opToTest = null;
    if (opts.operation) {
      opToTest = (ext.operations || []).find(o => o.name?.toLowerCase() === String(opts.operation).toLowerCase());
      if (!opToTest) {
        console.log(chalk.red(`  ✗ Operation "${opts.operation}" not found on extension.`));
        if (ext.operations?.length) {
          console.log(chalk.gray(`    Available: ${ext.operations.map(o => o.name).join(', ')}`));
        }
        console.log('');
        return;
      }
    } else if (Array.isArray(ext.operations) && ext.operations.length) {
      opToTest = ext.operations.find(o => (o.method || 'GET').toUpperCase() === 'GET') || ext.operations[0];
    }

    if (opToTest) {
      console.log(chalk.gray(`  Calling operation: ${opToTest.name} (${(opToTest.method || 'GET').toUpperCase()} ${opToTest.path || ''})`));
      try {
        const { callExtension } = await import('../../engine/tools/extensions.js');
        const result = await callExtension(paths, {
          name: ext.name,
          operation: opToTest.name,
          data: opToTest.body || {},
        });
        const parsed = JSON.parse(result);
        if (parsed.error) {
          console.log(chalk.red(`  ✗ ${parsed.error}`));
        } else if (parsed.ok) {
          console.log(chalk.green(`  ✓ HTTP ${parsed.status} — ${typeof parsed.data === 'string' ? parsed.data.slice(0, 80) : JSON.stringify(parsed.data).slice(0, 120)}`));
        } else {
          console.log(chalk.yellow(`  ⚠ HTTP ${parsed.status} — ${JSON.stringify(parsed.data).slice(0, 120)}`));
        }
      } catch (err) {
        console.log(chalk.red(`  ✗ ${err.message}`));
      }
    } else {
      // No operations — fall back to HEAD on the endpoint
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const response = await fetch(ext.endpoint, { signal: controller.signal, method: 'HEAD' });
        clearTimeout(timeout);
        if (response.ok || response.status < 500) {
          console.log(chalk.green(`  ✓ Reachable — HTTP ${response.status} (HEAD)`));
        } else {
          console.log(chalk.yellow(`  ⚠ Responded with HTTP ${response.status} (HEAD)`));
        }
        console.log(chalk.gray(`  Tip: register operations on this extension for richer testing (aaas ext edit).`));
      } catch (err) {
        if (err.name === 'AbortError') {
          console.log(chalk.red('  ✗ Timeout (5s)'));
        } else {
          console.log(chalk.red(`  ✗ ${err.message}`));
        }
      }
    }
  } else if (ext.type === 'agent') {
    console.log(chalk.gray(`  Agent extensions are tested by sending a message through the platform.`));
    console.log(chalk.gray(`  Address: ${ext.address || 'not set'}`));
  } else if (ext.type === 'tool' && ext.command) {
    console.log(chalk.gray(`  Tool command: ${ext.command}`));
    console.log(chalk.gray(`  Run it manually to verify.`));
  } else if (ext.type === 'human') {
    console.log(chalk.gray(`  Human contact: ${ext.address || 'not set'}`));
  }
  console.log('');
}

function loadExtensions(paths) {
  const raw = readJson(paths.extensions);
  if (Array.isArray(raw)) return raw;
  if (raw?.extensions) return raw.extensions;
  return [];
}

function saveExtensions(paths, list) {
  // Keep consistent with whatever format exists
  const raw = readJson(paths.extensions);
  if (Array.isArray(raw) || raw === null) {
    writeJson(paths.extensions, list);
  } else {
    writeJson(paths.extensions, { extensions: list });
  }
}

function extAdd(paths, opts) {
  if (!opts?.name) {
    console.error(chalk.red('\n  Usage: aaas extensions add --name <name> --type <type> [--endpoint <url>] [--address <addr>] [--description <desc>]\n'));
    console.log(chalk.gray('  Types: api, agent, human, tool\n'));
    return;
  }

  const list = loadExtensions(paths);
  const existing = list.find(e => (e.name || '').toLowerCase() === opts.name.toLowerCase());
  if (existing) {
    console.error(chalk.red(`\n  Extension "${opts.name}" already exists. Remove it first to update.\n`));
    return;
  }

  const ext = { name: opts.name, type: opts.type || 'api' };
  if (opts.description) ext.description = opts.description;
  if (opts.endpoint) ext.endpoint = opts.endpoint;
  if (opts.address) ext.address = opts.address;

  list.push(ext);
  saveExtensions(paths, list);
  console.log(chalk.green(`\n  Added extension "${ext.name}" (${ext.type})\n`));
}

function extRemove(paths, name) {
  if (!name) {
    console.error(chalk.red('\n  Usage: aaas extensions remove <name>\n'));
    return;
  }

  const list = loadExtensions(paths);
  const index = list.findIndex(e => (e.name || '').toLowerCase() === name.toLowerCase());

  if (index === -1) {
    console.error(chalk.red(`\n  Extension "${name}" not found.\n`));
    return;
  }

  const removed = list.splice(index, 1)[0];
  saveExtensions(paths, list);
  console.log(chalk.green(`\n  Removed extension "${removed.name}"\n`));
}
