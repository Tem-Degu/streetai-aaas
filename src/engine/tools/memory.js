import path from 'path';
import { readJson, writeJson } from '../../utils/workspace.js';

const FACTS_FILE = 'facts.json';

function getFactsPath(paths) {
  return path.join(paths.memory, FACTS_FILE);
}

function loadFacts(paths) {
  return readJson(getFactsPath(paths)) || [];
}

function saveFacts(paths, facts) {
  writeJson(getFactsPath(paths), facts);
}

/**
 * Read memory facts, optionally filtered by topic.
 */
export function readMemory(paths, { topic } = {}) {
  const facts = loadFacts(paths);

  if (facts.length === 0) {
    return JSON.stringify({ message: 'No facts stored in memory yet.' });
  }

  let filtered = facts;
  if (topic) {
    const t = topic.toLowerCase();
    filtered = facts.filter(f =>
      f.key.toLowerCase().includes(t) || f.value.toLowerCase().includes(t)
    );
  }

  // Return most recent first, limited to 30
  const results = filtered.slice(-30).reverse();
  return JSON.stringify({ count: results.length, total: facts.length, facts: results });
}

/**
 * Save a fact to memory. Deduplicates by key — updates if exists.
 */
export function saveMemory(paths, { key, value }) {
  if (!key || !value) {
    return JSON.stringify({ error: 'Both key and value are required.' });
  }

  const facts = loadFacts(paths);
  const existing = facts.findIndex(f => f.key === key);

  if (existing >= 0) {
    facts[existing].value = value;
    facts[existing].updatedAt = new Date().toISOString();
    facts[existing].accessCount = (facts[existing].accessCount || 0) + 1;
  } else {
    facts.push({
      key,
      value,
      createdAt: new Date().toISOString(),
      accessCount: 0,
    });
  }

  saveFacts(paths, facts);
  return JSON.stringify({ ok: true, message: `Saved: ${key}` });
}
