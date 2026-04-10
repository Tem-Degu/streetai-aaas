import fs from 'fs';
import path from 'path';
import { readJson, writeJson, listFiles } from '../../utils/workspace.js';

export function createTransaction(paths, { id, user_id, user_name, service, cost, currency, details }) {
  const fp = path.join(paths.activeTransactions, `${id}.json`);

  if (fs.existsSync(fp)) {
    return JSON.stringify({ error: `Transaction "${id}" already exists.` });
  }

  const txn = {
    id,
    user_id,
    user_name: user_name || user_id,
    service,
    cost: cost || 0,
    currency: currency || '$',
    status: 'pending',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...details,
  };

  fs.mkdirSync(paths.activeTransactions, { recursive: true });
  writeJson(fp, txn);
  return JSON.stringify({ ok: true, message: `Transaction "${id}" created.`, transaction: txn });
}

export function updateTransaction(paths, { id, updates }) {
  const fp = path.join(paths.activeTransactions, `${id}.json`);

  if (!fs.existsSync(fp)) {
    return JSON.stringify({ error: `Transaction "${id}" not found in active transactions.` });
  }

  const txn = readJson(fp);
  Object.assign(txn, updates, { updated_at: new Date().toISOString() });
  writeJson(fp, txn);

  return JSON.stringify({ ok: true, message: `Transaction "${id}" updated.`, transaction: txn });
}

export function completeTransaction(paths, { id, rating }) {
  const activePath = path.join(paths.activeTransactions, `${id}.json`);

  if (!fs.existsSync(activePath)) {
    return JSON.stringify({ error: `Transaction "${id}" not found in active transactions.` });
  }

  const txn = readJson(activePath);
  txn.status = 'completed';
  txn.completed_at = new Date().toISOString();
  txn.updated_at = new Date().toISOString();
  if (rating) txn.rating = rating;

  // Move to archive
  fs.mkdirSync(paths.archivedTransactions, { recursive: true });
  const archivePath = path.join(paths.archivedTransactions, `${id}.json`);
  writeJson(archivePath, txn);
  fs.unlinkSync(activePath);

  return JSON.stringify({ ok: true, message: `Transaction "${id}" completed and archived.`, transaction: txn });
}

export function attachFileToTransaction(paths, { id, file_path }) {
  if (!id || !file_path) {
    return JSON.stringify({ error: 'id and file_path are required.' });
  }

  // Locate the transaction (active or archived)
  let txnPath = path.join(paths.activeTransactions, `${id}.json`);
  if (!fs.existsSync(txnPath)) {
    txnPath = path.join(paths.archivedTransactions, `${id}.json`);
    if (!fs.existsSync(txnPath)) {
      return JSON.stringify({ error: `Transaction "${id}" not found.` });
    }
  }

  // Normalize path — must be workspace-relative and live under data/
  const rel = file_path.replace(/\\/g, '/').replace(/^\.\//, '');
  if (path.isAbsolute(rel) || rel.includes('..')) {
    return JSON.stringify({ error: 'file_path must be a workspace-relative path under data/.' });
  }
  const relUnderData = rel.startsWith('data/') ? rel.slice(5) : rel;
  const absPath = path.resolve(paths.data, relUnderData);
  if (!absPath.startsWith(path.resolve(paths.data))) {
    return JSON.stringify({ error: 'file_path must resolve under data/.' });
  }
  if (!fs.existsSync(absPath)) {
    return JSON.stringify({ error: `File not found: ${file_path}` });
  }

  const stat = fs.statSync(absPath);
  const filename = path.basename(absPath);
  const ext = path.extname(filename).slice(1).toLowerCase();
  const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'];
  const audioExts = ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'];
  const videoExts = ['mp4', 'webm', 'ogv', 'mov', 'avi', 'mkv'];
  let kind = 'file';
  if (imageExts.includes(ext)) kind = 'image';
  else if (audioExts.includes(ext)) kind = 'audio';
  else if (videoExts.includes(ext)) kind = 'video';

  const fileEntry = {
    name: filename,
    path: `data/${relUnderData}`,
    size: stat.size,
    kind,
    attached_at: new Date().toISOString(),
  };

  const txn = readJson(txnPath);
  if (!Array.isArray(txn.files)) txn.files = [];
  // Avoid duplicate entries for the same path
  if (!txn.files.some(f => f.path === fileEntry.path)) {
    txn.files.push(fileEntry);
    txn.updated_at = new Date().toISOString();
    writeJson(txnPath, txn);
  }

  return JSON.stringify({
    ok: true,
    message: `File "${filename}" attached to transaction "${id}".`,
    file: fileEntry,
    file_count: txn.files.length,
  });
}

export function listTransactions(paths, { status, include_archived } = {}) {
  const txns = [];

  for (const f of listFiles(paths.activeTransactions, '.json')) {
    const data = readJson(path.join(paths.activeTransactions, f));
    if (data) txns.push(data);
  }

  if (include_archived) {
    for (const f of listFiles(paths.archivedTransactions, '.json')) {
      const data = readJson(path.join(paths.archivedTransactions, f));
      if (data) txns.push(data);
    }
  }

  let filtered = txns;
  if (status) filtered = txns.filter(t => t.status === status);

  filtered.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

  return JSON.stringify({ count: filtered.length, transactions: filtered.slice(0, 50) });
}
