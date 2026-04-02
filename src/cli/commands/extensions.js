import chalk from 'chalk';
import { requireWorkspace, getWorkspacePaths, readJson, writeJson } from '../../utils/workspace.js';

export function extensionsCommand(action, arg, opts) {
  const ws = requireWorkspace();
  const paths = getWorkspacePaths(ws);

  switch (action) {
    case 'list': return extList(paths);
    case 'test': return extTest(paths, arg);
    case 'add': return extAdd(paths, opts);
    case 'remove': return extRemove(paths, arg);
  }
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

async function extTest(paths, name) {
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
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(ext.endpoint, { signal: controller.signal, method: 'HEAD' });
      clearTimeout(timeout);
      if (response.ok || response.status < 500) {
        console.log(chalk.green(`  ✓ Reachable — HTTP ${response.status}`));
      } else {
        console.log(chalk.yellow(`  ⚠ Responded with HTTP ${response.status}`));
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        console.log(chalk.red('  ✗ Timeout (5s)'));
      } else {
        console.log(chalk.red(`  ✗ ${err.message}`));
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
