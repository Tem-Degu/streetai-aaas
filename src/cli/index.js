#!/usr/bin/env node

import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { statusCommand } from './commands/status.js';
import { skillCommand, skillEditCommand, skillNewCommand } from './commands/skill.js';
import { dataCommand } from './commands/data.js';
import { transactionsCommand } from './commands/transactions.js';
import { extensionsCommand } from './commands/extensions.js';
import { logsCommand } from './commands/logs.js';
import { dashboardCommand } from './commands/dashboard.js';
import { deployCommand } from './commands/deploy.js';
import { chatCommand } from './commands/chat.js';
import { configCommand } from './commands/config.js';
import { connectCommand } from './commands/connect.js';
import { connectionsCommand, connectionEditCommand } from './commands/connections.js';
import { disconnectCommand } from './commands/disconnect.js';
import { runCommand } from './commands/run.js';
import { stopCommand } from './commands/stop.js';
import { oauthCommand } from './commands/oauth.js';
import { doctorCommand } from './commands/doctor.js';
import { soulCommand } from './commands/soul.js';
import { memoryCommand } from './commands/memory.js';
import {
  hubInitCommand, hubListCommand, hubNewCommand,
  hubConfigCommand, hubCredsCommand,
  hubRunCommand, hubStopCommand, hubRemoveCommand,
} from './commands/hub.js';

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
  .option('-t, --type <type>', 'Agent type: service (default) or social', 'service')
  .action(initCommand);

program
  .command('status')
  .description('Show agent workspace overview')
  .action(statusCommand);

const skill = program
  .command('skill')
  .description('View and manage the agent skill');

skill
  .command('view', { isDefault: true })
  .description('View skill overview (default)')
  .option('-v, --validate', 'Validate skill has required sections')
  .action(skillCommand);

skill
  .command('edit [platform]')
  .description('Edit a skill file in $EDITOR (default: aaas)')
  .action(skillEditCommand);

skill
  .command('new [platform]')
  .description('Create a new skill file and open in $EDITOR')
  .action(skillNewCommand);

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

data
  .command('import <source> [rename-to]')
  .description('Copy an external file into data/ (optionally rename it)')
  .action((source, renameTo) => dataCommand('import', source, renameTo));

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

txn
  .command('deliver <id>')
  .description('Mark a transaction as delivered')
  .action((id) => transactionsCommand('deliver', id));

txn
  .command('approve <id>')
  .description('Approve a delivered transaction (completes and archives it)')
  .action((id) => transactionsCommand('approve', id));

txn
  .command('dispute <id> [reason]')
  .description('Dispute a delivered transaction')
  .action((id, reason) => transactionsCommand('dispute', id, reason));

txn
  .command('cancel <id>')
  .description('Cancel a transaction (exploring/proposed/accepted/in_progress)')
  .action((id) => transactionsCommand('cancel', id));

txn
  .command('complete <id>')
  .description('Force-complete a transaction and archive it')
  .action((id) => transactionsCommand('complete', id));

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
  .description('Test an extension connection. Calls the first GET operation if registered, else falls back to HEAD on the endpoint.')
  .option('--operation <op>', 'Specific operation name to test')
  .action((name, opts) => extensionsCommand('test', name, opts));

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

ext
  .command('edit')
  .description('Edit extensions registry in $EDITOR')
  .action(() => extensionsCommand('edit'));

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
  .command('soul')
  .description('Edit the agent soul (SOUL.md) in $EDITOR')
  .option('--show', 'Print SOUL.md instead of opening an editor')
  .action(soulCommand);

program
  .command('memory')
  .description('Edit agent memory (memory/facts.json) in $EDITOR')
  .option('--show', 'Print facts.json instead of opening an editor')
  .action(memoryCommand);

const hub = program
  .command('hub')
  .description('Manage a multi-workspace hub');

hub
  .command('init [dir]')
  .description('Mark a directory as an AaaS hub root')
  .action(hubInitCommand);

hub
  .command('list')
  .alias('ls')
  .description('List all workspaces under the hub')
  .option('--hub <dir>', 'Hub directory (defaults to walking up from cwd)')
  .action(hubListCommand);

hub
  .command('new <name> [description]')
  .description('Create a new workspace under the hub')
  .option('-t, --type <type>', 'Agent type: service (default) or social', 'service')
  .option('--hub <dir>', 'Hub directory (defaults to walking up from cwd)')
  .action((name, description, opts) => hubNewCommand(name, description, opts));

