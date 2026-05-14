import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import * as tar from 'tar';
import { readJson, writeJson } from '../utils/workspace.js';

/**
 * Workspace export/import.
 *
 * Bundle layout (a single .tar.gz):
 *   manifest.json                          - what's inside + what needs reattaching
 *   workspace/
 *     skills/aaas/SKILL.md
 *     skills/<platform>/SKILL.md           - per-platform skill copies
 *     SOUL.md
 *     data/...                             - JSON files, sqlite db, extension downloads
 *     memory/...                           - facts.json + activity.jsonl
 *     transactions/active/...
 *     transactions/archive/...
 *     extensions/registry.json
 *     .aaas/config.json
 *     .aaas/notifications.json             - sanitized in no-secrets mode
 *     .aaas/connections/<platform>.json    - sanitized in no-secrets mode
 *     .aaas/credentials.json               - dropped entirely in no-secrets mode
 *     .aaas/payments/                      - dropped entirely in no-secrets mode
 *     .aaas/sessions/                      - dropped in no-secrets mode (live customer state)
 *
 * Manifest schema:
 *   {
 *     bundle_version: 1,
 *     aaas_version: "0.3.1",
 *     workspace_name: "mira",
 *     created_at: "2026-05-11T...",
 *     has_secrets: false,
 *     requires: [
 *       { kind: "llm", provider: "anthropic" },
 *       { kind: "connection", platform: "telegram" },
 *       { kind: "connection", platform: "stripe" },
 *       { kind: "notifications_smtp" },
 *       { kind: "extension_api_key", name: "aimlapi" }
 *     ]
 *   }
 */

export const BUNDLE_VERSION = 1;

/**
 * Slugify a workspace name into a safe filename component. Strips path-y
 * characters, collapses runs of dashes, lowercases, trims length.
 */
export function slugify(name, fallback = 'agent') {
  if (!name) return fallback;
  const out = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
  return out || fallback;
}

function defaultOutputName(workspaceRoot, suffix) {
  const base = slugify(path.basename(workspaceRoot));
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const suf = suffix ? `-${suffix}` : '';
  return `aaas-${base}-${stamp}${suf}.tar.gz`;
}

// ── Sanitization ──────────────────────────────────────────

const STRIPPABLE_CRED_FILES = new Set(['credentials.json']);
const STRIPPABLE_SUBDIRS = new Set(['payments', 'sessions', 'uploads']);
const CONNECTION_SECRET_FIELDS = [
  // Truuze
  'agentKey', 'platformApiKey',
  // Telegram / Discord / Slack
  'token', 'botToken', 'appToken',
  // WhatsApp
  'accessToken', 'verifyToken',
  // Stripe
  'secret_key',
  // Relay
  'relayKey', 'apiKey',
  // Generic
  'password', 'secret',
];
const NOTIFICATIONS_SECRET_FIELDS_SMTP = ['pass'];

function sanitizeConnection(platform, cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const cleaned = { ...cfg };
  for (const f of CONNECTION_SECRET_FIELDS) {
    if (f in cleaned) delete cleaned[f];
  }
  // Track that this connection needs reattaching.
  cleaned._needs_secret = true;
  return cleaned;
}

function sanitizeNotifications(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const out = { ...cfg };
  if (out.email?.smtp) {
    const smtp = { ...out.email.smtp };
    for (const f of NOTIFICATIONS_SECRET_FIELDS_SMTP) {
      if (f in smtp) delete smtp[f];
    }
    out.email = { ...out.email, smtp, _needs_secret: true };
  }
  return out;
}

function sanitizeExtensionsRegistry(registry) {
  if (!registry) return registry;
  const exts = registry.extensions || (Array.isArray(registry) ? registry : []);
  const stripped = [];
  const cleaned = exts.map(ext => {
    if (!ext?.auth) return ext;
    const auth = { ...ext.auth };
    // Keep `{{ENV_VAR}}` placeholders — they're not literal secrets.
    if (auth.apiKey && typeof auth.apiKey === 'string' && !/^\{\{.+\}\}$/.test(auth.apiKey)) {
      delete auth.apiKey;
      stripped.push(ext.name);
      return { ...ext, auth, _needs_secret: true };
    }
    return ext;
  });
  return {
    registry: Array.isArray(registry) ? cleaned : { ...registry, extensions: cleaned },
    stripped_extensions: stripped,
  };
}

