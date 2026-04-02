import fs from 'fs';
import path from 'path';
import os from 'os';
import { BaseConnector } from './index.js';
import { getWorkspacePaths, readText, listFiles } from '../utils/workspace.js';

/**
 * OpenClaw connector — copies workspace files to ~/.openclaw/ and registers the agent.
 * This is a "fire and forget" connector — OpenClaw handles the actual runtime.
 */
export default class OpenClawConnector extends BaseConnector {
  get platformName() { return 'openclaw'; }

  async connect() {
    this.status = 'connecting';

    try {
      const ws = this.engine.workspace;
      const paths = getWorkspacePaths(ws);

      // Derive agent ID
      const agentId = this.config.agentId || deriveAgentId(ws, paths);
      const openclawDir = path.join(os.homedir(), '.openclaw');
      const workspaceDir = path.join(openclawDir, `workspace-${agentId}`);

      // Create OpenClaw workspace
      fs.mkdirSync(workspaceDir, { recursive: true });

      // Copy SKILL.md
      const skillDest = path.join(workspaceDir, 'skills', 'aaas');
      fs.mkdirSync(skillDest, { recursive: true });
      const skill = readText(paths.skill);
      if (skill) fs.writeFileSync(path.join(skillDest, 'SKILL.md'), skill);

      // Copy SOUL.md
      const soul = readText(paths.soul);
      if (soul) fs.writeFileSync(path.join(workspaceDir, 'SOUL.md'), soul);

      // Copy directories
      const dirsToCopy = ['data', 'extensions', 'memory'];
      for (const dir of dirsToCopy) {
        const src = paths[dir] || path.join(ws, dir);
        const dest = path.join(workspaceDir, dir);
        if (fs.existsSync(src)) {
          copyDir(src, dest);
        }
      }

      // Copy transactions
      for (const sub of ['active', 'archive']) {
        const src = sub === 'active' ? paths.activeTransactions : paths.archivedTransactions;
        const dest = path.join(workspaceDir, 'transactions', sub);
        if (fs.existsSync(src)) {
          copyDir(src, dest);
        }
      }

      this.status = 'connected';
      this.error = null;
    } catch (err) {
      this.status = 'error';
      this.error = err.message;
      throw err;
    }
  }

  async send() {
    // OpenClaw handles sending — no-op
  }
}

function deriveAgentId(ws, paths) {
  const skill = readText(paths.skill) || '';
  const match = skill.match(/^#\s+(.+?)(?:\s*—|\s*-|\n)/m);
  if (match) {
    return match[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
  }
  return path.basename(ws).toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
