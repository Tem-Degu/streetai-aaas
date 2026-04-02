import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { readJson, readText, writeJson, listFiles } from '../utils/workspace.js';
import { getProviderCredential, setProviderCredential, removeProviderCredential, listProviders, maskApiKey } from '../auth/credentials.js';

export function hubRouter(hubDir) {
  const router = express.Router();

  /**
   * Scan directory for AaaS workspaces (directories containing skills/aaas/SKILL.md)
   */
  function discoverWorkspaces() {
    const workspaces = [];
    if (!fs.existsSync(hubDir)) return workspaces;

    const entries = fs.readdirSync(hubDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dashboard' || entry.name === 'src' || entry.name === 'docs' || entry.name === 'templates' || entry.name === 'examples' || entry.name === 'bin') continue;

      const wsPath = path.join(hubDir, entry.name);
      const skillPath = path.join(wsPath, 'skills', 'aaas', 'SKILL.md');
      if (!fs.existsSync(skillPath)) continue;

      // Read workspace metadata
      const skill = readText(skillPath) || '';
      const config = readJson(path.join(wsPath, '.aaas', 'config.json')) || {};

      // Extract name from SKILL.md (first # heading)
      const nameMatch = skill.match(/^#\s+(.+)/m);
      const agentName = nameMatch ? nameMatch[1].replace(/\s*—.*/, '').trim() : entry.name;

      // Check connections
      const connectionsDir = path.join(wsPath, '.aaas', 'connections');
      const connections = [];
      if (fs.existsSync(connectionsDir)) {
        for (const f of fs.readdirSync(connectionsDir)) {
          if (f.endsWith('.json')) {
            const conn = readJson(path.join(connectionsDir, f));
            connections.push({
              platform: f.replace('.json', ''),
              ...(conn || {}),
            });
          }
        }
      }

      // Check if running (PID file)
      const pidFile = path.join(wsPath, '.aaas', 'agent.pid');
      const isRunning = fs.existsSync(pidFile);

      // Data files count
      const dataDir = path.join(wsPath, 'data');
      const dataFiles = fs.existsSync(dataDir) ? listFiles(dataDir).length : 0;

      // Memory facts count
      const factsPath = path.join(wsPath, 'memory', 'facts.json');
      const facts = readJson(factsPath);
      const factCount = Array.isArray(facts) ? facts.length : 0;

      // Active transactions
      const activeTxDir = path.join(wsPath, 'transactions', 'active');
      const activeTx = fs.existsSync(activeTxDir) ? listFiles(activeTxDir, '.json').length : 0;

      // Last modified
      let lastActive = null;
      try {
        const stat = fs.statSync(skillPath);
        lastActive = stat.mtime.toISOString();
        // Check sessions for more recent activity
        const sessionsDir = path.join(wsPath, '.aaas', 'sessions');
        if (fs.existsSync(sessionsDir)) {
          for (const sf of fs.readdirSync(sessionsDir)) {
            const ss = fs.statSync(path.join(sessionsDir, sf));
            if (!lastActive || ss.mtime > new Date(lastActive)) {
              lastActive = ss.mtime.toISOString();
            }
          }
        }
      } catch { /* ignore */ }

      workspaces.push({
        name: agentName,
        directory: entry.name,
        path: wsPath,
        provider: config.provider || null,
        model: config.model || null,
        connections,
        isRunning,
        dataFiles,
        factCount,
        activeTx,
        lastActive,
      });
    }

    return workspaces.sort((a, b) => {
      // Running first, then by last active
      if (a.isRunning !== b.isRunning) return a.isRunning ? -1 : 1;
      if (a.lastActive && b.lastActive) return new Date(b.lastActive) - new Date(a.lastActive);
      return a.name.localeCompare(b.name);
    });
  }

  // List all workspaces
  router.get('/workspaces', (req, res) => {
    const workspaces = discoverWorkspaces();
    res.json({ workspaces, hubDir });
  });

  // Create new workspace
  router.post('/workspaces', (req, res) => {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    // Sanitize directory name
    const dirName = name.toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/_+/g, '_');
    const target = path.join(hubDir, dirName);

    if (fs.existsSync(target)) {
      return res.status(400).json({ error: `Directory "${dirName}" already exists` });
    }

    // Create workspace structure (mirrors init.js)
    const dirs = [
      'skills/aaas', 'data', 'transactions/active', 'transactions/archive',
      'extensions', 'deliveries', 'memory', '.aaas/connections', '.aaas/sessions'
    ];
    for (const dir of dirs) {
      fs.mkdirSync(path.join(target, dir), { recursive: true });
    }

    const displayName = name;
    const desc = description || 'A service agent built with the AaaS protocol';

    // SKILL.md
    const skill = `---
name: aaas
description: Agent as a Service — autonomous service provider protocol
---

# ${displayName} — AaaS Service Agent

You are ${displayName}, a service agent operating under the AaaS protocol.
${desc}

## Your Identity

- **Name:** ${displayName}
- **Service:** ${desc}
- **Categories:** [Choose: Commerce, Dating & Social, Travel, Professional, Creative, Education, Health, Tech, Local Services]
- **Languages:** English
- **Regions:** Global

## About Your Service

[Write a detailed description of your service here]

## Service Catalog

### Service 1: [Name]

- **Description:** [What this service does]
- **What you need from the user:** [Information required]
- **What you deliver:** [What the user receives]
- **Estimated time:** [Duration]
- **Cost:** [Price or "Free"]

## Domain Knowledge

[Write everything the agent needs to know about its domain]

## Pricing Rules

[Define how costs are calculated]

## Boundaries

What you must refuse:
- Illegal or harmful requests
- Requests outside your domain

When to escalate to your owner:
- Complex edge cases
- Disputes you can't resolve

## SLAs

- **Response time:** 2 minutes
- **Proposal time:** 10 minutes
- **Delivery time:** [Set per service]
- **Support window:** 48 hours

## How You Work — The AaaS Protocol

Follow this lifecycle for every service interaction:

### Step 1: Explore
Understand what the user wants. Ask clarifying questions. Check your service database and extensions.

### Step 2: Create Service
Present a plan and cost to the user. Request payment if applicable. Wait for approval.

### Step 3: Create Transaction
Record the transaction in transactions/active/ as a JSON file.

### Step 4: Deliver Service
Execute the plan. Query your database, call extensions, prepare the result. Send it to the user.

### Step 5: Complete Transaction
Confirm satisfaction. Send an invoice. Move transaction to archive. Ask for a rating.
`;
    fs.writeFileSync(path.join(target, 'skills', 'aaas', 'SKILL.md'), skill);

    // SOUL.md
    const soul = `# Soul

I am ${displayName}. I provide real value to real people through conversation.

## Core Principles

- I am a business, not a chatbot
- I am honest about what I can and can't do
- I follow through on commitments
- I protect my customers' data and privacy
- I earn my reputation through quality service

## How I Communicate

- Direct and clear — no filler
- Warm but professional
- I explain costs upfront — no surprises
- I confirm understanding before acting
- I give progress updates on long tasks

## How I Handle Problems

- I acknowledge issues immediately
- I propose solutions, not excuses
- If I made a mistake, I own it and fix it
- If I can't fix it, I escalate to my owner
`;
    fs.writeFileSync(path.join(target, 'SOUL.md'), soul);

    // Extensions registry
    fs.writeFileSync(
      path.join(target, 'extensions', 'registry.json'),
      JSON.stringify({ extensions: [] }, null, 2) + '\n'
    );

    // .gitkeep files
    for (const dir of ['data', 'transactions/active', 'transactions/archive', 'deliveries', 'memory']) {
      fs.writeFileSync(path.join(target, dir, '.gitkeep'), '');
    }

    // Copy hub config to new workspace if it exists
    const srcConfig = readJson(path.join(hubDir, '.aaas', 'config.json'));
    if (srcConfig) {
      writeJson(path.join(target, '.aaas', 'config.json'), srcConfig);
    }

    res.json({ ok: true, directory: dirName, path: target });
  });

  // ─── Hub Config (shared defaults for new agents) ──────────

  const hubConfigDir = path.join(hubDir, '.aaas');
  const hubConfigPath = path.join(hubConfigDir, 'config.json');

  router.get('/config', (req, res) => {
    if (!fs.existsSync(hubConfigDir)) fs.mkdirSync(hubConfigDir, { recursive: true });
    const config = readJson(hubConfigPath) || {};
    const providers = listProviders().map(name => {
      const cred = getProviderCredential(name);
      return {
        name,
        source: cred?.source || 'unknown',
        keyPreview: cred?.apiKey ? maskApiKey(cred.apiKey) : null,
      };
    });
    res.json({ ...config, configuredProviders: providers });
  });

  router.put('/config', (req, res) => {
    if (!fs.existsSync(hubConfigDir)) fs.mkdirSync(hubConfigDir, { recursive: true });
    const current = readJson(hubConfigPath) || {};
    const updated = { ...current, ...req.body };
    writeJson(hubConfigPath, updated);
    res.json({ ok: true });
  });

  // ─── Hub Credentials ──────────────────────────

  router.post('/credentials', (req, res) => {
    const { provider, apiKey, endpoint, baseUrl } = req.body;
    if (!provider) return res.status(400).json({ error: 'provider required' });
    if (provider !== 'ollama' && !apiKey) return res.status(400).json({ error: 'apiKey required' });

    const credential = { type: 'api_key' };
    if (apiKey) credential.apiKey = apiKey;
    if (endpoint) credential.endpoint = endpoint;
    if (baseUrl) credential.baseUrl = baseUrl;

    setProviderCredential(provider, credential);
    res.json({ ok: true });
  });

  router.delete('/credentials/:provider', (req, res) => {
    const removed = removeProviderCredential(req.params.provider);
    if (!removed) return res.status(404).json({ error: 'Provider not found' });
    res.json({ ok: true });
  });

  // ─── Hub Models ──────────────────────────

  router.get('/models/:provider', (req, res) => {
    const models = PROVIDER_MODELS[req.params.provider];
    if (!models) return res.json([]);
    res.json(models);
  });

  // ─── Hub Engine Status (hub has no engine) ──────

  router.get('/engine-status', (req, res) => {
    res.json({ initialized: false, error: 'Hub mode — no engine. Configure settings here to export to new agents.' });
  });

  // ─── Hub OAuth ──────────────────────────

  const oauthStates = new Map();

  router.post('/oauth/start', (req, res) => {
    const { provider, clientId, tenantId } = req.body;
    if (!provider) return res.status(400).json({ error: 'provider required' });

    const oauthConfig = OAUTH_PROVIDERS[provider];
    if (!oauthConfig) return res.status(400).json({ error: `OAuth not available for ${provider}.` });
    if (!clientId) return res.status(400).json({ error: 'clientId required' });

    const state = crypto.randomBytes(16).toString('hex');
    const redirectUri = 'http://localhost:19836/oauth/callback';

    let authUrl = oauthConfig.authUrl;
    let tokenUrl = oauthConfig.tokenUrl;
    if (provider === 'azure') {
      const tenant = tenantId || 'common';
      authUrl = authUrl.replace('{tenant}', tenant);
      tokenUrl = tokenUrl.replace('{tenant}', tenant);
    }

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
    });
    if (oauthConfig.scopes) params.append('scope', oauthConfig.scopes);
    if (provider === 'google') params.append('access_type', 'offline');

    oauthStates.set(state, { provider, clientId, redirectUri, tokenUrl });
    setTimeout(() => oauthStates.delete(state), 5 * 60 * 1000);

    res.json({ authUrl: `${authUrl}?${params.toString()}`, state });
  });

  router.post('/oauth/exchange', async (req, res) => {
    const { redirectUrl, state } = req.body;
    if (!redirectUrl || !state) return res.status(400).json({ error: 'redirectUrl and state required' });

    const oauthState = oauthStates.get(state);
    if (!oauthState) return res.status(400).json({ error: 'Invalid or expired OAuth state.' });

    try {
      const url = new URL(redirectUrl);
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');

      if (!code) return res.status(400).json({ error: 'No authorization code found in the URL.' });
      if (returnedState && returnedState !== state) return res.status(400).json({ error: 'OAuth state mismatch' });

      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: oauthState.redirectUri,
        client_id: oauthState.clientId,
      });

      const tokenRes = await fetch(oauthState.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        return res.status(400).json({ error: `Token exchange failed: ${errText}` });
      }

      const tokens = await tokenRes.json();

      setProviderCredential(oauthState.provider, {
        type: 'oauth',
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || null,
        expiresAt: tokens.expires_in
          ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
          : null,
        apiKey: tokens.access_token,
      });

      oauthStates.delete(state);
      res.json({ ok: true, provider: oauthState.provider });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}

