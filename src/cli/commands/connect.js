import readline from 'readline';
import chalk from 'chalk';
import { requireWorkspace } from '../../utils/workspace.js';
import { saveConnection, loadConnection } from '../../auth/connections.js';
import { listAvailableConnectors } from '../../connectors/index.js';

export async function connectCommand(platform, opts) {
  const ws = requireWorkspace();

  const available = listAvailableConnectors();
  if (!available.includes(platform)) {
    console.error(chalk.red(`\n  Unknown platform: ${platform}`));
    console.log(chalk.gray(`  Available: ${available.join(', ')}\n`));
    return;
  }

  // Check if already connected
  const existing = loadConnection(ws, platform);
  if (existing && !opts.force) {
    console.log(chalk.yellow(`\n  Already connected to ${platform}.`));
    console.log(chalk.gray('  Use --force to reconfigure, or aaas disconnect ' + platform + ' first.\n'));
    return;
  }

  switch (platform) {
    case 'truuze': return connectTruuze(ws, opts);
    case 'http': return connectHttp(ws, opts);
    case 'openclaw': return connectOpenClaw(ws, opts);
  }
}

async function connectTruuze(ws, opts) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(resolve => rl.question(q, resolve));

  try {
    console.log(chalk.blue('\n  Connect to Truuze\n'));

    // Base URL
    const defaultUrl = 'https://origin.truuze.com/api/v1';
    const baseUrl = (opts.baseUrl || await ask(`  Base URL [${defaultUrl}]: `)).trim() || defaultUrl;

    // Platform API key (shared/public)
    const platformApiKey = '4a3b2c9d1e4f5a6b7c8d9e0f123456789abcdef0123456789abcdef01234567';

    let agentKey = opts.key;
    let agentId = null;
    let ownerUsername = null;

    if (opts.token) {
      // Sign up with provisioning token
      console.log(chalk.gray('  Signing up with provisioning token...'));

      const username = opts.username || await ask('  Agent username: ');
      const firstName = opts.firstName || await ask('  First name: ');
      const lastName = opts.lastName || await ask('  Last name (optional): ');
      const description = opts.description || await ask('  Description (what this agent does): ');

      const signupBody = {
        username: username.trim(),
        first_name: firstName.trim(),
        provisioning_token: opts.token,
        agent_provider: 'aaas',
        agent_description: description.trim(),
      };
      if (lastName.trim()) signupBody.last_name = lastName.trim();

      const res = await fetch(`${baseUrl}/account/create/agent/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': platformApiKey,
        },
        body: JSON.stringify(signupBody),
      });

      if (!res.ok) {
        const err = await res.text();
        console.error(chalk.red(`\n  Signup failed: ${res.status} ${err}\n`));
        rl.close();
        return;
      }

      const data = await res.json();
      agentKey = data.api_key || data.agent_key;
      agentId = data.id;
      ownerUsername = data.owner_username;

      if (!agentKey) {
        console.error(chalk.red('\n  Signup succeeded but no API key in response.\n'));
        console.log(chalk.gray(`  Response: ${JSON.stringify(data)}\n`));
        rl.close();
        return;
      }

      console.log(chalk.green(`  Agent created! ID: ${agentId}`));
    } else if (!agentKey) {
      // Prompt for existing key
      agentKey = await ask('  Agent API key (trz_agent_xxx): ');
      agentKey = agentKey.trim();

      if (!agentKey) {
        console.log(chalk.yellow('\n  No key provided. To create a new agent, use: aaas connect truuze --token <provisioning_token>\n'));
        rl.close();
        return;
      }
    }

    // Verify connection
    console.log(chalk.gray('  Verifying connection...'));
    const verifyRes = await fetch(`${baseUrl}/account/agent/profile/`, {
      headers: {
        'X-Api-Key': platformApiKey,
        'X-Agent-Key': agentKey,
      },
    });

    if (!verifyRes.ok) {
      console.error(chalk.red(`\n  Verification failed: ${verifyRes.status}. Check your agent key.\n`));
      rl.close();
      return;
    }

    const profile = await verifyRes.json();
    console.log(chalk.green(`  ✓ Connected as ${profile.username || profile.agent?.username || 'agent'}`));

    // Save connection
    const connection = {
      platform: 'truuze',
      baseUrl,
      platformApiKey,
      agentKey,
      agentId: agentId || profile.id || profile.agent?.id,
      ownerUsername: ownerUsername || profile.owner_username,
      heartbeatInterval: 30,
      connectedAt: new Date().toISOString(),
    };

    saveConnection(ws, 'truuze', connection);
    console.log(chalk.green(`\n  Saved to .aaas/connections/truuze.json`));
    console.log(chalk.gray(`  Run ${chalk.bold('aaas run')} to start the agent.\n`));

    rl.close();
  } catch (err) {
    console.error(chalk.red(`\n  Error: ${err.message}\n`));
    rl.close();
  }
}

function connectHttp(ws, opts) {
  const port = parseInt(opts.port) || 3300;

  saveConnection(ws, 'http', {
    platform: 'http',
    port,
    connectedAt: new Date().toISOString(),
  });

  console.log(chalk.green(`\n  HTTP connector configured on port ${port}.`));
  console.log(chalk.gray(`  Run ${chalk.bold('aaas run')} to start. API at http://localhost:${port}/chat\n`));
}

function connectOpenClaw(ws, opts) {
  // For OpenClaw, we just save the config — the actual deploy happens at connect time
  saveConnection(ws, 'openclaw', {
    platform: 'openclaw',
    agentId: opts.id || null,
    connectedAt: new Date().toISOString(),
  });

  console.log(chalk.green('\n  OpenClaw connector configured.'));
  console.log(chalk.gray('  Files will be synced to ~/.openclaw/ when the agent runs.\n'));
}
