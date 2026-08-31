import fs from 'fs';
import path from 'path';
import os from 'os';

const CREDENTIALS_DIR = path.join(os.homedir(), '.aaas');
const CREDENTIALS_FILE = path.join(CREDENTIALS_DIR, 'credentials.json');

const ENV_VAR_MAP = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  cohere: ['COHERE_API_KEY'],
  azure: ['AZURE_OPENAI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  streetai: ['STREETAI_API_KEY'],
  groq: ['GROQ_API_KEY'],
  serper: ['SERPER_API_KEY'],
  brave: ['BRAVE_API_KEY', 'BRAVE_SEARCH_API_KEY'],
  ollama: [], // no key needed
};

const AZURE_ENDPOINT_VAR = 'AZURE_OPENAI_ENDPOINT';

export function getCredentialsPath() {
  return CREDENTIALS_FILE;
}

export function loadCredentials() {
  try {
    if (!fs.existsSync(CREDENTIALS_FILE)) return { providers: {} };
    return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf-8'));
  } catch {
    return { providers: {} };
  }
}

export function saveCredentials(data) {
  fs.mkdirSync(CREDENTIALS_DIR, { recursive: true });
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(data, null, 2) + '\n');

  // Best-effort file permissions on Unix
  try { fs.chmodSync(CREDENTIALS_FILE, 0o600); } catch { /* Windows */ }
}

export function getProviderCredential(name, workspace = null) {
  // 1. Check environment variables first
  const envVars = ENV_VAR_MAP[name] || [];
  for (const v of envVars) {
    const val = process.env[v];
    if (val) {
      const cred = { type: 'api_key', apiKey: val, source: 'env' };
      // Azure also needs endpoint
      if (name === 'azure' && process.env[AZURE_ENDPOINT_VAR]) {
        cred.endpoint = process.env[AZURE_ENDPOINT_VAR];
      }
      return cred;
    }
  }

  // Azure endpoint from env even if key is from file
  const azureEndpointEnv = name === 'azure' ? process.env[AZURE_ENDPOINT_VAR] : null;

  // 2. Per-agent overlay (only when a workspace is given). A tombstone
  //    ({ removed: true }) hides the inherited hub key for this agent; a real
  //    entry overrides it. Absent → fall through to the hub (global) store.
  if (workspace) {
    const wsEntry = loadWorkspaceCredentials(workspace).providers?.[name];
    if (wsEntry) {
      if (wsEntry.removed) return name === 'ollama' ? { type: 'none', source: 'default' } : null;
      const result = { ...wsEntry, source: 'workspace' };
      if (azureEndpointEnv && !result.endpoint) result.endpoint = azureEndpointEnv;
      return result;
    }
  }

  // 3. Check the global (hub) credentials file
  const creds = loadCredentials();
  const fileCred = creds.providers?.[name];
  if (fileCred) {
    const result = { ...fileCred, source: 'file' };
    if (azureEndpointEnv && !result.endpoint) result.endpoint = azureEndpointEnv;
    return result;
  }

  // 3. Ollama needs no key
  if (name === 'ollama') {
    return { type: 'none', source: 'default' };
  }

  return null;
}

export function setProviderCredential(name, credential) {
  const creds = loadCredentials();
  if (!creds.providers) creds.providers = {};
  creds.providers[name] = credential;
  saveCredentials(creds);
}

export function removeProviderCredential(name) {
  const creds = loadCredentials();
  if (creds.providers?.[name]) {
    delete creds.providers[name];
    saveCredentials(creds);
    return true;
  }
  return false;
}

export function listProviders(workspace = null) {
  const creds = loadCredentials();
  const effective = new Set(Object.keys(creds.providers || {}));

  // Apply the per-agent overlay: add agent-added providers, drop tombstoned ones.
  if (workspace) {
    const ws = loadWorkspaceCredentials(workspace).providers || {};
    for (const [provider, entry] of Object.entries(ws)) {
      if (entry?.removed) effective.delete(provider);
      else effective.add(provider);
    }
  }

  // Also surface providers configured only via env vars (env still wins in
  // getProviderCredential, so a tombstoned-but-env-present provider is usable).
  const fromEnv = [];
  for (const [provider, vars] of Object.entries(ENV_VAR_MAP)) {
    if (effective.has(provider)) continue;
    for (const v of vars) {
      if (process.env[v]) {
        fromEnv.push(provider);
        break;
      }
    }
  }

  return [...effective, ...fromEnv];
}

// ─── Per-agent overlay (workspace-scoped credentials) ────────────────────────
// The overlay lives at <workspace>/.aaas/credentials.json and holds only the
// agent's *changes* on top of the inherited hub store: a real credential is an
// add/override; a tombstone ({ removed: true }) hides an inherited hub key for
// this agent only. Publishing flattens hub+overlay into the bundle.

function workspaceCredentialsPath(workspace) {
  return path.join(workspace, '.aaas', 'credentials.json');
}

export function loadWorkspaceCredentials(workspace) {
  try {
    const fp = workspaceCredentialsPath(workspace);
    if (!fs.existsSync(fp)) return { providers: {} };
    const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    if (!data.providers) data.providers = {};
    return data;
  } catch {
    return { providers: {} };
  }
}

export function saveWorkspaceCredentials(workspace, data) {
  const dir = path.join(workspace, '.aaas');
  fs.mkdirSync(dir, { recursive: true });
  const fp = workspaceCredentialsPath(workspace);
  fs.writeFileSync(fp, JSON.stringify(data, null, 2) + '\n');
  try { fs.chmodSync(fp, 0o600); } catch { /* Windows */ }
}

export function setWorkspaceProviderCredential(workspace, name, credential) {
  const creds = loadWorkspaceCredentials(workspace);
  creds.providers[name] = credential;
  saveWorkspaceCredentials(workspace, creds);
}

/**
 * Remove a provider for one agent. If the provider is inherited from the hub,
 * write a tombstone so it's hidden for this agent only; if it was agent-added,
 * just drop the overlay entry. Returns false if there was nothing to remove.
 */
export function removeWorkspaceProvider(workspace, name) {
  const creds = loadWorkspaceCredentials(workspace);
  const inherited = !!(loadCredentials().providers || {})[name];
  if (inherited) {
    creds.providers[name] = { removed: true };
  } else if (creds.providers[name]) {
    delete creds.providers[name];
  } else {
    return false;
  }
  saveWorkspaceCredentials(workspace, creds);
  return true;
}

/** Flatten hub + overlay (minus tombstones) into a self-contained providers map. */
export function resolveEffectiveCredentials(workspace) {
  const effective = { ...(loadCredentials().providers || {}) };
  const ws = loadWorkspaceCredentials(workspace).providers || {};
  for (const [name, entry] of Object.entries(ws)) {
    if (entry?.removed) delete effective[name];
    else effective[name] = entry;
  }
  return { providers: effective };
}

export function maskApiKey(key) {
  if (!key || key.length < 12) return '****';
  return key.slice(0, 7) + '...' + key.slice(-4);
}