hub
  .command('config')
  .description('Edit shared hub config (.aaas/config.json) in $EDITOR')
  .option('--show', 'Print the config instead of opening an editor')
  .option('--hub <dir>', 'Hub directory (defaults to walking up from cwd)')
  .action(hubConfigCommand);

const hubCreds = hub
  .command('creds')
  .description('Manage shared LLM provider credentials (~/.aaas/credentials.json)');

hubCreds
  .command('list')
  .description('List configured providers')
  .option('--hub <dir>', 'Hub directory')
  .action((opts) => hubCredsCommand('list', null, opts));

hubCreds
  .command('set <provider>')
  .description('Set credentials for a provider')
  .option('--key <key>', 'API key')
  .option('--endpoint <url>', 'Endpoint URL (azure)')
  .option('--base-url <url>', 'Base URL')
  .option('--hub <dir>', 'Hub directory')
  .action((provider, opts) => hubCredsCommand('set', provider, opts));

hubCreds
  .command('remove <provider>')
  .description('Remove credentials for a provider')
  .option('--hub <dir>', 'Hub directory')
  .action((provider, opts) => hubCredsCommand('remove', provider, opts));

hub
  .command('run <name>')
  .description('Start a workspace agent in the background')
  .option('--hub <dir>', 'Hub directory')
  .action((name, opts) => hubRunCommand(name, opts));

hub
  .command('stop <name>')
  .description('Stop a running workspace agent')
  .option('--hub <dir>', 'Hub directory')
  .action((name, opts) => hubStopCommand(name, opts));

hub
  .command('remove <name>')
  .description('Permanently delete a workspace (requires --force)')
  .option('--force', 'Confirm deletion')
  .option('--hub <dir>', 'Hub directory')
  .action((name, opts) => hubRemoveCommand(name, opts));

// OAuth flow is not yet ready for end users — AaaS still needs registered
// OAuth applications with each provider. Command is kept in the source so it
// can be re-enabled in the future, but hidden from --help to avoid exposing it.
program
  .command('oauth [provider]', { hidden: true })
  .description('Authenticate with an LLM provider via browser OAuth (anthropic, google, azure)')
  .option('--client-id <id>', 'OAuth client ID (uses default if omitted)')
  .option('--tenant-id <id>', 'Azure tenant ID (defaults to "common")')
  .action(oauthCommand);

program
  .command('connect <platform>')
  .description('Connect to a platform (http, truuze, telegram, discord, slack, whatsapp, relay, openclaw)')
  .option('--token <token>', 'Bot token (telegram, discord) or provisioning token (truuze)')
  .option('--key <key>', 'Existing agent key (truuze)')
  .option('--skill <path>', 'Path to Truuze provisioning SKILL.md (truuze)')
  .option('--username <username>', 'Agent username (truuze)')
  .option('--name <name>', 'Agent name (truuze)')
  .option('--description <desc>', 'Agent description (truuze)')
  .option('--job-title <title>', 'Agent job title (truuze)')
  .option('--base-url <url>', 'Platform base URL')
  .option('--port <port>', 'Port number (http, whatsapp)')
  .option('--id <agentId>', 'Agent ID (openclaw)')
  .option('--bot-token <botToken>', 'Bot token (slack: xoxb-...)')
  .option('--app-token <appToken>', 'App-level token (slack: xapp-...)')
  .option('--access-token <accessToken>', 'Access token (whatsapp)')
  .option('--phone-number-id <phoneNumberId>', 'Phone number ID (whatsapp)')
  .option('--verify-token <verifyToken>', 'Webhook verify token (whatsapp)')
  .option('--force', 'Overwrite existing connection')
  .action(connectCommand);

program
  .command('connections')
  .description('List active platform connections')
  .action(connectionsCommand);

program
  .command('connection-edit <platform>')
  .description('Edit a platform connection file in $EDITOR')
  .action(connectionEditCommand);

program
  .command('disconnect <platform>')
  .description('Remove a platform connection')
  .action(disconnectCommand);

program
  .command('run [platforms...]')
  .description('Start the agent with all connected platforms, or only the ones listed')
  .option('--daemon', 'Run in background')
  .action((platforms, opts) => runCommand(platforms, opts));

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
  .command('doctor')
  .description('Check workspace health — node, credentials, connections, structure')
  .action(doctorCommand);

program
  .command('dashboard [agent-name]')
  .description('Open the web dashboard (optionally for a specific agent)')
  .option('-p, --port <port>', 'Port number', '3400')
  .action(dashboardCommand);

program.parse();
