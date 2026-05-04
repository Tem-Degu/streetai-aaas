import readline from 'readline';
import fs from 'fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import { requireWorkspace, readJson } from '../../utils/workspace.js';
import { saveConnection, loadConnection } from '../../auth/connections.js';
import { listAvailableConnectors } from '../../connectors/index.js';
import { parseTruuzeSkill, buildPlatformSkill } from '../../connectors/truuze-skill.js';
import { AgentEngine } from '../../engine/index.js';

/**
 * Resolve a user-supplied file path. Accepts absolute paths, `~`-prefixed paths
 * (expanded to the home directory), and relative paths (resolved from the
 * shell's current working directory — i.e. wherever the user actually typed
 * the command, which is the natural "main storage" view).
 */
function resolveUserPath(input) {
  if (!input) return null;
  let p = input.trim();
  if (p.startsWith('~')) {
    p = path.join(os.homedir(), p.slice(1));
  }
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

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
    case 'telegram': return connectTelegram(ws, opts);
    case 'discord': return connectDiscord(ws, opts);
    case 'slack': return connectSlack(ws, opts);
    case 'whatsapp': return connectWhatsApp(ws, opts);
    case 'relay': return connectRelay(ws, opts);
  }
}

async function connectTruuze(ws, opts) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(resolve => rl.question(q, resolve));

  try {
    console.log(chalk.blue('\n  Connect to Truuze\n'));

    // --skill cannot be combined with --token or --key — they encode different
    // signup intents and silently picking one would hide the user's mistake.
    if (opts.skill && (opts.token || opts.key)) {
      console.error(chalk.red('\n  --skill cannot be used together with --token or --key. Pick one.\n'));
      rl.close();
      return;
    }

    // If --skill is provided, read and parse the file up front. This pulls the
    // provisioning token (and base URL) out of the SKILL.md frontmatter, then
    // falls through to the existing token-signup flow below.
    let token = opts.token;
    let skillBaseUrl = null;
    if (opts.skill && !token) {
      const skillPath = resolveUserPath(opts.skill);
      if (!fs.existsSync(skillPath)) {
        console.error(chalk.red(`\n  Skill file not found: ${skillPath}\n`));
        rl.close();
        return;
      }
      const skillContent = fs.readFileSync(skillPath, 'utf-8');
      const parsed = parseTruuzeSkill(skillContent);
      if (!parsed) {
        console.error(chalk.red('\n  Could not parse SKILL.md. Make sure it has valid YAML frontmatter with a metadata block.\n'));
        rl.close();
        return;
      }
      if (!parsed.provisioningToken || parsed.provisioningToken === 'N/A - already onboarded') {
        console.error(chalk.red('\n  This SKILL.md does not contain a valid provisioning token. It may have already been used. Use --key for an existing agent.\n'));
        rl.close();
        return;
      }
      token = parsed.provisioningToken;
      skillBaseUrl = parsed.apiBase;
      console.log(chalk.green(`  ✓ Parsed ${skillPath}`));
    }

    // Base URL — prefer flag, then skill frontmatter, then prompt with default.
    const defaultUrl = skillBaseUrl || 'https://origin.truuze.com/api/v1';
    const baseUrl = (opts.baseUrl || await ask(`  Base URL [${defaultUrl}]: `)).trim() || defaultUrl;

    // Platform API key (shared/public)
    const platformApiKey = '4a3b2c9d1e4f5a6b7c8d9e0f123456789abcdef0123456789abcdef01234567';

    let agentKey = opts.key;
    let agentId = null;
    let ownerUsername = null;
    let signupData = null;

    if (token) {
      // Sign up with provisioning token
      console.log(chalk.gray('  Signing up with provisioning token...'));

      const username = opts.username || await ask('  Agent username: ');
      const name = opts.name || await ask('  Agent name: ');
      const description = opts.description || await ask('  Description (what this agent does): ');

      const signupBody = {
        username: username.trim(),
        first_name: name.trim(),
        provisioning_token: token,
        agent_provider: 'aaas',
        agent_description: description.trim(),
        email: `${username.trim()}@agent.aaas.local`,
      };
      if (opts.jobTitle) signupBody.job_title = opts.jobTitle;

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
      signupData = data;
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
        console.log(chalk.yellow('\n  No key provided. To create a new agent, use:'));
        console.log(chalk.gray('    aaas connect truuze --token <provisioning_token>'));
        console.log(chalk.gray('    aaas connect truuze --skill <path/to/SKILL.md>\n'));
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

    // Save connection — mirror the full field set the dashboard saves so
    // `aaas status`, `connections`, and other commands see the same data.
    const src = signupData || {};
    const agentName = src.name
      || [src.first_name, src.last_name].filter(Boolean).join(' ').trim()
      || [profile.first_name, profile.last_name].filter(Boolean).join(' ').trim()
      || undefined;

    const connection = {
      platform: 'truuze',
      baseUrl,
      platformApiKey,
      agentKey,
      agentId: agentId || profile.id || profile.agent?.id || profile.agent,
      agentUsername: src.username || profile.username,
      agentName,
      agentProvider: src.agent_provider || profile.agent_provider,
      agentDescription: src.agent_description || profile.agent_description || profile.bio,
      agentPhoto: src.photo ?? profile.photo ?? null,
      avatarBgColor: src.avatar_bg_color || profile.avatar_bg_color,
      jobTitle: src.job_title || profile.job_title,
      ownerUsername: ownerUsername || profile.owner_username,
      heartbeatInterval: 30,
      connectedAt: new Date().toISOString(),
    };

    saveConnection(ws, 'truuze', connection);
    console.log(chalk.green(`\n  Saved to .aaas/connections/truuze.json`));

    // Render the Truuze platform skill from the connector-shipped template +
    // the owner's uploaded service SKILL.md. Non-blocking — falls back to
    // template defaults if no LLM provider is configured yet.
    try {
      let eng = null;
      try {
        const config = readJson(path.join(ws, '.aaas', 'config.json'));
        if (config?.provider) {
          eng = new AgentEngine({ workspace: ws, provider: config.provider, config });
          await eng.initialize();
        }
      } catch { /* no provider yet — extractor falls back */ }

      console.log(chalk.gray('  Rendering Truuze platform skill...'));
      await buildPlatformSkill({
        workspace: ws,
        engine: eng,
        connection: { baseUrl, ownerUsername: connection.ownerUsername },
      });
      console.log(chalk.green('  ✓ Skill written to skills/truuze/SKILL.md'));
    } catch (err) {
      console.log(chalk.yellow(`  Skill render failed: ${err.message}`));
      console.log(chalk.gray('  Fix the underlying issue (e.g., configure an LLM provider) and re-run: aaas connect truuze --force'));
    }

    console.log(chalk.gray(`\n  Run ${chalk.bold('aaas run')} to start the agent.\n`));

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

async function connectTelegram(ws, opts) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(resolve => rl.question(q, resolve));

  try {
    console.log(chalk.blue('\n  Connect to Telegram\n'));

    let botToken = opts.token;
    if (!botToken) {
      console.log(chalk.gray('  Get a bot token from @BotFather on Telegram.\n'));
      botToken = (await ask('  Bot token: ')).trim();
    }

    if (!botToken) {
      console.log(chalk.yellow('\n  No token provided.\n'));
      rl.close();
      return;
    }

    // Verify the token
    console.log(chalk.gray('  Verifying bot token...'));
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error(chalk.red(`\n  Invalid token: ${err.description || res.status}\n`));
      rl.close();
      return;
    }

    const data = await res.json();
    const bot = data.result;
    console.log(chalk.green(`  ✓ Verified bot: @${bot.username} (${bot.first_name})`));

    saveConnection(ws, 'telegram', {
      platform: 'telegram',
      botToken,
      botUsername: bot.username,
      botName: bot.first_name,
      connectedAt: new Date().toISOString(),
    });

    console.log(chalk.green('\n  Saved to .aaas/connections/telegram.json'));
    console.log(chalk.gray(`  Run ${chalk.bold('aaas run')} to start. Users can message @${bot.username} on Telegram.\n`));
    rl.close();
  } catch (err) {
    console.error(chalk.red(`\n  Error: ${err.message}\n`));
    rl.close();
  }
}

