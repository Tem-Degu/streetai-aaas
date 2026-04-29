import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import { readJson, readText, writeJson, listFiles } from '../utils/workspace.js';
import { getProviderCredential, setProviderCredential, removeProviderCredential, listProviders, maskApiKey } from '../auth/credentials.js';
import { getValidWorkspaces, registerWorkspace, unregisterWorkspace } from '../utils/registry.js';

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

      // Check for avatar photo (add mtime for cache busting)
      let photo = null;
      const aaasDir = path.join(wsPath, '.aaas');
      if (fs.existsSync(aaasDir)) {
        const avatarFile = fs.readdirSync(aaasDir).find(f => f.startsWith('avatar.'));
        if (avatarFile) {
          const mtime = fs.statSync(path.join(aaasDir, avatarFile)).mtimeMs;
          photo = `/api/hub/avatar/${entry.name}/${avatarFile}?t=${Math.floor(mtime)}`;
        }
      }

      workspaces.push({
        name: agentName,
        directory: entry.name,
        path: wsPath,
        photo,
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

    // Merge workspaces from global registry (~/.aaas/workspaces.json)
    const knownPaths = new Set(workspaces.map(w => path.resolve(w.path)));
    const registeredWorkspaces = getValidWorkspaces();

    for (const reg of registeredWorkspaces) {
      if (knownPaths.has(path.resolve(reg.path))) continue; // already discovered locally

      const wsPath = reg.path;
      const skillPath = path.join(wsPath, 'skills', 'aaas', 'SKILL.md');
      if (!fs.existsSync(skillPath)) continue;

      const skill = readText(skillPath) || '';
      const config = readJson(path.join(wsPath, '.aaas', 'config.json')) || {};
      const nameMatch = skill.match(/^#\s+(.+)/m);
      const agentName = nameMatch ? nameMatch[1].replace(/\s*—.*/, '').trim() : path.basename(wsPath);

      const connectionsDir = path.join(wsPath, '.aaas', 'connections');
      const connections = [];
      if (fs.existsSync(connectionsDir)) {
        for (const f of fs.readdirSync(connectionsDir)) {
          if (f.endsWith('.json')) {
            const conn = readJson(path.join(connectionsDir, f));
            connections.push({ platform: f.replace('.json', ''), ...(conn || {}) });
          }
        }
      }

      const pidFile = path.join(wsPath, '.aaas', 'agent.pid');
      const isRunning = fs.existsSync(pidFile);
      const dataDir = path.join(wsPath, 'data');
      const dataFiles = fs.existsSync(dataDir) ? listFiles(dataDir).length : 0;
      const factsPath = path.join(wsPath, 'memory', 'facts.json');
      const facts = readJson(factsPath);
      const factCount = Array.isArray(facts) ? facts.length : 0;
      const activeTxDir = path.join(wsPath, 'transactions', 'active');
      const activeTx = fs.existsSync(activeTxDir) ? listFiles(activeTxDir, '.json').length : 0;

      let lastActive = null;
      try {
        const stat = fs.statSync(skillPath);
        lastActive = stat.mtime.toISOString();
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

      let photo = null;
      const aaasDir = path.join(wsPath, '.aaas');
      if (fs.existsSync(aaasDir)) {
        const avatarFile = fs.readdirSync(aaasDir).find(f => f.startsWith('avatar.'));
        if (avatarFile) {
          const mtime = fs.statSync(path.join(aaasDir, avatarFile)).mtimeMs;
          photo = `/api/hub/avatar/${path.basename(wsPath)}/${avatarFile}?t=${Math.floor(mtime)}`;
        }
      }

      workspaces.push({
        name: agentName,
        directory: path.basename(wsPath),
        path: wsPath,
        photo,
        provider: config.provider || null,
        model: config.model || null,
        connections,
        isRunning,
        dataFiles,
        factCount,
        activeTx,
        lastActive,
        remote: true, // flag: not a local subdirectory of this hub
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
  // Avatar upload middleware
  const avatarUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (file.mimetype.startsWith('image/')) cb(null, true);
      else cb(new Error('Only image files are allowed'));
    },
  });

  // Serve avatar images (local hub subdirs + remote registered workspaces)
  router.get('/avatar/:directory/:filename', (req, res) => {
    const { directory, filename } = req.params;
    if (directory.includes('..') || filename.includes('..')) return res.status(400).end();

    // Try local hub subdirectory first
    let fp = path.join(hubDir, directory, '.aaas', filename);
    if (fs.existsSync(fp)) return res.sendFile(fp);

    // Try registered workspaces (remote)
    const registered = getValidWorkspaces();
    const match = registered.find(w => path.basename(w.path) === directory);
    if (match) {
      fp = path.join(match.path, '.aaas', filename);
      if (fs.existsSync(fp)) return res.sendFile(fp);
    }

    res.status(404).end();
  });

  router.post('/workspaces', avatarUpload.single('photo'), (req, res) => {
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

    // Save uploaded photo
    if (req.file) {
      const ext = req.file.originalname.split('.').pop() || 'png';
      const avatarPath = path.join(target, '.aaas', `avatar.${ext}`);
      fs.writeFileSync(avatarPath, req.file.buffer);
    }

    // Register in global workspace registry
    registerWorkspace(target, name);

    res.json({ ok: true, directory: dirName, path: target });
  });

  // Update workspace name/description/photo
  router.patch('/workspaces/:directory', avatarUpload.single('photo'), (req, res) => {
    const { directory } = req.params;
    const { name, description } = req.body;
    const wsPath = path.join(hubDir, directory);
    const skillPath = path.join(wsPath, 'skills', 'aaas', 'SKILL.md');

    if (!fs.existsSync(skillPath)) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    let skill = readText(skillPath) || '';

    if (name) {
      skill = skill.replace(/^#\s+.+/m, `# ${name} — AaaS Service Agent`);
      skill = skill.replace(/\*\*Name:\*\*\s+.+/, `**Name:** ${name}`);
    }

    if (description !== undefined) {
      skill = skill.replace(/\*\*Service:\*\*\s+.+/, `**Service:** ${description}`);
    }

    fs.writeFileSync(skillPath, skill);

    const aaasDir = path.join(wsPath, '.aaas');

    // Remove photo if requested
    if (req.body.removePhoto === 'true') {
      const existing = fs.readdirSync(aaasDir).filter(f => f.startsWith('avatar.'));
      for (const old of existing) fs.unlinkSync(path.join(aaasDir, old));
    }

    // Save uploaded photo (remove old avatar first)
    if (req.file) {
      const existing = fs.readdirSync(aaasDir).filter(f => f.startsWith('avatar.'));
      for (const old of existing) fs.unlinkSync(path.join(aaasDir, old));
      const ext = req.file.originalname.split('.').pop() || 'png';
      fs.writeFileSync(path.join(aaasDir, `avatar.${ext}`), req.file.buffer);
    }

    res.json({ ok: true });
  });

  // Delete workspace and its entire directory
  router.delete('/workspaces/:directory', (req, res) => {
    const { directory } = req.params;

    // Prevent path traversal
    if (directory.includes('..') || directory.includes('/') || directory.includes('\\')) {
      return res.status(400).json({ error: 'Invalid directory name' });
    }

    const wsPath = path.join(hubDir, directory);
    const skillPath = path.join(wsPath, 'skills', 'aaas', 'SKILL.md');

    if (!fs.existsSync(skillPath)) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    // Check if running
    const pidFile = path.join(wsPath, '.aaas', 'agent.pid');
    if (fs.existsSync(pidFile)) {
      return res.status(409).json({ error: 'Agent is currently running. Stop it first.' });
    }

    try {
      fs.rmSync(wsPath, { recursive: true, force: true });
      unregisterWorkspace(wsPath);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to delete: ' + err.message });
    }
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
    { value: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
    { value: 'claude-opus-4-5', label: 'Claude Opus 4.5' },
    { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
    { value: 'claude-opus-4-1', label: 'Claude Opus 4.1' },
    { value: 'claude-opus-4-0', label: 'Claude Opus 4' },
    { value: 'claude-sonnet-4-0', label: 'Claude Sonnet 4' },
  ],
  openai: [
    { value: 'gpt-5.4', label: 'GPT-5.4' },
    { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
    { value: 'gpt-5.4-nano', label: 'GPT-5.4 Nano' },
    { value: 'gpt-5.2', label: 'GPT-5.2' },
    { value: 'gpt-5.1', label: 'GPT-5.1' },
    { value: 'gpt-5', label: 'GPT-5' },
    { value: 'gpt-5-mini', label: 'GPT-5 Mini' },
    { value: 'gpt-5-nano', label: 'GPT-5 Nano' },
    { value: 'gpt-4.1', label: 'GPT-4.1' },
    { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
    { value: 'gpt-4o', label: 'GPT-4o' },
    { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
    { value: 'o3', label: 'o3' },
    { value: 'o4-mini', label: 'o4 Mini' },
  ],
  google: [
    { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (Preview)' },
    { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash (Preview)' },
    { value: 'gemini-3.1-flash-lite-preview', label: 'Gemini 3.1 Flash-Lite (Preview)' },
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite' },
  ],
  ollama: [
    { value: 'llama3.3', label: 'Llama 3.3' },
    { value: 'llama3.2', label: 'Llama 3.2' },
    { value: 'llama3.1', label: 'Llama 3.1' },
    { value: 'deepseek-r1', label: 'DeepSeek-R1' },
    { value: 'qwen3', label: 'Qwen 3' },
    { value: 'qwen2.5', label: 'Qwen 2.5' },
    { value: 'gemma3', label: 'Gemma 3' },
    { value: 'gemma2', label: 'Gemma 2' },
    { value: 'phi4', label: 'Phi-4' },
    { value: 'phi3', label: 'Phi-3' },
    { value: 'mistral', label: 'Mistral' },
    { value: 'gpt-oss', label: 'GPT-OSS' },
  ],
  openrouter: [
    { value: 'openai/gpt-5.4', label: 'OpenAI: GPT-5.4' },
    { value: 'openai/gpt-5.2', label: 'OpenAI: GPT-5.2' },
    { value: 'openai/gpt-5.3-chat', label: 'OpenAI: GPT-5.3 Chat' },
    { value: 'anthropic/claude-opus-4.6', label: 'Anthropic: Claude Opus 4.6' },
    { value: 'anthropic/claude-sonnet-4.6', label: 'Anthropic: Claude Sonnet 4.6' },
    { value: 'google/gemini-3.1-pro-preview', label: 'Google: Gemini 3.1 Pro' },
    { value: 'google/gemini-3-flash-preview', label: 'Google: Gemini 3 Flash' },
    { value: 'qwen/qwen3.6-plus', label: 'Qwen: Qwen 3.6 Plus' },
    { value: 'x-ai/grok-4.20', label: 'xAI: Grok 4.20' },
    { value: 'z-ai/glm-5', label: 'Z.ai: GLM 5' },
    { value: 'mistralai/mistral-small-2603', label: 'Mistral: Mistral Small 4' },
  ],
  azure: [
    { value: 'gpt-5.4', label: 'GPT-5.4' },
    { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
    { value: 'gpt-5.4-nano', label: 'GPT-5.4 Nano' },
    { value: 'gpt-5.2', label: 'GPT-5.2' },
    { value: 'gpt-5.1', label: 'GPT-5.1' },
    { value: 'gpt-5', label: 'GPT-5' },
    { value: 'gpt-5-mini', label: 'GPT-5 Mini' },
    { value: 'gpt-5-nano', label: 'GPT-5 Nano' },
    { value: 'gpt-4.1', label: 'GPT-4.1' },
    { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
    { value: 'gpt-4o', label: 'GPT-4o' },
    { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
    { value: 'o3', label: 'o3' },
    { value: 'o4-mini', label: 'o4 Mini' },
  ],
  deepseek: [
    { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
    { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
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
