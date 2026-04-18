import fs from 'fs';
import path from 'path';
import readline from 'readline';
import chalk from 'chalk';
import { requireWorkspace, readJson, writeJson } from '../../utils/workspace.js';
import {
  getProviderCredential,
  setProviderCredential,
  removeProviderCredential,
  listProviders,
  maskApiKey,
  getCredentialsPath,
} from '../../auth/credentials.js';
import { listAvailableProviders, getDefaultModel, createProvider } from '../../engine/providers/index.js';

function runningDaemonPid(ws) {
  const pidFile = path.join(ws, '.aaas', 'agent.pid');
  if (!fs.existsSync(pidFile)) return null;
  const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim());
  if (!pid) return null;
  try { process.kill(pid, 0); return pid; } catch { return null; }
}

function warnIfDaemonStale(ws, prevProvider, prevModel, newProvider, newModel) {
  if (prevProvider === newProvider && prevModel === newModel) return;
  const pid = runningDaemonPid(ws);
  if (!pid) return;
  console.log(chalk.yellow(`  ⚠ Agent is running (PID ${pid}) with the previous provider/model.`));
  console.log(chalk.yellow(`    Restart it to apply the change:  aaas stop  &&  aaas start\n`));
}

export async function configCommand(opts) {
  const ws = requireWorkspace();
  const configPath = path.join(ws, '.aaas', 'config.json');

  // Show current config
  if (opts.show) {
    return showConfig(ws, configPath);
  }

  // Remove a provider
  if (opts.remove) {
    const removed = removeProviderCredential(opts.remove);
    if (removed) {
      console.log(chalk.green(`\n  Removed ${opts.remove} credentials.\n`));
    } else {
      console.log(chalk.yellow(`\n  No credentials found for ${opts.remove}.\n`));
    }
    return;
  }

  // Non-interactive mode
  if (opts.provider) {
    return nonInteractive(ws, configPath, opts);
  }

  // Interactive mode
  return interactive(ws, configPath);
}

function showConfig(ws, configPath) {
  const config = readJson(configPath) || {};
  const configured = listProviders();

  console.log(chalk.blue('\n  AaaS Configuration\n'));
  console.log(`  Workspace: ${chalk.gray(ws)}`);
  console.log(`  Credentials: ${chalk.gray(getCredentialsPath())}`);
  console.log('');

  if (config.provider) {
    console.log(`  Active provider: ${chalk.bold(config.provider)}`);
    console.log(`  Model: ${chalk.bold(config.model || 'default')}`);
  } else {
    console.log(chalk.yellow('  No LLM configured. Run: aaas config'));
  }

  if (configured.length > 0) {
    console.log(`\n  Configured providers:`);
    for (const name of configured) {
      const cred = getProviderCredential(name);
      const source = cred?.source === 'env' ? chalk.gray('(env var)') : chalk.gray('(credentials file)');
      const key = cred?.apiKey ? maskApiKey(cred.apiKey) : 'no key';
      console.log(`    ${chalk.bold(name)} — ${key} ${source}`);
    }
  }

  if (config.context?.budgets) {
    console.log(`\n  Token budgets:`);
    for (const [k, v] of Object.entries(config.context.budgets)) {
      console.log(`    ${k}: ${v}`);
    }
  }

  console.log('');
}

async function nonInteractive(ws, configPath, opts) {
  const providerName = opts.provider;
  const available = listAvailableProviders();

  if (!available.includes(providerName)) {
    console.error(chalk.red(`\n  Unknown provider: ${providerName}`));
    console.log(chalk.gray(`  Available: ${available.join(', ')}\n`));
    return;
  }

  // Check if key exists or was provided
  if (opts.key) {
    setProviderCredential(providerName, { type: 'api_key', apiKey: opts.key });
    console.log(chalk.green(`  Saved ${providerName} API key.`));
  }

  const model = opts.model || getDefaultModel(providerName);

  // Save workspace config
  const config = readJson(configPath) || {};
  const prevProvider = config.provider;
  const prevModel = config.model;
  config.provider = providerName;
  config.model = model;
  if (!config.context) {
    config.context = {
      budgets: { system: 5000, session: 4000, memory: 2000, data: 4000, response: 4000 },
      sessionCompressAt: 4000,
      memoryMaxFacts: 200,
    };
  }
  writeJson(configPath, config);

  console.log(chalk.green(`\n  Configured: ${providerName} / ${model}\n`));
  warnIfDaemonStale(ws, prevProvider, prevModel, providerName, model);
}