async function connectDiscord(ws, opts) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(resolve => rl.question(q, resolve));

  try {
    console.log(chalk.blue('\n  Connect to Discord\n'));

    let botToken = opts.token;
    if (!botToken) {
      console.log(chalk.gray('  Get a bot token from the Discord Developer Portal.\n'));
      botToken = (await ask('  Bot token: ')).trim();
    }

    if (!botToken) {
      console.log(chalk.yellow('\n  No token provided.\n'));
      rl.close();
      return;
    }

    // Verify the token
    console.log(chalk.gray('  Verifying bot token...'));
    const res = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${botToken}` },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error(chalk.red(`\n  Invalid token: ${err.message || res.status}\n`));
      rl.close();
      return;
    }

    const bot = await res.json();
    console.log(chalk.green(`  ✓ Verified bot: ${bot.username}#${bot.discriminator}`));

    saveConnection(ws, 'discord', {
      platform: 'discord',
      botToken,
      botUsername: bot.username,
      botId: bot.id,
      connectedAt: new Date().toISOString(),
    });

    console.log(chalk.green('\n  Saved to .aaas/connections/discord.json'));
    console.log(chalk.gray(`  Run ${chalk.bold('aaas run')} to start. The bot responds to DMs and @mentions.\n`));
    rl.close();
  } catch (err) {
    console.error(chalk.red(`\n  Error: ${err.message}\n`));
    rl.close();
  }
}

