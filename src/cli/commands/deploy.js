import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import os from 'os';
import { requireWorkspace, getWorkspacePaths, readJson, writeJson, readText } from '../../utils/workspace.js';

const DEPLOY_CONFIG = '.aaas/deploy.json';

function getDeployConfig(ws) {
  return readJson(path.join(ws, DEPLOY_CONFIG));
}

function saveDeployConfig(ws, config) {
  writeJson(path.join(ws, DEPLOY_CONFIG), config);
}

function getOpenClawDir() {
  return path.join(os.homedir(), '.openclaw');
}

function deriveAgentId(ws) {
  const paths = getWorkspacePaths(ws);
  const skill = readText(paths.skill) || '';
  const match = skill.match(/^#\s+(.+?)(?:\s*—|\s*-|\n)/m);
  if (match) {
    return match[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
  }
  return path.basename(ws).toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      count += copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
      count++;
    }
  }
  return count;
}

export function deployCommand(opts) {
  const ws = requireWorkspace();
  const paths = getWorkspacePaths(ws);

  if (opts.status) {
    return deployStatus(ws);
  }

  const openclawDir = getOpenClawDir();
  if (!fs.existsSync(openclawDir)) {
    console.error(chalk.red('\n  OpenClaw not found at ~/.openclaw'));
    console.log(chalk.gray('  Install OpenClaw first: https://docs.openclaw.ai\n'));
    return;
  }

  // Get or create deploy config
  let config = getDeployConfig(ws);
  const isFirstDeploy = !config;

  if (isFirstDeploy) {
    const agentId = opts.id || deriveAgentId(ws);
    const workspacePath = path.join(openclawDir, `workspace-${agentId}`);

    config = {
      agentId,
      openclawPath: workspacePath,
      lastDeployed: null,
      bindings: []
    };

    console.log(chalk.blue(`\n  First deploy — agent ID: ${chalk.bold(agentId)}`));
    console.log(chalk.gray(`  Target: ${workspacePath}\n`));
  } else {
    console.log(chalk.blue(`\n  Syncing ${chalk.bold(config.agentId)} to OpenClaw\n`));
  }

  const target = config.openclawPath;
  fs.mkdirSync(target, { recursive: true });

  // Copy workspace files
  let totalFiles = 0;

  // Skills
  const skillDest = path.join(target, 'skills', 'aaas');
  fs.mkdirSync(skillDest, { recursive: true });
  fs.copyFileSync(paths.skill, path.join(skillDest, 'SKILL.md'));
  totalFiles++;
  console.log(chalk.gray('  Copied skills/aaas/SKILL.md'));

  // SOUL.md
  if (fs.existsSync(paths.soul)) {
    fs.copyFileSync(paths.soul, path.join(target, 'SOUL.md'));
    totalFiles++;
    console.log(chalk.gray('  Copied SOUL.md'));
  }

  // Data, extensions, memory, deliveries
  for (const dir of ['data', 'extensions', 'deliveries', 'memory']) {
    const src = path.join(ws, dir);
    if (fs.existsSync(src)) {
      const n = copyDir(src, path.join(target, dir));
      totalFiles += n;
      if (n > 0) console.log(chalk.gray(`  Copied ${dir}/ (${n} files)`));
    }
  }

  // Transaction dirs
  for (const sub of ['active', 'archive']) {
    const src = path.join(ws, 'transactions', sub);
    if (fs.existsSync(src)) {
      const n = copyDir(src, path.join(target, 'transactions', sub));
      totalFiles += n;
      if (n > 0) console.log(chalk.gray(`  Copied transactions/${sub}/ (${n} files)`));
    }
  }

  // Register agent in openclaw.json if first deploy
  if (isFirstDeploy) {
    const ocConfig = path.join(openclawDir, 'openclaw.json');
    let ocData = readJson(ocConfig) || { agents: { list: [] } };
    if (!ocData.agents) ocData.agents = { list: [] };
    if (!ocData.agents.list) ocData.agents.list = [];

    const existing = ocData.agents.list.find(a => a.id === config.agentId);
    if (!existing) {
      ocData.agents.list.push({
        id: config.agentId,
        bindings: []
      });
      writeJson(ocConfig, ocData);
      console.log(chalk.gray(`  Registered in openclaw.json`));
    }
  }

  // Save deploy config
  config.lastDeployed = new Date().toISOString();
  saveDeployConfig(ws, config);

  console.log(chalk.green(`\n  Deployed ${totalFiles} files to ${config.openclawPath}`));

  if (isFirstDeploy) {
    console.log(chalk.yellow('\n  Next steps:'));
    console.log(chalk.gray('  1. Add a channel binding in ~/.openclaw/openclaw.json'));
    console.log(chalk.gray('  2. Start OpenClaw to bring your agent online'));
    console.log(chalk.gray('  3. Run: aaas chat to talk to your agent\n'));
  } else {
    console.log(chalk.gray(`  Last deployed: ${config.lastDeployed}\n`));
  }
}

function deployStatus(ws) {
  const config = getDeployConfig(ws);

  if (!config) {
    console.log(chalk.yellow('\n  Not deployed yet. Run: aaas deploy\n'));
    return;
  }

  console.log(chalk.blue('\n  Deploy Status\n'));
  console.log(`  Agent ID:      ${chalk.bold(config.agentId)}`);
  console.log(`  Target:        ${chalk.gray(config.openclawPath)}`);
  console.log(`  Last deployed: ${chalk.gray(config.lastDeployed || 'never')}`);

  const exists = fs.existsSync(config.openclawPath);
  console.log(`  Status:        ${exists ? chalk.green('deployed') : chalk.red('target missing')}`);

  if (config.bindings && config.bindings.length > 0) {
    console.log(`  Bindings:      ${config.bindings.map(b => b.channel).join(', ')}`);
  } else {
    console.log(`  Bindings:      ${chalk.gray('none — add in ~/.openclaw/openclaw.json')}`);
  }
  console.log('');
}
