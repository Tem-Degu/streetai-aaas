import fs from 'fs';
import path from 'path';

export function findWorkspace(dir = process.cwd()) {
  // Walk up looking for skills/aaas/SKILL.md
  let current = path.resolve(dir);
  const root = path.parse(current).root;

  while (current !== root) {
    if (fs.existsSync(path.join(current, 'skills', 'aaas', 'SKILL.md'))) {
      return current;
    }
    current = path.dirname(current);
  }
  return null;
}

export function requireWorkspace(dir) {
  const ws = findWorkspace(dir);
  if (!ws) {
    console.error('Error: Not inside an AaaS workspace. Run "aaas init" first or cd into a workspace.');
    process.exit(1);
  }
  return ws;
}

export function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

export function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

export function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

export function listFiles(dir, ext) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => !f.startsWith('.'))
    .filter(f => !ext || f.endsWith(ext))
    .sort();
}

export function fileStats(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return {
      size: stat.size,
      modified: stat.mtime,
      created: stat.birthtime
    };
  } catch {
    return null;
  }
}

export function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

export function formatDate(date) {
  return new Date(date).toLocaleString();
}

export function getWorkspacePaths(ws) {
  return {
    root: ws,
    skill: path.join(ws, 'skills', 'aaas', 'SKILL.md'),
    skills: path.join(ws, 'skills'),
    soul: path.join(ws, 'SOUL.md'),
    data: path.join(ws, 'data'),
    activeTransactions: path.join(ws, 'transactions', 'active'),
    archivedTransactions: path.join(ws, 'transactions', 'archive'),
    extensions: path.join(ws, 'extensions', 'registry.json'),
    deliveries: path.join(ws, 'deliveries'),
    memory: path.join(ws, 'memory'),
    config: path.join(ws, '.aaas', 'config.json'),
    connections: path.join(ws, '.aaas', 'connections'),
    sessions: path.join(ws, '.aaas', 'sessions'),
    uploads: path.join(ws, '.aaas', 'uploads'),
    pidFile: path.join(ws, '.aaas', 'agent.pid')
  };
}

/**
 * Get the path to a platform's SKILL.md file.
 */
export function getPlatformSkillPath(ws, platform) {
  return path.join(ws, 'skills', platform, 'SKILL.md');
}
