// Curated, sanitized, rotated error log — one file per workspace.
//
// Goal: a single human-readable file (`.aaas/logs/error.log`) the owner can
// locate from Settings and send for diagnosis. It is COMMON to every agent —
// the same code paths (engine, connectors, extensions, auto-start) feed it, so
// every workspace gets the same diagnostics with no per-agent setup.
//
// Design rules:
//   - Sanitized: secrets and PHI (tokens, keys, Emirates IDs, phone/long digit
//     runs) are redacted before anything is written. Safe for a hospital.
//   - Rotated: capped at ~2MB, one backup kept (error.log.1). Never grows
//     unbounded.
//   - Additive: this augments the existing console.error sites, it does not
//     replace them. Failures here are swallowed — logging must never break a turn.

import fs from 'fs';
import path from 'path';
import os from 'os';

const MAX_BYTES = 2 * 1024 * 1024; // ~2MB, then rotate to .1

// Best-effort scrub of secrets / PHI from a line before it touches disk.
// Callers are expected to log messages + small metadata (not raw payloads);
// this is the safety net for anything that slips through.
function redact(input) {
  let s = String(input == null ? '' : input);
  // Bearer tokens / Basic auth
  s = s.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 [redacted]');
  // key/token/secret/password = value  (json or query style)
  s = s.replace(
    /\b(api[_-]?key|apikey|x-api-key|agent[_-]?key|x-agent-key|client[_-]?secret|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|authorization)\b(["']?\s*[:=]\s*["']?)([^\s"',}&]+)/gi,
    '$1$2[redacted]'
  );
  // Provisioning / agent / platform key prefixes seen in this codebase
  s = s.replace(/\btrz_[A-Za-z0-9_-]{6,}/g, 'trz_[redacted]');
  s = s.replace(/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-[redacted]');
  // Emirates ID: 784 + 12 digits (with optional dashes/spaces)
  s = s.replace(/\b784[-\s]?\d{4}[-\s]?\d{7}[-\s]?\d\b/g, '[redacted-eid]');
  // Email addresses
  s = s.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[redacted-email]');
  // Long digit runs (phone numbers / ids) — keep last 2 for correlation
  s = s.replace(/\+?\d[\d\s-]{6,}\d/g, (m) => {
    const digits = m.replace(/\D/g, '');
    return '[redacted-num…' + digits.slice(-2) + ']';
  });
  return s;
}

export function errorLogPath(workspace) {
  return path.join(workspace, '.aaas', 'logs', 'error.log');
}

// Process-level fallback (for errors not tied to a specific workspace).
export function globalErrorLogPath() {
  return path.join(os.homedir(), '.aaas', 'logs', 'error.log');
}

export function appendRotating(file, text, maxBytes = MAX_BYTES) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      const st = fs.statSync(file);
      if (st.size + text.length > maxBytes) {
        try { fs.rmSync(file + '.1', { force: true }); } catch {}
        try { fs.renameSync(file, file + '.1'); } catch {}
      }
    } catch { /* file doesn't exist yet — fine */ }
    fs.appendFileSync(file, text);
  } catch { /* logging must never throw */ }
}

/**
 * Append one sanitized error entry.
 * @param {string|null} workspace  workspace root dir, or null for the global log
 * @param {string} scope           short tag, e.g. 'engine', 'connector:telnyx', 'extension:hospital_his'
 * @param {Error|string} err       the error
 * @param {object} [meta]          small, non-sensitive context (ids/flags only)
 */
export function logError(workspace, scope, err, meta) {
  try {
    const ts = new Date().toISOString();
    const msg = err instanceof Error ? err.message : String(err == null ? '' : err);
    let line = `[${scope}]  ${msg}`;
    if (meta && typeof meta === 'object' && Object.keys(meta).length) {
      try { line += '  ' + JSON.stringify(meta); } catch { /* ignore unserializable meta */ }
    }
    // Redact only the dynamic content; the timestamp prefix is kept intact so
    // its digits aren't mistaken for a phone/id by the redactor.
    let entry = `${ts}  ${redact(line)}\n`;
    if (err instanceof Error && err.stack) {
      const frames = err.stack.split('\n').slice(1, 4).join('\n');
      if (frames.trim()) entry += redact(frames) + '\n';
    }
    appendRotating(workspace ? errorLogPath(workspace) : globalErrorLogPath(), entry);
  } catch { /* never throw from the logger */ }
}

/**
 * Read the tail of a workspace's error log for the dashboard Diagnostics card.
 * Returns { path, exists, lines, size }.
 */
export function readErrorLogTail(workspace, maxLines = 200) {
  const file = errorLogPath(workspace);
  try {
    const st = fs.statSync(file);
    const content = fs.readFileSync(file, 'utf8');
    const all = content.split('\n');
    const tail = all.slice(-maxLines).join('\n');
    return { path: file, exists: true, lines: tail, size: st.size };
  } catch {
    return { path: file, exists: false, lines: '', size: 0 };
  }
}

// Install once on a long-lived process so hard crashes leave a trace.
// Preserves crash semantics: uncaughtException still terminates (exit 1) so a
// supervisor can restart; unhandledRejection is logged without forcing exit.
let installed = false;
export function installGlobalErrorHandlers() {
  if (installed) return;
  installed = true;
  process.on('uncaughtException', (e) => {
    logError(null, 'process:uncaughtException', e);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logError(null, 'process:unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)));
  });
}