async function connectSlack(ws, opts) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(resolve => rl.question(q, resolve));

  try {
    console.log(chalk.blue('\n  Connect to Slack\n'));
    console.log(chalk.gray('  You need two tokens from your Slack app:\n'));
    console.log(chalk.gray('  1. Bot Token (xoxb-...) — OAuth & Permissions page'));
    console.log(chalk.gray('  2. App-Level Token (xapp-...) — Basic Information > App-Level Tokens\n'));

    let botToken = opts.botToken;
    let appToken = opts.appToken;

    if (!botToken) botToken = (await ask('  Bot token (xoxb-...): ')).trim();
    if (!appToken) appToken = (await ask('  App-level token (xapp-...): ')).trim();

    if (!botToken || !appToken) {
      console.log(chalk.yellow('\n  Both tokens are required.\n'));
      rl.close();
      return;
    }

    // Verify the bot token
    console.log(chalk.gray('  Verifying bot token...'));
    const res = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${botToken}` },
    });
    const data = await res.json();
    if (!data.ok) {
      console.error(chalk.red(`\n  Invalid bot token: ${data.error}\n`));
      rl.close();
      return;
    }

    console.log(chalk.green(`  ✓ Verified bot: ${data.user} (team: ${data.team})`));

    saveConnection(ws, 'slack', {
      platform: 'slack',
      botToken,
      appToken,
      botUserId: data.user_id,
      botName: data.user,
      teamId: data.team_id,
      connectedAt: new Date().toISOString(),
    });

    console.log(chalk.green('\n  Saved to .aaas/connections/slack.json'));
    console.log(chalk.gray('  Make sure Socket Mode is enabled in your Slack app settings.'));
    console.log(chalk.gray(`  Run ${chalk.bold('aaas run')} to start. The bot responds to DMs and @mentions.\n`));
    rl.close();
  } catch (err) {
    console.error(chalk.red(`\n  Error: ${err.message}\n`));
    rl.close();
  }
}

async function connectWhatsApp(ws, opts) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(resolve => rl.question(q, resolve));

  try {
    console.log(chalk.blue('\n  Connect to WhatsApp Business API\n'));
    console.log(chalk.gray('  You need a Meta Business account with WhatsApp API access.'));
    console.log(chalk.gray('  Get credentials from: https://developers.facebook.com\n'));

    let accessToken = opts.accessToken;
    let phoneNumberId = opts.phoneNumberId;
    let verifyToken = opts.verifyToken;
    const port = parseInt(opts.port) || 3301;

    if (!accessToken) accessToken = (await ask('  Access token: ')).trim();
    if (!phoneNumberId) phoneNumberId = (await ask('  Phone number ID: ')).trim();
    if (!verifyToken) {
      verifyToken = (await ask('  Webhook verify token (choose any secret string): ')).trim();
      if (!verifyToken) verifyToken = 'aaas_' + Math.random().toString(36).slice(2, 10);
    }

    if (!accessToken || !phoneNumberId) {
      console.log(chalk.yellow('\n  Access token and phone number ID are required.\n'));
      rl.close();
      return;
    }

    // Verify the access token
    console.log(chalk.gray('  Verifying credentials...'));
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${phoneNumberId}?fields=display_phone_number,verified_name`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error(chalk.red(`\n  Invalid credentials: ${err.error?.message || res.status}\n`));
      rl.close();
      return;
    }

    const data = await res.json();
    console.log(chalk.green(`  ✓ Verified: ${data.verified_name || data.display_phone_number}`));

    saveConnection(ws, 'whatsapp', {
      platform: 'whatsapp',
      accessToken,
      phoneNumberId,
      verifyToken,
      port,
      businessName: data.verified_name || data.display_phone_number,
      connectedAt: new Date().toISOString(),
    });

    console.log(chalk.green('\n  Saved to .aaas/connections/whatsapp.json'));
    console.log(chalk.gray(`\n  When running, the webhook will listen on port ${port}.`));
    console.log(chalk.gray('  Set your Meta webhook URL to:'));
    console.log(chalk.bold(`    https://<your-public-domain>:${port}/webhook\n`));
    console.log(chalk.gray('  Options for exposing the webhook:'));
    console.log(chalk.gray('  • Deploy on a VPS/cloud server with a public IP'));
    console.log(chalk.gray('  • Use a tunnel: ngrok http ' + port));
    console.log(chalk.gray('  • Use a reverse proxy (Nginx, Caddy) with HTTPS\n'));
    console.log(chalk.gray(`  Verify token for Meta dashboard: ${chalk.bold(verifyToken)}`));
    console.log(chalk.gray(`  Run ${chalk.bold('aaas run')} to start.\n`));
    rl.close();
  } catch (err) {
    console.error(chalk.red(`\n  Error: ${err.message}\n`));
    rl.close();
  }
}

