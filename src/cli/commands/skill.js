import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import chalk from 'chalk';
import { requireWorkspace, getWorkspacePaths, readText, fileStats, formatBytes, getPlatformSkillPath } from '../../utils/workspace.js';

const REQUIRED_SECTIONS = [
  { name: 'Identity', patterns: ['your identity', '## identity'] },
  { name: 'Service Catalog', patterns: ['service catalog', 'service tiers'] },
  { name: 'Domain Knowledge', patterns: ['domain knowledge'] },
  { name: 'Pricing', patterns: ['pricing rules', 'pricing boundaries'] },
  { name: 'Boundaries', patterns: ['boundaries', 'service boundaries'] },
  { name: 'SLAs', patterns: ['sla', 'service level'] },
  { name: 'AaaS Protocol', patterns: ['aaas protocol', 'how you work', 'phase 1: explore', 'step 1: explore'] }
];

function pickEditor() {
  return process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');
}

export function skillEditCommand(platform) {
  const ws = requireWorkspace();
  const file = platform ? getPlatformSkillPath(ws, platform) : getWorkspacePaths(ws).skill;
  if (!fs.existsSync(file)) {
    console.error(chalk.red(`\n  Skill not found: ${file}\n  Use "aaas skill new ${platform || '<platform>'}" to create one.\n`));
    return;
  }
  const editor = pickEditor();
  const result = spawnSync(editor, [file], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) console.error(chalk.red(`\n  Failed to open editor (${editor}): ${result.error.message}\n`));
}

export function skillNewCommand(platform) {
  const ws = requireWorkspace();
  const plat = platform || 'aaas';
  const dir = path.join(ws, 'skills', plat);
  const file = path.join(dir, 'SKILL.md');
  if (fs.existsSync(file)) {
    console.error(chalk.red(`\n  Skill already exists: ${file}\n  Use "aaas skill edit${plat !== 'aaas' ? ' ' + plat : ''}" to edit it.\n`));
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  const template = `---
name: ${plat}
description: Skill for ${plat}
---

# ${plat} Skill

[Describe what this skill does]
`;
  fs.writeFileSync(file, template);
  console.log(chalk.green(`\n  Created ${path.relative(ws, file)}\n`));
  const editor = pickEditor();
  spawnSync(editor, [file], { stdio: 'inherit', shell: process.platform === 'win32' });
}

export function skillCommand(opts) {
  const ws = requireWorkspace();
  const paths = getWorkspacePaths(ws);
  const skill = readText(paths.skill);

  if (!skill) {
    console.error(chalk.red('Error: SKILL.md not found.'));
    process.exit(1);
  }

  const stat = fileStats(paths.skill);

  // Extract name
  const nameMatch = skill.match(/^#\s+(.+?)(?:\s*—|\s*-|\n)/m);
  const agentName = nameMatch ? nameMatch[1].trim() : 'Unknown';

  // Count services
  const serviceMatches = skill.match(/###\s+Service\s+\d+/gi) || [];
  // Also count named services like "### 1. Quick Match"
  const namedServices = skill.match(/###\s+\d+\.\s+/g) || [];
  const serviceCount = Math.max(serviceMatches.length, namedServices.length);

  // Word count
  const wordCount = skill.split(/\s+/).filter(w => w.length > 0).length;

  console.log(`\n${chalk.bold(agentName)}`);
  console.log(chalk.gray(`${paths.skill}`));
  console.log(`\n  Size: ${formatBytes(stat.size)} (${wordCount} words)`);
  console.log(`  Services defined: ${serviceCount}`);
  console.log(`  Last modified: ${stat.modified.toLocaleDateString()}`);
  console.log('');

  if (opts.validate) {
    console.log(chalk.blue('Validation:\n'));
    const lower = skill.toLowerCase();
    let allPass = true;

    for (const section of REQUIRED_SECTIONS) {
      const found = section.patterns.some(p => lower.includes(p));
      if (found) {
        console.log(chalk.green(`  ✓ ${section.name}`));
      } else {
        console.log(chalk.red(`  ✗ ${section.name} — missing`));
        allPass = false;
      }
    }

    // Check frontmatter
    if (skill.startsWith('---')) {
      const fmEnd = skill.indexOf('---', 3);
      if (fmEnd > 0) {
        const fm = skill.slice(3, fmEnd);
        if (fm.includes('name:') && fm.includes('description:')) {
          console.log(chalk.green('  ✓ Frontmatter (name + description)'));
        } else {
          console.log(chalk.red('  ✗ Frontmatter — missing name or description'));
          allPass = false;
        }
      }
    } else {
      console.log(chalk.red('  ✗ Frontmatter — missing'));
      allPass = false;
    }

    console.log('');
    if (allPass) {
      console.log(chalk.green('  Skill is valid.\n'));
    } else {
      console.log(chalk.yellow('  Skill has missing sections. See docs/skill-reference.md\n'));
    }
  }
}
