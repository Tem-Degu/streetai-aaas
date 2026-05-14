import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { requireWorkspace, findWorkspace, formatBytes } from '../../utils/workspace.js';
import { getValidWorkspaces } from '../../utils/registry.js';
import { exportWorkspace } from '../../export/index.js';

/**
 * aaas export [agent-name] [--no-secrets] [--output <path>]
 *
 * Bundles a workspace into a single .tar.gz that can be moved to another
 * machine. Accepts an optional `agent-name` so you don't have to `cd` into
 * the workspace first — the lookup uses the same registry the dashboard
 * uses (matches by display name or folder name). With no name, falls back
 * to the workspace at the current directory.
 *
 * Default output name is `aaas-<workspace-slug>-<yyyymmdd>.tar.gz` written
 * to the current working directory.
 *
 * --no-secrets strips LLM keys, platform connection tokens, SMTP password,
 *   payment ledger, sessions, and literal extension API keys, and writes a
 *   manifest listing what the recipient must reconnect. Suitable for sharing.
 * Default (without --no-secrets) bundles everything as-is. Suitable for
 *   moving your own agent to your own other machine.
 */
export async function exportCommand(agentName, options = {}) {
  // commander invokes (arg, opts) when an argument is declared; if the
  // arg was omitted, `agentName` is undefined and `options` is the opts.
  // Guard against the rare shape where commander hands us just opts.
  if (agentName && typeof agentName === 'object' && !options) {
    options = agentName; agentName = undefined;
  }

  const ws = resolveWorkspace(agentName);
  // Commander treats `--no-secrets` as auto-negation of an implicit
  // `--secrets` option (default true), so the flag arrives as
  // options.secrets === false, NOT options.noSecrets.
  const noSecrets = options.secrets === false;
  const outputPath = options.output
    ? path.resolve(options.output)
    : undefined;

  console.log('');
  console.log(chalk.bold(`Exporting workspace`) + chalk.gray(` (${path.basename(ws)})`));
  console.log(chalk.gray(noSecrets
    ? 'Mode: --no-secrets (sanitized for sharing)'
    : 'Mode: full (includes credentials and connection tokens)'));
  console.log('');

  let result;
  try {
    result = await exportWorkspace(ws, { noSecrets, outputPath });
  } catch (err) {
    console.error(chalk.red(`✗ Export failed: ${err.message}`));
    process.exit(1);
  }

  const { outputPath: out, manifest, sizeBytes } = result;
  console.log(chalk.green('✓ Bundle written'));
  console.log(`  ${out}`);
  console.log(chalk.gray(`  ${formatBytes(sizeBytes)} · bundle_version ${manifest.bundle_version}`));

  if (noSecrets && manifest.requires?.length > 0) {
    console.log('');
    console.log(chalk.bold('Recipient will need to reattach:'));
    for (const req of manifest.requires) {
      console.log('  ' + chalk.yellow('•') + ' ' + describeRequirement(req));
    }
  } else if (!noSecrets) {
    console.log('');
    console.log(chalk.yellow('⚠  This bundle contains live credentials.'));
    console.log(chalk.gray('   Share only with yourself — or re-export with --no-secrets.'));
  }
  console.log('');
}

/**
 * Resolve a workspace by name (preferred) or fall back to the workspace
 * the CWD lives inside. Mirrors `dashboardCommand`'s lookup so the two
 * commands behave consistently.
 *
 * Failure modes get explicit messages:
 *  - Name passed but not found → list registered agents.
 *  - No name and CWD isn't inside a workspace → tell the user the two
 *    options (named export, or cd) and list what's available.
 */
function resolveWorkspace(agentName) {
  const workspaces = getValidWorkspaces();

  if (agentName) {
    const match = workspaces.find(w =>
      path.basename(w.path) === agentName ||
      w.name?.toLowerCase() === agentName.toLowerCase(),
    );
    if (match) return match.path;
    console.error(chalk.red(`\n  Error: Agent "${agentName}" not found in registry.\n`));
    if (workspaces.length > 0) {
      console.log(chalk.gray('  Registered agents:'));
      for (const w of workspaces) {
        console.log(chalk.gray(`    - ${w.name} (${path.basename(w.path)})`));
      }
    } else {
      console.log(chalk.gray('  No agents registered yet. Run this command from inside a workspace, or `aaas init` to create one.'));
    }
    console.log('');
    process.exit(1);
  }

  const ws = findWorkspace();
  if (ws) return ws;

  console.error(chalk.red(`\n  Error: No workspace found in the current directory.\n`));
  if (workspaces.length > 0) {
    console.log(chalk.gray('  Either pass an agent name:'));
    for (const w of workspaces) {
      console.log(chalk.gray(`    aaas export ${path.basename(w.path)}`));
    }
    console.log(chalk.gray('  Or cd into a workspace folder first.'));
  } else {
    console.log(chalk.gray('  No agents registered yet — run `aaas init` to create one.'));
  }
  console.log('');
  process.exit(1);
}

function describeRequirement(req) {
  switch (req.kind) {
    case 'llm': return `LLM API key for provider: ${chalk.cyan(req.provider)}`;
    case 'connection': return `Connection: ${chalk.cyan(req.platform)} (reconnect from the Deploy tab)`;
    case 'notifications_smtp': return `SMTP password (Notifications tab → Email)`;
    case 'extension_api_key': return `Extension API key: ${chalk.cyan(req.name)}`;
    default: return JSON.stringify(req);
  }
}

/**
 * Resolve an output filename when the user passed a directory rather than a
 * full path. Not currently used by the CLI but exported for future shapes.
 */
export function resolveOutputPath(maybePath, defaultName) {
  if (!maybePath) return defaultName;
  try {
    const stat = fs.statSync(maybePath);
    if (stat.isDirectory()) return path.join(maybePath, defaultName);
  } catch { /* nonexistent path is fine, treat as filename */ }
  return maybePath;
}
