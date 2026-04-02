import path from 'path';
import chalk from 'chalk';
import readline from 'readline';
import { requireWorkspace, readJson } from '../../utils/workspace.js';
import { getProviderCredential } from '../../auth/credentials.js';
import { AgentEngine } from '../../engine/index.js';

export async function chatCommand(opts) {
  const ws = requireWorkspace();

  // Load workspace config
  const configPath = path.join(ws, '.aaas', 'config.json');
  const config = readJson(configPath);

  if (!config?.provider) {
    console.error(chalk.red('\n  No LLM configured. Run: aaas config\n'));
    return;
  }

  // Verify credentials exist
  const credential = getProviderCredential(config.provider);
  if (!credential && config.provider !== 'ollama') {
    console.error(chalk.red(`\n  No API key for ${config.provider}. Run: aaas config\n`));
    return;
  }

  // Initialize engine
  console.log(chalk.gray('\n  Loading agent...'));

  let engine;
  try {
    engine = new AgentEngine({ workspace: ws, provider: config.provider, config });
    await engine.initialize();
  } catch (err) {
    console.error(chalk.red(`\n  Failed to start engine: ${err.message}\n`));
    return;
  }

  const agentName = engine.agentName;
  console.log(chalk.blue(`  Connected to ${chalk.bold(agentName)} (${config.provider}/${config.model})`));
  console.log(chalk.gray('  Type your message and press Enter. Type /quit to exit.\n'));

  // REPL loop
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.gray('  You: '),
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const msg = line.trim();

    if (msg === '/quit' || msg === '/exit') {
      console.log(chalk.gray('\n  Disconnected.\n'));
      rl.close();
      process.exit(0);
    }

    if (msg === '/status') {
      const status = engine.getStatus();
      console.log(chalk.gray(`\n  Sessions: ${status.sessionsActive} | Facts: ${status.factsCount} | Tools: ${status.toolsAvailable}\n`));
      rl.prompt();
      return;
    }

    if (msg === '/clear') {
      engine.sessionManager.clearSession('local', 'owner');
      console.log(chalk.gray('\n  Session cleared.\n'));
      rl.prompt();
      return;
    }

    if (!msg) {
      rl.prompt();
      return;
    }

    try {
      process.stdout.write(chalk.gray('  Thinking...'));

      const result = await engine.processChat(msg);

      // Clear "Thinking..." line
      process.stdout.write('\r' + ' '.repeat(40) + '\r');

      // Show response
      console.log(chalk.cyan(`  ${agentName}: `) + result.response);

      // Show tools used if any
      if (result.toolsUsed.length > 0) {
        console.log(chalk.gray(`  [tools: ${result.toolsUsed.join(', ')} | tokens: ${result.tokensUsed}]`));
      }

      console.log('');
    } catch (err) {
      process.stdout.write('\r' + ' '.repeat(40) + '\r');
      console.error(chalk.red(`  Error: ${err.message}\n`));
    }

    rl.prompt();
  });
}
