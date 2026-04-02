import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { requireWorkspace, getWorkspacePaths, listFiles, readJson, readText, formatBytes, fileStats } from '../../utils/workspace.js';

export function statusCommand() {
  const ws = requireWorkspace();
  const paths = getWorkspacePaths(ws);

  // Agent name from skill
  const skill = readText(paths.skill) || '';
  const nameMatch = skill.match(/^#\s+(.+?)(?:\s*—|\s*-|\n)/m);
  const agentName = nameMatch ? nameMatch[1].trim() : path.basename(ws);

  console.log(`\n${chalk.bold(agentName)} — AaaS Agent\n`);
  console.log(chalk.gray(`Workspace: ${ws}`));
  console.log('');

  // Skill
  const skillStat = fileStats(paths.skill);
  if (skillStat) {
    const skillSize = formatBytes(skillStat.size);
    console.log(chalk.blue('Skill'));
    console.log(`  File: ${skillSize}, last modified ${skillStat.modified.toLocaleDateString()}`);
    // Check required sections
    const sections = ['Identity', 'Service Catalog', 'Domain Knowledge', 'Pricing', 'Boundaries', 'SLA'];
    const found = sections.filter(s => skill.toLowerCase().includes(s.toLowerCase()));
    const missing = sections.filter(s => !skill.toLowerCase().includes(s.toLowerCase()));
    if (missing.length === 0) {
      console.log(chalk.green('  All required sections present'));
    } else {
      console.log(chalk.yellow(`  Missing sections: ${missing.join(', ')}`));
    }
  } else {
    console.log(chalk.red('Skill: NOT FOUND'));
  }
  console.log('');

  // Data
  const dataFiles = listFiles(paths.data).filter(f => f !== '.gitkeep');
  let totalRecords = 0;
  let totalDataSize = 0;
  for (const f of dataFiles) {
    const fp = path.join(paths.data, f);
    const stat = fileStats(fp);
    if (stat) totalDataSize += stat.size;
    if (f.endsWith('.json')) {
      const data = readJson(fp);
      if (Array.isArray(data)) totalRecords += data.length;
    }
  }
  console.log(chalk.blue('Service Database'));
  console.log(`  ${dataFiles.length} file(s), ${formatBytes(totalDataSize)}, ${totalRecords} records`);
  console.log('');

  // Transactions
  const active = listFiles(paths.activeTransactions, '.json');
  const archived = listFiles(paths.archivedTransactions, '.json');
  let totalRevenue = 0;
  let totalRating = 0;
  let ratingCount = 0;
  let disputed = 0;

  for (const f of archived) {
    const txn = readJson(path.join(paths.archivedTransactions, f));
    if (!txn) continue;
    if (txn.status === 'completed' && txn.cost) totalRevenue += txn.cost;
    if (txn.rating) { totalRating += txn.rating; ratingCount++; }
    if (txn.status === 'disputed' || txn.dispute) disputed++;
  }

  const avgRating = ratingCount > 0 ? (totalRating / ratingCount).toFixed(1) : 'N/A';
  const successRate = archived.length > 0
    ? Math.round((archived.filter(f => {
        const t = readJson(path.join(paths.archivedTransactions, f));
        return t && t.status === 'completed';
      }).length / archived.length) * 100)
    : 0;

  console.log(chalk.blue('Transactions'));
  console.log(`  Active: ${active.length}`);
  console.log(`  Completed: ${archived.length}`);
  console.log(`  Revenue: ${totalRevenue} TK`);
  console.log(`  Success rate: ${successRate}%`);
  console.log(`  Avg rating: ${avgRating}${ratingCount > 0 ? ' ★' : ''}`);
  if (disputed > 0) console.log(chalk.yellow(`  Disputed: ${disputed}`));
  console.log('');

  // Extensions
  const registry = readJson(paths.extensions);
  const extCount = registry?.extensions?.length || 0;
  console.log(chalk.blue('Extensions'));
  console.log(`  ${extCount} registered`);
  if (registry?.extensions) {
    for (const ext of registry.extensions) {
      console.log(`    ${ext.name} (${ext.type})`);
    }
  }
  console.log('');

  // Memory
  const memFiles = listFiles(paths.memory, '.md');
  console.log(chalk.blue('Memory'));
  console.log(`  ${memFiles.length} file(s)`);
  console.log('');
}
