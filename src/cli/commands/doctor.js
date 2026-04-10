import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { findWorkspace, getWorkspacePaths, readJson, readText, listFiles } from '../../utils/workspace.js';
import { getProviderCredential, listProviders, maskApiKey } from '../../auth/credentials.js';
import { listConnections } from '../../auth/connections.js';

const MIN_NODE = 18;
const REQUIRED_DIRS = [
  'skills/aaas', 'data', 'transactions/active', 'transactions/archive',
  'extensions', 'deliveries', 'memory', '.aaas/connections', '.aaas/sessions',
];
const REQUIRED_SKILL_SECTIONS = [
  'Your Identity', 'Service Catalog', 'Domain Knowledge',
  'Boundaries', 'How You Work',
];

const PROVIDER_TEST_URLS = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
  google: 'https://generativelanguage.googleapis.com',
  openrouter: 'https://openrouter.ai/api',
  ollama: 'http://localhost:11434',
};

function pass(msg) { console.log(chalk.green('  ✓ ') + msg); }
function fail(msg) { console.log(chalk.red('  ✗ ') + msg); }
function warn(msg) { console.log(chalk.yellow('  ⚠ ') + msg); }
function info(msg) { console.log(chalk.gray('    ' + msg)); }

export async function doctorCommand() {
  console.log(chalk.blue('\n  AaaS Doctor\n'));
  let issues = 0;
  let warnings = 0;

  // ─── 1. Node version ────────────────────────
  const nodeVer = parseInt(process.versions.node);
  if (nodeVer >= MIN_NODE) {
    pass(`Node.js ${process.versions.node} (>= ${MIN_NODE} required)`);
  } else {
    fail(`Node.js ${process.versions.node} — version ${MIN_NODE}+ required`);
    issues++;
  }

  // ─── 2. Package version ─────────────────────
  try {
    const pkgPath = path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'), 'package.json');
    const pkg = readJson(pkgPath);
    if (pkg?.version) {
      pass(`@streetai/aaas v${pkg.version}`);
    }
  } catch { /* ignore */ }

  // ─── 3. Workspace ──────────────────────────
  const ws = findWorkspace();
  if (!ws) {
    warn('Not inside an AaaS workspace');
    info('Run "aaas init <name>" to create one, or cd into an existing workspace.');
    warnings++;
    console.log('');
    printSummary(issues, warnings);
    return;
  }
  pass(`Workspace: ${ws}`);

  const paths = getWorkspacePaths(ws);

  // ─── 4. Directory structure ─────────────────
  let missingDirs = 0;
  for (const dir of REQUIRED_DIRS) {
    const full = path.join(ws, dir);
    if (!fs.existsSync(full)) {
      fail(`Missing directory: ${dir}`);
      missingDirs++;
      issues++;
    }
  }
  if (missingDirs === 0) {
    pass('Directory structure complete');
  }

  // ─── 5. SKILL.md ───────────────────────────
  const skill = readText(paths.skill);
  if (!skill) {
    fail('skills/aaas/SKILL.md not found');
    issues++;
  } else {
    const wordCount = skill.split(/\s+/).filter(w => w.length > 0).length;
    if (wordCount < 50) {
      warn(`SKILL.md is very short (${wordCount} words) — may need more detail`);
      warnings++;
    } else {
      pass(`SKILL.md (${wordCount} words)`);
    }

    // Check frontmatter
    if (!skill.startsWith('---')) {
      warn('SKILL.md missing frontmatter (---) header');
      warnings++;
    }

    // Check required sections
    const lower = skill.toLowerCase();
    const missingSections = REQUIRED_SKILL_SECTIONS.filter(
      s => !lower.includes(s.toLowerCase())
    );
    if (missingSections.length > 0) {
      warn(`SKILL.md missing sections: ${missingSections.join(', ')}`);
      warnings++;
    }
  }

  // ─── 6. SOUL.md ────────────────────────────
  if (fs.existsSync(paths.soul)) {
    const soul = readText(paths.soul);
    const words = soul ? soul.split(/\s+/).filter(w => w.length > 0).length : 0;
    if (words < 20) {
      warn(`SOUL.md is very short (${words} words)`);
      warnings++;
    } else {
      pass(`SOUL.md (${words} words)`);
    }
  } else {
    warn('SOUL.md not found — agent has no personality definition');
    warnings++;
  }

  // ─── 7. Config ─────────────────────────────
  const config = readJson(paths.config);
  if (!config) {
    fail('No .aaas/config.json — run "aaas config"');
    issues++;
  } else {
    if (!config.provider) {
      fail('No LLM provider configured — run "aaas config"');
      issues++;
    } else if (!config.model) {
      warn(`Provider "${config.provider}" set but no model specified`);
      warnings++;
    } else {
      pass(`LLM: ${config.provider}/${config.model}`);
    }
    if (config.agentType) {
      pass(`Agent type: ${config.agentType}`);
    }
  }

  // ─── 8. Credentials ───────────────────────
  const provider = config?.provider;
  if (provider) {
    const cred = getProviderCredential(provider);
    if (!cred && provider !== 'ollama') {
      fail(`No credentials for "${provider}" — run "aaas config" or "aaas oauth ${provider}"`);
      issues++;
    } else if (cred) {
      const source = cred.source === 'env' ? 'environment variable' : 'credentials file';
      const preview = cred.apiKey ? maskApiKey(cred.apiKey) : '(none)';
      pass(`Credentials: ${provider} via ${source} (${preview})`);

      if (cred.type === 'oauth' && cred.expiresAt) {
        const expires = new Date(cred.expiresAt);
        if (expires < new Date()) {
          warn('OAuth token has expired — run "aaas oauth ' + provider + '" to refresh');
          warnings++;
        } else {
          const hoursLeft = Math.round((expires - new Date()) / (1000 * 60 * 60));
          if (hoursLeft < 1) {
            warn(`OAuth token expires in < 1 hour`);
            warnings++;
          } else {
            pass(`OAuth token valid (${hoursLeft}h remaining)`);
          }
        }
      }
    }
  }

  // ─── 9. Provider reachability ──────────────
  if (provider && PROVIDER_TEST_URLS[provider]) {
    const url = PROVIDER_TEST_URLS[provider];
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(url, { method: 'HEAD', signal: controller.signal });
      clearTimeout(timeout);
      pass(`${provider} API reachable (HTTP ${res.status})`);
    } catch (err) {
      if (err.name === 'AbortError') {
        warn(`${provider} API unreachable (timeout 5s)`);
      } else {
        warn(`${provider} API unreachable: ${err.message}`);
      }
      warnings++;
    }
  }

  // ─── 10. Connections ──────────────────────
  const connections = listConnections(ws);
  if (connections.length === 0) {
    warn('No platform connections — run "aaas connect <platform>"');
    warnings++;
  } else {
    for (const { platform, config: conn } of connections) {
      const details = [];
      if (conn.agentUsername) details.push(`@${conn.agentUsername}`);
      if (conn.baseUrl) details.push(conn.baseUrl);
      if (conn.port) details.push(`port ${conn.port}`);
      pass(`Connection: ${platform}` + (details.length ? chalk.gray(` (${details.join(', ')})`) : ''));

      // Check if connection config has required fields
      if (platform === 'truuze' && !conn.agentKey) {
        warn(`  truuze connection missing agentKey`);
        warnings++;
      }
    }
  }

  // ─── 11. Running agent ────────────────────
  const pidFile = path.join(ws, '.aaas', 'agent.pid');
  if (fs.existsSync(pidFile)) {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim());
    try {
      process.kill(pid, 0);
      pass(`Agent running (PID ${pid})`);
    } catch {
      warn(`Stale PID file (process ${pid} not found) — run "aaas stop" to clean up`);
      warnings++;
    }
  } else {
    info('Agent not running');
  }

  // ─── 12. Data files ───────────────────────
  const dataFiles = listFiles(paths.data).filter(f => f !== '.gitkeep');
  if (dataFiles.length > 0) {
    pass(`Data: ${dataFiles.length} file(s)`);
  } else {
    info('No data files (data/ is empty)');
  }

  // ─── 13. Memory ───────────────────────────
  const factsPath = path.join(paths.memory, 'facts.json');
  if (fs.existsSync(factsPath)) {
    const facts = readJson(factsPath);
    if (facts) {
      const count = Array.isArray(facts) ? facts.length : Object.keys(facts).length;
      pass(`Memory: ${count} entries in facts.json`);
    } else {
      warn('facts.json exists but is not valid JSON');
      warnings++;
    }
  } else {
    info('No memory (memory/facts.json not found)');
  }

  // ─── 14. Extensions ──────────────────────
  const registry = readJson(paths.extensions);
  const extensions = registry?.extensions || (Array.isArray(registry) ? registry : []);
  if (extensions.length > 0) {
    pass(`Extensions: ${extensions.length} registered`);
  } else {
    info('No extensions registered');
  }

  // ─── 15. Transactions ────────────────────
  const activeTxn = listFiles(paths.activeTransactions, '.json').length;
  const archivedTxn = listFiles(paths.archivedTransactions, '.json').length;
  if (activeTxn > 0 || archivedTxn > 0) {
    pass(`Transactions: ${activeTxn} active, ${archivedTxn} archived`);
  } else {
    info('No transactions');
  }

  console.log('');
  printSummary(issues, warnings);
}

function printSummary(issues, warnings) {
  if (issues === 0 && warnings === 0) {
    console.log(chalk.green('  Everything looks good.\n'));
  } else if (issues === 0) {
    console.log(chalk.yellow(`  ${warnings} warning(s), no critical issues.\n`));
  } else {
    console.log(chalk.red(`  ${issues} issue(s)`) + (warnings > 0 ? chalk.yellow(`, ${warnings} warning(s)`) : '') + '\n');
  }
}
