import fs from 'fs';
import path from 'path';
import readline from 'readline';
import chalk from 'chalk';
import { readManifest, importWorkspace, slugify } from '../../export/index.js';
import { setProviderCredential } from '../../auth/credentials.js';
import { getWorkspacePaths, formatBytes } from '../../utils/workspace.js';
import { registerWorkspace } from '../../utils/registry.js';

/**
 * aaas import <archive> [target-dir] [--force]
 *
 * Restores a workspace from a bundle. Default target dir is derived from
 * the manifest's workspace_name (slugified) inside the current directory.
 *
 * After extracting, scans the manifest's `requires` and:
 *   - Prompts inline for LLM API keys (quick paste-in-terminal flow)
 *   - Tells the user to open the dashboard for connection / SMTP / extension
 *     secrets — those are easier to manage there.
 */
export async function importCommand(archive, targetDirArg, options = {}) {
  const archiveAbs = path.resolve(archive);
  if (!fs.existsSync(archiveAbs)) {
    console.error(chalk.red(`✗ Archive not found: ${archiveAbs}`));
    process.exit(1);
  }

  let manifest;
  try { manifest = await readManifest(archiveAbs); }
  catch (err) {
    console.error(chalk.red(`✗ ${err.message}`));
    process.exit(1);
  }

  const target = path.resolve(targetDirArg || slugify(manifest.workspace_name));

  console.log('');
  console.log(chalk.bold('Importing workspace'));
  console.log(`  Source:    ${archiveAbs}  ${chalk.gray(`(${formatBytes(fs.statSync(archiveAbs).size)})`)}`);
  console.log(`  Target:    ${target}`);
  console.log(`  Bundle:    workspace ${chalk.cyan(manifest.workspace_name)} · aaas ${manifest.aaas_version} · created ${manifest.created_at}`);
  console.log(`  Mode:      ${manifest.has_secrets ? chalk.yellow('full (includes secrets)') : chalk.green('no-secrets (will need reconnection)')}`);
  console.log('');

  let extractResult;
  try {
    extractResult = await importWorkspace(archiveAbs, target, { force: !!options.force });
  } catch (err) {
    console.error(chalk.red(`✗ ${err.message}`));
    process.exit(1);
  }

  console.log(chalk.green(`✓ Workspace restored at ${extractResult.targetDir}`));

  // Register in the global workspace registry so the dashboard's hub view
  // and the name-based lookups (aaas export <name>, aaas dashboard <name>)
  // can find it without the user having to cd in first.
  try {
    registerWorkspace(extractResult.targetDir, manifest.workspace_name);
    console.log(chalk.gray(`  Registered as "${manifest.workspace_name}".`));
  } catch (err) {
    console.log(chalk.yellow(`  ⚠ Could not register in workspace list: ${err.message}`));
    console.log(chalk.gray('    The workspace still works — you may need to cd into it to run commands.'));
  }

  // If the bundle is sanitized, walk the requirements and help the user.
  const reqs = manifest.requires || [];
  if (manifest.has_secrets || reqs.length === 0) {
    console.log('');
    console.log(chalk.gray('Next:'));
    console.log(`  cd ${path.relative(process.cwd(), extractResult.targetDir) || '.'}`);
    console.log(`  aaas run    ${chalk.gray('# or `aaas dashboard` to manage in the browser')}`);
    console.log('');
    return;
  }

  console.log('');
  console.log(chalk.bold(`This bundle needs ${reqs.length} thing${reqs.length === 1 ? '' : 's'} reattached before the agent can run.`));
  console.log('');

  const paths = getWorkspacePaths(extractResult.targetDir);
  const remaining = [];

  for (const req of reqs) {
    if (req.kind === 'llm') {
      console.log(chalk.bold(`  LLM credential — ${chalk.cyan(req.provider)}`));
      const key = await promptHidden(`    Paste API key (or press Enter to skip): `);
      if (key && key.trim()) {
        try {
          setProviderCredential(paths, req.provider, { apiKey: key.trim() });
          console.log(chalk.green(`    ✓ Saved.`));
        } catch (err) {
          console.log(chalk.red(`    ✗ Could not save: ${err.message}`));
          remaining.push(req);
        }
      } else {
        console.log(chalk.gray(`    Skipped.`));
        remaining.push(req);
      }
      console.log('');
    } else {
      remaining.push(req);
    }
  }

  if (remaining.length > 0) {
    console.log(chalk.bold('Open the dashboard to set up the rest:'));
    console.log(chalk.gray(`  cd ${path.relative(process.cwd(), extractResult.targetDir) || '.'} && aaas dashboard`));
    console.log('');
    for (const req of remaining) {
      console.log('  ' + chalk.yellow('•') + ' ' + describeRequirement(req));
    }
    console.log('');
  } else {
    console.log(chalk.green('All secrets are in place. Run:'));
    console.log(`  cd ${path.relative(process.cwd(), extractResult.targetDir) || '.'} && aaas run`);
    console.log('');
  }
}

function describeRequirement(req) {
  switch (req.kind) {
    case 'llm': return `LLM API key — ${chalk.cyan(req.provider)} (run \`aaas config\` or set in Settings)`;
    case 'connection': return `Connection — ${chalk.cyan(req.platform)} (Deploy tab → reconnect)`;
    case 'notifications_smtp': return `SMTP password (Notifications tab → Email)`;
    case 'extension_api_key': return `Extension API key — ${chalk.cyan(req.name)} (Extensions tab)`;
    default: return JSON.stringify(req);
  }
}

/**
 * Read a single line from stdin without echoing — used for pasting API
 * keys so they don't show in the user's terminal history.
 */
function promptHidden(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const stdout = process.stdout;
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
    // Mute the typed input by intercepting writes on the output stream while
    // the prompt is active. We use a flag so the prompt itself still prints.
    const origWrite = stdout.write.bind(stdout);
    let prompted = false;
    stdout.write = (chunk, ...rest) => {
      if (!prompted) { prompted = true; return origWrite(chunk, ...rest); }
      // Suppress echoes of typed characters; preserve final newline.
      if (typeof chunk === 'string' && chunk === '\n') return origWrite(chunk, ...rest);
      return true;
    };
    rl.on('close', () => { stdout.write = origWrite; });
  });
}
