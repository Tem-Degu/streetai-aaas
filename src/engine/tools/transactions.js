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
