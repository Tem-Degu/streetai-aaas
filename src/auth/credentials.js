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

export function getProviderCredential(name) {
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

  // 2. Check credentials file
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

export function listProviders() {
  const creds = loadCredentials();
  const fromFile = Object.keys(creds.providers || {});

  // Also check env vars
  const fromEnv = [];
  for (const [provider, vars] of Object.entries(ENV_VAR_MAP)) {
    if (fromFile.includes(provider)) continue;
    for (const v of vars) {
      if (process.env[v]) {
        fromEnv.push(provider);
        break;
      }
    }
  }

  return [...fromFile, ...fromEnv];
}

export function maskApiKey(key) {
  if (!key || key.length < 12) return '****';
  return key.slice(0, 7) + '...' + key.slice(-4);
}