async function connectRelay(ws, opts) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(resolve => rl.question(q, resolve));

  try {
    console.log(chalk.blue('\n  Connect to streetai.org relay\n'));
    console.log(chalk.gray('  The relay lets your agent receive WhatsApp messages and'));
    console.log(chalk.gray('  serve a chat widget — without needing a public server.\n'));

    const relayBase = opts.baseUrl || 'https://streetai.org';

    // Get agent name from skill or ask
    let agentName = opts.description;
    if (!agentName) {
      const { readText, getWorkspacePaths } = await import('../../utils/workspace.js');
      const paths = getWorkspacePaths(ws);
      const skill = readText(paths.skill);
      if (skill) {
        const nameMatch = skill.match(/^name:\s*(.+)/m);
        agentName = nameMatch?.[1]?.trim();
      }
    }
    if (!agentName) {
      agentName = (await ask('  Agent name: ')).trim();
    }

    if (!agentName) {
      console.log(chalk.yellow('\n  Agent name is required.\n'));
      rl.close();
      return;
    }

    // Register with the relay
    console.log(chalk.gray('  Registering with relay...'));
    const regRes = await fetch(`${relayBase}/relay/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: agentName }),
    });

    if (!regRes.ok) {
      const err = await regRes.json().catch(() => ({}));
      console.error(chalk.red(`\n  Registration failed: ${err.error || regRes.status}\n`));
      rl.close();
      return;
    }

    const { slug, relayKey, webhookUrl, chatUrl, widgetUrl } = await regRes.json();
    console.log(chalk.green(`  ✓ Registered as: ${slug}`));

    // Configure WhatsApp if it's already connected
    const waConn = loadConnection(ws, 'whatsapp');
    if (waConn?.verifyToken) {
      console.log(chalk.gray('  Configuring WhatsApp webhook...'));
      await fetch(`${relayBase}/relay/configure`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug,
          relayKey,
          whatsapp: { verifyToken: waConn.verifyToken },
        }),
      });
      console.log(chalk.green('  ✓ WhatsApp webhook configured'));
    }

    // Save relay connection
    const relayUrl = relayBase.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
    saveConnection(ws, 'relay', {
      platform: 'relay',
      relayUrl,
      relayKey,
      slug,
      connectedAt: new Date().toISOString(),
    });

    console.log(chalk.green('\n  Saved to .aaas/connections/relay.json\n'));

    // Show URLs
    console.log(chalk.bold('  Your agent URLs:\n'));
    console.log(chalk.gray('  Chat widget endpoint:'));
    console.log(`    ${chatUrl}\n`);
    console.log(chalk.gray('  Embeddable widget:'));
    console.log(`    <script src="${widgetUrl}" data-agent="${chatUrl}"></script>\n`);

    if (waConn) {
      console.log(chalk.gray('  WhatsApp webhook (set this in Meta dashboard):'));
      console.log(`    ${webhookUrl}`);
      console.log(chalk.gray(`    Verify token: ${waConn.verifyToken}\n`));
    } else {
      console.log(chalk.gray('  To add WhatsApp, run:'));
      console.log(chalk.gray('    aaas connect whatsapp   (then re-run: aaas connect relay --force)\n'));
    }

    console.log(chalk.gray(`  Run ${chalk.bold('aaas run')} to start. The relay handles all inbound traffic.\n`));
    rl.close();
  } catch (err) {
    console.error(chalk.red(`\n  Error: ${err.message}\n`));
    rl.close();
  }
}