// ── Manifest builders ─────────────────────────────────────

function buildManifest({ workspaceName, hasSecrets, requires = [] }) {
  return {
    bundle_version: BUNDLE_VERSION,
    aaas_version: readPackageVersion(),
    workspace_name: workspaceName,
    created_at: new Date().toISOString(),
    has_secrets: hasSecrets,
    requires,
  };
}

function readPackageVersion() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'package.json'), 'utf-8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

// ── Export ────────────────────────────────────────────────

/**
 * Build a workspace archive at `outputPath`. Returns { outputPath, manifest, sizeBytes }.
 *
 * Strategy: stage the workspace into a temp directory (so we can rewrite
 * sanitized files without touching the source), then tar.gz the staging dir
 * with the prefix `workspace/`. The manifest lives at the archive root.
 */
export async function exportWorkspace(workspaceRoot, { noSecrets = false, outputPath } = {}) {
  if (!fs.existsSync(workspaceRoot)) {
    throw new Error(`Workspace not found: ${workspaceRoot}`);
  }
  const workspaceName = path.basename(workspaceRoot);
  const out = path.resolve(outputPath || defaultOutputName(workspaceRoot, noSecrets ? 'shareable' : null));

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'aaas-export-'));
  const workspaceStage = path.join(staging, 'workspace');
  fs.mkdirSync(workspaceStage, { recursive: true });

  const requires = [];

  try {
    // Copy everything except things we always exclude (node_modules, .git, the
    // dashboard build cache, prior export bundles).
    const SKIP_AT_ROOT = new Set(['node_modules', '.git', '.DS_Store']);
    const SKIP_AT_AAAS = noSecrets ? STRIPPABLE_SUBDIRS : new Set();

    for (const entry of fs.readdirSync(workspaceRoot)) {
      if (SKIP_AT_ROOT.has(entry)) continue;
      // Don't recursively pack a previous export living next to the workspace.
      if (entry.startsWith('aaas-') && entry.endsWith('.tar.gz')) continue;
      copyTree(
        path.join(workspaceRoot, entry),
        path.join(workspaceStage, entry),
        { skipDirNames: entry === '.aaas' ? SKIP_AT_AAAS : new Set() },
      );
    }

    // ── Apply sanitizations to staged copy when --no-secrets ──
    if (noSecrets) {
      // credentials.json — drop entirely + record what was there.
      const credsPath = path.join(workspaceStage, '.aaas', 'credentials.json');
      if (fs.existsSync(credsPath)) {
        try {
          const creds = readJson(credsPath) || {};
          for (const provider of Object.keys(creds)) {
            if (creds[provider]?.apiKey) {
              requires.push({ kind: 'llm', provider });
            }
          }
        } catch { /* best effort */ }
        fs.rmSync(credsPath, { force: true });
      }

      // connections/*.json — sanitize each.
      const connDir = path.join(workspaceStage, '.aaas', 'connections');
      if (fs.existsSync(connDir)) {
        for (const file of fs.readdirSync(connDir)) {
          if (!file.endsWith('.json')) continue;
          const platform = file.replace(/\.json$/, '');
          const cfg = readJson(path.join(connDir, file));
          if (!cfg) continue;
          const cleaned = sanitizeConnection(platform, cfg);
          writeJson(path.join(connDir, file), cleaned);
          requires.push({ kind: 'connection', platform });
        }
      }

      // notifications.json — keep addresses, drop SMTP pass.
      const notifPath = path.join(workspaceStage, '.aaas', 'notifications.json');
      if (fs.existsSync(notifPath)) {
        const cfg = readJson(notifPath);
        if (cfg?.email?.smtp && cfg.email.smtp.pass) {
          const cleaned = sanitizeNotifications(cfg);
          writeJson(notifPath, cleaned);
          requires.push({ kind: 'notifications_smtp' });
        }
      }

      // extensions/registry.json — strip literal apiKey values.
      const extPath = path.join(workspaceStage, 'extensions', 'registry.json');
      if (fs.existsSync(extPath)) {
        const reg = readJson(extPath);
        const { registry: cleaned, stripped_extensions } = sanitizeExtensionsRegistry(reg);
        writeJson(extPath, cleaned);
        for (const name of stripped_extensions) {
          requires.push({ kind: 'extension_api_key', name });
        }
      }
    }

    // ── Write manifest ──
    const manifest = buildManifest({
      workspaceName,
      hasSecrets: !noSecrets,
      requires,
    });
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

    // ── Pack ──
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await tar.c(
      {
        gzip: true,
        file: out,
        cwd: staging,
        // Capture both the manifest and the staged workspace tree.
        portable: true,
      },
      ['manifest.json', 'workspace'],
    );

    const sizeBytes = fs.statSync(out).size;
    return { outputPath: out, manifest, sizeBytes };
  } finally {
    // Clean up staging unconditionally.
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ── Import ────────────────────────────────────────────────

/**
 * Inspect an archive without extracting it. Returns the manifest only.
 * Useful for previews and confirmation prompts.
 */
export async function readManifest(archivePath) {
  if (!fs.existsSync(archivePath)) {
    throw new Error(`Archive not found: ${archivePath}`);
  }
  let manifest = null;
  await tar.t({
    file: archivePath,
    onentry: (entry) => {
      if (entry.path !== 'manifest.json') return;
      const chunks = [];
      entry.on('data', (c) => chunks.push(c));
      entry.on('end', () => {
        try { manifest = JSON.parse(Buffer.concat(chunks).toString('utf-8')); }
        catch { /* leave null */ }
      });
    },
  });
  if (!manifest) throw new Error('Archive does not contain a valid manifest.json — is this an AaaS export?');
  if (manifest.bundle_version !== BUNDLE_VERSION) {
    throw new Error(`Unsupported bundle_version: ${manifest.bundle_version} (expected ${BUNDLE_VERSION})`);
  }
  return manifest;
}

/**
 * Extract `archivePath` into `targetDir`. The archive's `workspace/` prefix
 * is unwrapped so the target directly becomes a workspace root. Returns
 * { targetDir, manifest }.
 *
 * Refuses to overwrite an existing non-empty target unless `force` is true.
 */
export async function importWorkspace(archivePath, targetDir, { force = false } = {}) {
  const manifest = await readManifest(archivePath);
  const targetAbs = path.resolve(targetDir);

  if (fs.existsSync(targetAbs)) {
    const contents = fs.readdirSync(targetAbs).filter(f => f !== '.DS_Store');
    if (contents.length > 0 && !force) {
      throw new Error(`Target directory is not empty: ${targetAbs}. Pass --force to overwrite, or choose a fresh folder.`);
    }
  } else {
    fs.mkdirSync(targetAbs, { recursive: true });
  }

  // Extract into temp then move the workspace/ prefix up.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'aaas-import-'));
  try {
    await tar.x({ file: archivePath, cwd: staging });
    const stagedWs = path.join(staging, 'workspace');
    if (!fs.existsSync(stagedWs)) {
      throw new Error('Archive is missing the workspace/ tree — bundle may be corrupt.');
    }
    for (const entry of fs.readdirSync(stagedWs)) {
      const src = path.join(stagedWs, entry);
      const dst = path.join(targetAbs, entry);
      if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
      copyTree(src, dst);
    }
  } finally {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return { targetDir: targetAbs, manifest };
}

// ── Filesystem helper ─────────────────────────────────────

function copyTree(src, dst, { skipDirNames = new Set() } = {}) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    const base = path.basename(src);
    if (skipDirNames.has(base)) return;
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyTree(path.join(src, entry), path.join(dst, entry), { skipDirNames });
    }
  } else if (stat.isFile()) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  // Symlinks and other special files: skipped (unlikely in AaaS workspaces).
}