// ─── Constants (shared with api.js) ─────────────

const PROVIDER_MODELS = {
  anthropic: [
    { value: 'claude-opus-4-20250514', label: 'Claude Opus 4' },
    { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
    { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
    { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' },
  ],
  openai: [
    { value: 'gpt-4o', label: 'GPT-4o' },
    { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
    { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
    { value: 'o1', label: 'o1' },
    { value: 'o3-mini', label: 'o3 Mini' },
  ],
  google: [
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
    { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
  ],
  ollama: [
    { value: 'llama3.2', label: 'Llama 3.2' },
    { value: 'llama3.1', label: 'Llama 3.1' },
    { value: 'mistral', label: 'Mistral' },
    { value: 'codellama', label: 'Code Llama' },
    { value: 'phi3', label: 'Phi-3' },
    { value: 'qwen2.5', label: 'Qwen 2.5' },
  ],
  openrouter: [
    { value: 'anthropic/claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
    { value: 'anthropic/claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
    { value: 'openai/gpt-4o', label: 'GPT-4o' },
    { value: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { value: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B' },
    { value: 'deepseek/deepseek-chat', label: 'DeepSeek Chat' },
  ],
  azure: [
    { value: 'gpt-4o', label: 'GPT-4o' },
    { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
    { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
  ],
};

const OAUTH_PROVIDERS = {
  anthropic: {
    authUrl: 'https://console.anthropic.com/oauth/authorize',
    tokenUrl: 'https://console.anthropic.com/oauth/token',
    clientId: 'aaas-agent-runtime',
    redirectUri: 'http://localhost:19836/oauth/callback',
    scopes: 'user:inference',
  },
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    clientId: 'aaas-agent-runtime.apps.googleusercontent.com',
    redirectUri: 'http://localhost:19836/oauth/callback',
    scopes: 'https://www.googleapis.com/auth/generative-language',
  },
  azure: {
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    clientId: 'aaas-agent-runtime',
    redirectUri: 'http://localhost:19836/oauth/callback',
    scopes: 'https://cognitiveservices.azure.com/.default offline_access',
  },
};
