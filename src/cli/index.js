#!/usr/bin/env node

import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { statusCommand } from './commands/status.js';
import { skillCommand } from './commands/skill.js';
import { dataCommand } from './commands/data.js';
import { transactionsCommand } from './commands/transactions.js';
import { extensionsCommand } from './commands/extensions.js';
import { logsCommand } from './commands/logs.js';
import { dashboardCommand } from './commands/dashboard.js';
import { deployCommand } from './commands/deploy.js';
import { chatCommand } from './commands/chat.js';
import { configCommand } from './commands/config.js';
import { connectCommand } from './commands/connect.js';
import { connectionsCommand } from './commands/connections.js';
import { disconnectCommand } from './commands/disconnect.js';
import { runCommand } from './commands/run.js';
import { stopCommand } from './commands/stop.js';

const program = new Command();

program
  .name('aaas')
  .description('Agent as a Service — build and manage AaaS agents')
  .version('0.1.0');

program
  .command('init <directory>')
  .description('Create a new AaaS agent workspace')
  .argument('[name]', 'Agent display name')
  .argument('[description]', 'One-line service description')
  .action(initCommand);

program
  .command('status')
  .description('Show agent workspace overview')
  .action(statusCommand);

program
  .command('skill')
  .description('View and validate the agent skill')
  .option('-v, --validate', 'Validate skill has required sections')
  .action(skillCommand);

const data = program
  .command('data')
  .description('Manage service database');

data
  .command('list')
  .description('List data files')
  .action((...args) => dataCommand('list', args));

data
  .command('view <file>')
  .description('View a data file')
  .action((file) => dataCommand('view', file));

data
  .command('stats')
  .description('Show database statistics')
  .action(() => dataCommand('stats'));

data
  .command('create <filename>')
  .description('Create a new data file')
  .action((filename) => dataCommand('create', filename));

data
  .command('add <file>')
  .description('Add a record from stdin: echo \'{"key":"val"}\' | aaas data add file.json')
  .action((file) => dataCommand('add', file));

data
  .command('remove <file> <index>')
  .description('Remove a record by index')
  .action((file, index) => dataCommand('remove', file, index));

const txn = program
  .command('transactions')
  .alias('txn')
  .description('Manage transactions');

txn
  .command('list')
  .description('List transactions')
  .option('-a, --all', 'Include archived transactions')
  .option('-s, --status <status>', 'Filter by status')
  .action((opts) => transactionsCommand('list', opts));

txn
  .command('view <id>')
  .description('View a transaction')
  .action((id) => transactionsCommand('view', id));

txn
  .command('stats')
  .description('Transaction statistics')
  .action(() => transactionsCommand('stats'));

const ext = program
  .command('extensions')
  .alias('ext')
  .description('Manage extensions');

ext
  .command('list')
  .description('List registered extensions')
  .action(() => extensionsCommand('list'));

ext
  .command('test <name>')
  .description('Test an extension connection')
  .action((name) => extensionsCommand('test', name));

ext
  .command('add')
  .description('Add a new extension')
  .requiredOption('--name <name>', 'Extension name')
  .option('--type <type>', 'Type: api, agent, human, tool', 'api')
  .option('--endpoint <url>', 'API endpoint URL')
  .option('--address <addr>', 'Agent username or contact')
  .option('--description <desc>', 'Description')
  .action((opts) => extensionsCommand('add', null, opts));

ext
  .command('remove <name>')
  .description('Remove an extension')
  .action((name) => extensionsCommand('remove', name));

program
  .command('logs')
  .description('View recent memory and activity')
  .option('-d, --days <n>', 'Number of days to show', '2')
  .action(logsCommand);

program
  .command('config')
  .description('Configure LLM provider and model')
  .option('--provider <name>', 'Provider: anthropic, openai, google, ollama, openrouter, azure')
  .option('--model <model>', 'Model name')
  .option('--key <key>', 'API key')
  .option('--show', 'Show current configuration')
  .option('--remove <provider>', 'Remove provider credentials')
  .action(configCommand);

program
  .command('chat')
  .description('Chat with your agent')
  .action(chatCommand);

program
  .command('connect <platform>')
  .description('Connect to a platform (http, truuze, telegram, discord, slack, whatsapp, openclaw)')
  .option('--token <token>', 'Provisioning token (truuze)')
  .option('--key <key>', 'Existing agent key (truuze)')
  .option('--username <username>', 'Agent username (truuze)')
  .option('--firstName <name>', 'Agent first name (truuze)')
  .option('--lastName <name>', 'Agent last name (truuze)')
  .option('--description <desc>', 'Agent description (truuze)')
  .option('--base-url <url>', 'Platform base URL')
  .option('--port <port>', 'Port number (http)', '3300')
  .option('--id <agentId>', 'Agent ID (openclaw)')
  .option('--force', 'Overwrite existing connection')
  .action(connectCommand);

program
  .command('connections')
  .description('List active platform connections')
  .action(connectionsCommand);

program
  .command('disconnect <platform>')
  .description('Remove a platform connection')
  .action(disconnectCommand);

program
  .command('run')
  .description('Start the agent with all connected platforms')
  .option('--daemon', 'Run in background')
  .action(runCommand);

program
  .command('stop')
  .description('Stop a running agent')
  .action(stopCommand);

program
  .command('deploy')
  .description('Deploy agent to OpenClaw (legacy — use "aaas connect openclaw" instead)')
  .option('-s, --status', 'Show deploy status')
  .option('--id <agentId>', 'Agent ID (defaults to skill name)')
  .action(deployCommand);

program
  .command('dashboard')
  .description('Open the web dashboard')
  .option('-p, --port <port>', 'Port number', '3400')
  .action(dashboardCommand);

program.parse();
