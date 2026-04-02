import fs from 'fs';
import path from 'path';
import { readJson, writeJson } from '../utils/workspace.js';

export function getConnectionsDir(workspace) {
  return path.join(workspace, '.aaas', 'connections');
}

export function loadConnection(workspace, platform) {
  const fp = path.join(getConnectionsDir(workspace), `${platform}.json`);
  return readJson(fp);
}

export function saveConnection(workspace, platform, data) {
  const dir = getConnectionsDir(workspace);
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, `${platform}.json`), data);
}

export function removeConnection(workspace, platform) {
  const fp = path.join(getConnectionsDir(workspace), `${platform}.json`);
  if (fs.existsSync(fp)) {
    fs.unlinkSync(fp);
    return true;
  }
  return false;
}

export function listConnections(workspace) {
  const dir = getConnectionsDir(workspace);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const connections = [];

  for (const f of files) {
    const platform = f.replace('.json', '');
    const config = readJson(path.join(dir, f));
    if (config) connections.push({ platform, config });
  }

  return connections;
}