async function interactive(ws, configPath) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(resolve => rl.question(q, resolve));

  try {
    console.log(chalk.blue('\n  AaaS — LLM Configuration\n'));

    // 1. Select provider
    const providers = listAvailableProviders();
    console.log('  Select a provider:\n');
    providers.forEach((p, i) => {
      const existing = getProviderCredential(p);
      const badge = existing ? chalk.green(' ✓') : '';
      console.log(`    ${i + 1}. ${p}${badge}`);
    });
    console.log('');

    const choice = await ask('  Enter number: ');
    const idx = parseInt(choice) - 1;
    if (idx < 0 || idx >= providers.length) {
      console.log(chalk.red('\n  Invalid choice.\n'));
      rl.close();
      return;
    }

    const providerName = providers[idx];

    // 2. API key
    if (providerName === 'ollama') {
      const baseUrl = await ask(`  Ollama URL [http://localhost:11434]: `);
      const url = baseUrl.trim() || 'http://localhost:11434';
      setProviderCredential(providerName, { type: 'none', baseUrl: url });
      console.log(chalk.green(`  Saved Ollama config (${url})`));
    } else {
      const existing = getProviderCredential(providerName);
      if (existing && existing.source === 'env') {
        console.log(chalk.green(`\n  Using ${providerName} key from environment variable.`));
      } else if (existing && existing.apiKey) {
        console.log(`\n  Existing key: ${maskApiKey(existing.apiKey)}`);
        const change = await ask('  Replace? (y/N): ');
        if (change.trim().toLowerCase() === 'y') {
          const key = await ask('  API Key: ');
          if (key.trim()) {
            setProviderCredential(providerName, { type: 'api_key', apiKey: key.trim() });
            console.log(chalk.green('  Key saved.'));
          }
        }
      } else {
        const key = await ask(`\n  ${providerName} API Key: `);
        if (!key.trim()) {
          console.log(chalk.red('\n  No key provided. Aborting.\n'));
          rl.close();
          return;
        }
        const cred = { type: 'api_key', apiKey: key.trim() };

        // Azure needs endpoint
        if (providerName === 'azure') {
          const endpoint = await ask('  Azure endpoint URL: ');
          cred.endpoint = endpoint.trim();
        }

        setProviderCredential(providerName, cred);
        console.log(chalk.green('  Key saved.'));
      }
    }

    // 3. Model selection
    const defaultModel = getDefaultModel(providerName);
    const modelInput = await ask(`\n  Model [${defaultModel}]: `);
    const model = modelInput.trim() || defaultModel;

    // 4. Save workspace config
    const config = readJson(configPath) || {};
    const prevProvider = config.provider;
    const prevModel = config.model;
    config.provider = providerName;
    config.model = model;
    if (!config.context) {
      config.context = {
        budgets: { system: 5000, session: 4000, memory: 2000, data: 4000, response: 4000 },
        sessionCompressAt: 4000,
        memoryMaxFacts: 200,
      };
    }
    writeJson(configPath, config);

    // 5. Test connection
    console.log(chalk.gray('\n  Testing connection...'));
    try {
      const provider = await createProvider(providerName, { model });
      const result = await provider.chat([
        { role: 'user', content: 'Say "Hello" in one word.' },
      ], { maxTokens: 10 });

      if (result.content) {
        console.log(chalk.green(`  ✓ Connected — ${providerName}/${model}`));
        console.log(chalk.gray(`    Response: "${result.content.trim()}"`));
      }
    } catch (err) {
      console.log(chalk.yellow(`  ⚠ Connection test failed: ${err.message}`));
      console.log(chalk.gray('  Config saved anyway. Check your API key and try: aaas chat'));
    }

    console.log(chalk.green(`\n  Ready! Run ${chalk.bold('aaas chat')} to talk to your agent.\n`));
    warnIfDaemonStale(ws, prevProvider, prevModel, providerName, model);
    rl.close();
  } catch (err) {
    console.error(chalk.red(`\n  Error: ${err.message}\n`));
    rl.close();
  }
}
