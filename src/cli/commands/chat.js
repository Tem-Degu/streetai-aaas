import path from 'path';
import fs from 'fs';
import chalk from 'chalk';
import readline from 'readline';
import { requireWorkspace, readJson } from '../../utils/workspace.js';
import { getProviderCredential } from '../../auth/credentials.js';
import { AgentEngine } from '../../engine/index.js';

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];

function formatBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

// Tokenize a line respecting simple shell-style quoting and backslash escapes.
function tokenize(line) {
  const tokens = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) { quote = null; continue; }
      if (c === '\\' && quote === '"' && i + 1 < line.length) { cur += line[++i]; continue; }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '\\' && i + 1 < line.length) { cur += line[++i]; continue; }
    if (c === ' ' || c === '\t') {
      if (cur) { tokens.push(cur); cur = ''; }
      continue;
    }
    cur += c;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

// Turn a token like `/c/Users/...`, `C:\Users\...`, `file:///...` into a real absolute path,
// or return null if it's not an absolute path that exists on disk.
function resolveAttachmentToken(tok) {
  let t = tok;
  // strip file:// URI
  if (t.startsWith('file://')) {
    t = decodeURIComponent(t.slice(7));
    if (/^\/[a-zA-Z]:/.test(t)) t = t.slice(1); // file:///C:/... → C:/...
  }
  // strip trailing sentence punctuation
  t = t.replace(/[.,;:!?)]+$/, '');

  // Git Bash style /c/Users/... → C:/Users/...
  const gitBash = t.match(/^\/([a-zA-Z])\/(.*)$/);
  if (gitBash && process.platform === 'win32') {
    t = `${gitBash[1].toUpperCase()}:/${gitBash[2]}`;
  }

  const isAbs =
    path.isAbsolute(t) ||
    /^[a-zA-Z]:[\\/]/.test(t); // Windows drive letter

  if (!isAbs) return null;

  try {
    const stat = fs.statSync(t);
    if (!stat.isFile()) return null;
    return { path: t, name: path.basename(t), size: stat.size };
  } catch {
    return null;
  }
}

// Scan a line for dragged-in file paths. Returns { cleaned, attachments }.
function extractFilePaths(line) {
  const tokens = tokenize(line);
  const attachments = [];
  const keptTokens = [];
  for (const tok of tokens) {
    const att = resolveAttachmentToken(tok);
    if (att) attachments.push(att);
    else keptTokens.push(tok);
  }
  return { cleaned: keptTokens.join(' ').trim(), attachments };
}

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

  // Replay recent session history
  const sessionFile = path.join(ws, '.aaas', 'sessions', 'local_owner.json');
  try {
    if (fs.existsSync(sessionFile)) {
      const session = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
      const msgs = session.messages || [];
      const recent = msgs.slice(-10);
      if (recent.length > 0) {
        console.log(chalk.gray(`  ── recent history (${recent.length} messages) ──`));
        for (const m of recent) {
          if (m.role === 'user') {
            const text = m.content.length > 120 ? m.content.slice(0, 117) + '...' : m.content;
            console.log(chalk.gray(`  You: `) + chalk.gray(text));
          } else {
            const text = m.content.length > 120 ? m.content.slice(0, 117) + '...' : m.content;
            console.log(chalk.gray(`  ${agentName}: `) + chalk.gray(text));
          }
        }
        console.log(chalk.gray('  ── end history ──\n'));
      }
    }
  } catch { /* ignore malformed session */ }

  console.log(chalk.gray('  Type your message and press Enter. Drag files into the terminal to attach. Type /quit to exit.\n'));

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

    // Detect drag-and-dropped file paths in the message.
    const { cleaned, attachments } = extractFilePaths(msg);
    let fullMessage = cleaned;

    if (attachments.length > 0) {
      for (const a of attachments) {
        console.log(chalk.gray(`  [attached: ${a.name} (${formatBytes(a.size)})]`));
      }
      const lines = attachments.map(a => `- ${a.name} (${formatBytes(a.size)}) → path: ${a.path}`);
      const block = `\n\n[Attached files — use workspace tools to move/copy these to your data/ directory if needed]\n${lines.join('\n')}`;
      fullMessage = (cleaned || '(file attached)') + block;
    }

    try {
      process.stdout.write(chalk.gray('  Thinking...'));

      const result = await engine.processChat(fullMessage);

      // Clear "Thinking..." line
      process.stdout.write('\r' + ' '.repeat(40) + '\r');

      // Show response
      console.log(chalk.cyan(`  ${agentName}: `) + result.response);

      // Show tools used if any
      if (result.toolsUsed.length > 0) {
        const names = result.toolsUsed.map(t => typeof t === 'string' ? t : t.name);
        console.log(chalk.gray(`  [tools: ${names.join(', ')} | tokens: ${result.tokensUsed}]`));
      }

      console.log('');
    } catch (err) {
      process.stdout.write('\r' + ' '.repeat(40) + '\r');
      console.error(chalk.red(`  Error: ${err.message}\n`));
    }

    rl.prompt();
  });
}
