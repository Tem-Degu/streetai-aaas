import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { getWorkspacePaths, readJson, readText, writeJson, listFiles, fileStats, formatBytes } from '../utils/workspace.js';
import { getProviderCredential, setProviderCredential, removeProviderCredential, listProviders, maskApiKey } from '../auth/credentials.js';
import { listConnections, loadConnection, saveConnection, removeConnection } from '../auth/connections.js';
import { AgentEngine } from '../engine/index.js';
import { extractFiles } from '../connectors/media.js';


const __api_dirname = path.dirname(fileURLToPath(import.meta.url));

export function apiRouter(workspace) {
  const router = express.Router();
  const paths = getWorkspacePaths(workspace);

  // ─── Overview ────────────────────────────────────

  router.get('/overview', (req, res) => {
    const skill = readText(paths.skill) || '';
    const nameMatch = skill.match(/^#\s+(.+?)(?:\s*—|\s*-|\n)/m);
    const agentName = nameMatch ? nameMatch[1].trim() : path.basename(workspace);

    // Data stats
    const dataFiles = listFiles(paths.data).filter(f => f !== '.gitkeep');
    let totalRecords = 0;
    let totalDataSize = 0;
    for (const f of dataFiles) {
      const fp = path.join(paths.data, f);
      const stat = fileStats(fp);
      if (stat) totalDataSize += stat.size;
      if (f.endsWith('.json')) {
        const data = readJson(fp);
        if (Array.isArray(data)) totalRecords += data.length;
      }
    }

    // Transaction stats
    const activeTxns = loadAllTransactions(paths, false);
    const allTxns = loadAllTransactions(paths, true);
    const completed = allTxns.filter(t => t.status === 'completed');
    const disputed = allTxns.filter(t => t.status === 'disputed' || t.dispute);
    const totalRevenue = completed.reduce((sum, t) => sum + (t.cost || 0), 0);
    const ratings = allTxns.filter(t => t.rating).map(t => t.rating);
    const avgRating = ratings.length > 0
      ? (ratings.reduce((s, r) => s + r, 0) / ratings.length).toFixed(1)
      : null;
    const archivedCount = allTxns.length - activeTxns.length;
    const successRate = archivedCount > 0
      ? Math.round((completed.length / archivedCount) * 100)
      : 0;

    // Extensions
    const registry = readJson(paths.extensions);
    const extCount = registry?.extensions?.length || 0;

    // Detect currency from transactions
    const currencyCounts = {};
    for (const t of allTxns) {
      if (t.currency) currencyCounts[t.currency] = (currencyCounts[t.currency] || 0) + 1;
    }
    const currency = Object.entries(currencyCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';

    // Memory facts count
    const factsData = readJson(path.join(paths.memory, 'facts.json'));
    const factsCount = Array.isArray(factsData) ? factsData.length : 0;

    // Sessions & messages (lifetime)
    let sessionCount = 0;
    let messageCount = 0;
    const sessionsDir = path.join(workspace, '.aaas', 'sessions');
    if (fs.existsSync(sessionsDir)) {
      const sessionFiles = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
      sessionCount = sessionFiles.length;
      for (const f of sessionFiles) {
        const s = readJson(path.join(sessionsDir, f));
        if (s && Array.isArray(s.messages)) messageCount += s.messages.length;
      }
    }

    res.json({
      name: agentName,
      workspace,
      skill: {
        exists: !!skill,
        size: fileStats(paths.skill)?.size || 0,
        modified: fileStats(paths.skill)?.modified
      },
      data: {
        files: dataFiles.length,
        records: totalRecords,
        size: totalDataSize
      },
      transactions: {
        active: activeTxns.length,
        completed: completed.length,
        disputed: disputed.length,
        total: allTxns.length,
        revenue: totalRevenue,
        currency,
        successRate,
        avgRating: avgRating ? parseFloat(avgRating) : null,
        ratingCount: ratings.length
      },
      extensions: extCount,
      memory: factsCount,
      sessions: sessionCount,
      messages: messageCount
    });
  });

  // ─── Skill ───────────────────────────────────────

  router.get('/skill', (req, res) => {
    const content = readText(paths.skill);
    if (!content) return res.status(404).json({ error: 'SKILL.md not found' });
    res.json({ content, path: paths.skill });
  });

  router.put('/skill', (req, res) => {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'content required' });
    fs.writeFileSync(paths.skill, content);
    res.json({ ok: true });
  });

  // ─── SOUL ────────────────────────────────────────

  router.get('/soul', (req, res) => {
    const content = readText(paths.soul);
    res.json({ content: content || '', path: paths.soul });
  });

  router.put('/soul', (req, res) => {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'content required' });
    fs.writeFileSync(paths.soul, content);
    res.json({ ok: true });
  });

  // ─── Data (File Explorer) ────────────────────────

  // Serve raw files from data/ directory (registered before /data/* to avoid conflict)
  router.get('/data/file/*', (req, res) => {
    const relPath = req.params[0];
    if (!relPath) return res.status(400).json({ error: 'path required' });
    const fp = path.resolve(paths.data, relPath);
    if (!fp.startsWith(path.resolve(paths.data))) return res.status(403).json({ error: 'Invalid path' });
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File not found' });
    res.sendFile(fp);
  });

  // List directory contents (supports subpaths via query param)
  router.get('/data', (req, res) => {
    const subpath = req.query.path || '';
    const dir = path.join(paths.data, subpath);

    if (!dir.startsWith(paths.data)) return res.status(400).json({ error: 'Invalid path' });
    if (!fs.existsSync(dir)) return res.json([]);

    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => !e.name.startsWith('.'))
      .map(e => {
        const fp = path.join(dir, e.name);
        const stat = fileStats(fp);
        const entry = {
          name: e.name,
          path: subpath ? `${subpath}/${e.name}` : e.name,
          type: e.isDirectory() ? 'folder' : 'file',
          size: stat?.size || 0,
          modified: stat?.modified,
        };
        if (!e.isDirectory() && e.name.endsWith('.json')) {
          const data = readJson(fp);
          if (Array.isArray(data)) entry.records = data.length;
        }
        return entry;
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    res.json(entries);
  });

  // Read a file (supports nested paths)
  router.get('/data/*', (req, res) => {
    const relPath = req.params[0];
    if (!relPath) return res.status(400).json({ error: 'path required' });
    const fp = path.join(paths.data, relPath);

    if (!fp.startsWith(paths.data)) return res.status(400).json({ error: 'Invalid path' });
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File not found' });

    const stat = fs.statSync(fp);
    if (stat.isDirectory()) return res.status(400).json({ error: 'Use GET /data?path= for directories' });

    if (relPath.endsWith('.json')) {
      const data = readJson(fp);
      res.json({ name: path.basename(relPath), path: relPath, data });
    } else {
      const content = readText(fp);
      res.json({ name: path.basename(relPath), path: relPath, content });
    }
  });

  // Update a file
  router.put('/data/*', (req, res) => {
    const relPath = req.params[0];
    if (!relPath) return res.status(400).json({ error: 'path required' });
    const fp = path.join(paths.data, relPath);
    if (!fp.startsWith(paths.data)) return res.status(400).json({ error: 'Invalid path' });

    fs.mkdirSync(path.dirname(fp), { recursive: true });
    if (relPath.endsWith('.json')) {
      writeJson(fp, req.body.data);
    } else {
      fs.writeFileSync(fp, req.body.content || '');
    }
    res.json({ ok: true });
  });

  // Create file or folder
  router.post('/data', (req, res) => {
    const { filename, folder, parentPath } = req.body;
    const parent = path.join(paths.data, parentPath || '');
    if (!parent.startsWith(paths.data)) return res.status(400).json({ error: 'Invalid path' });

    if (folder) {
      // Create folder
      const safe = folder.replace(/[^a-zA-Z0-9_\-\.]/g, '');
      if (!safe) return res.status(400).json({ error: 'Invalid folder name' });
      const fp = path.join(parent, safe);
      if (fs.existsSync(fp)) return res.status(409).json({ error: 'Folder already exists' });
      fs.mkdirSync(fp, { recursive: true });
      res.json({ ok: true, name: safe, type: 'folder' });
    } else if (filename) {
      // Create file
      const safe = filename.replace(/[^a-zA-Z0-9_\-\.]/g, '');
      if (!safe) return res.status(400).json({ error: 'Invalid filename' });
      const fp = path.join(parent, safe);
      if (fs.existsSync(fp)) return res.status(409).json({ error: 'File already exists' });
      if (safe.endsWith('.json')) {
        writeJson(fp, []);
      } else {
        fs.writeFileSync(fp, '');
      }
      res.json({ ok: true, name: safe, type: 'file' });
    } else {
      return res.status(400).json({ error: 'filename or folder required' });
    }
  });

  // Upload file
  router.post('/data/upload', express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
    const parentPath = req.headers['x-path'] || '';
    const originalName = req.headers['x-filename'] || 'file';
    const parent = path.join(paths.data, parentPath);
    if (!parent.startsWith(paths.data)) return res.status(400).json({ error: 'Invalid path' });

    fs.mkdirSync(parent, { recursive: true });
    const safe = originalName.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
    const fp = path.join(parent, safe);
    fs.writeFileSync(fp, req.body);

    res.json({
      ok: true,
      name: safe,
      path: parentPath ? `${parentPath}/${safe}` : safe,
      size: req.body.length,
    });
  });

  // Delete file or folder
  router.delete('/data/*', (req, res) => {
    const relPath = req.params[0];
    if (!relPath) return res.status(400).json({ error: 'path required' });
    const fp = path.join(paths.data, relPath);
    if (!fp.startsWith(paths.data)) return res.status(400).json({ error: 'Invalid path' });
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });

    const stat = fs.statSync(fp);
    if (stat.isDirectory()) {
      fs.rmSync(fp, { recursive: true });
    } else {
      fs.unlinkSync(fp);
    }
    res.json({ ok: true });
  });

  // ─── Transactions ────────────────────────────────

  router.get('/transactions', (req, res) => {
    const includeArchived = req.query.all === 'true';
    const status = req.query.status;
    let txns = loadAllTransactions(paths, includeArchived);
    if (status) txns = txns.filter(t => t.status === status);
    res.json(txns);
  });

  router.get('/transactions/:id', (req, res) => {
    const txn = findTransaction(paths, req.params.id);
    if (!txn) return res.status(404).json({ error: 'Transaction not found' });
    res.json(txn);
  });

  router.get('/transactions-stats', (req, res) => {
    const all = loadAllTransactions(paths, true);
    const active = loadAllTransactions(paths, false);
    const completed = all.filter(t => t.status === 'completed');
    const disputed = all.filter(t => t.status === 'disputed' || t.dispute);
    const totalRevenue = completed.reduce((sum, t) => sum + (t.cost || 0), 0);
    const ratings = all.filter(t => t.rating).map(t => t.rating);
    const avgRating = ratings.length > 0
      ? parseFloat((ratings.reduce((s, r) => s + r, 0) / ratings.length).toFixed(1))
      : null;

    // Revenue by service
    const byService = {};
    for (const t of completed) {
      const svc = t.service || 'Unknown';
      byService[svc] = (byService[svc] || 0) + (t.cost || 0);
    }

    // Status breakdown
    const byStatus = {};
    for (const t of all) {
      byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    }

    // Detect currency from transactions (most common wins)
    const currencyCounts = {};
    for (const t of all) {
      if (t.currency) currencyCounts[t.currency] = (currencyCounts[t.currency] || 0) + 1;
    }
    const currency = Object.entries(currencyCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';

    res.json({
      total: all.length,
      active: active.length,
      completed: completed.length,
      disputed: disputed.length,
      revenue: totalRevenue,
      currency,
      avgRating,
      ratingCount: ratings.length,
      byService,
      byStatus
    });
  });

  // ─── Transaction View Config ─────────────────────
  router.get('/transaction-view', (req, res) => {
    const config = readJson(paths.transactionView);
    res.json(config || {});
  });

  // ─── Extensions ──────────────────────────────────

  router.get('/extensions', (req, res) => {
    const registry = readJson(paths.extensions);
    res.json(registry?.extensions || []);
  });

  router.put('/extensions', (req, res) => {
    writeJson(paths.extensions, { extensions: req.body });
    res.json({ ok: true });
  });

  // ─── Memory ──────────────────────────────────────

  router.get('/memory', (req, res) => {
    const files = listFiles(paths.memory, '.md');
    const result = files.map(f => {
      const fp = path.join(paths.memory, f);
      const stat = fileStats(fp);
      return {
        name: f,
        size: stat?.size || 0,
        modified: stat?.modified
      };
    });
    res.json(result);
  });

  router.get('/memory/facts', (req, res) => {
    const factsData = readJson(path.join(paths.memory, 'facts.json'));
    const facts = Array.isArray(factsData) ? factsData : [];
    // Return sorted by most recent first
    const sorted = [...facts].sort((a, b) => {
      const dateA = new Date(a.updatedAt || a.createdAt || 0);
      const dateB = new Date(b.updatedAt || b.createdAt || 0);
      return dateB - dateA;
    });
    res.json(sorted);
  });

  router.get('/memory/:file', (req, res) => {
    if (req.params.file === 'facts') return; // handled above
    const fp = path.join(paths.memory, req.params.file);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File not found' });
    res.json({ name: req.params.file, content: readText(fp) });
  });

  // ─── Chat ───────────────────────────────────────

  let engine = null;

  async function getEngine() {
    if (engine?.initialized) return engine;

    const config = readJson(path.join(workspace, '.aaas', 'config.json'));
    if (!config?.provider) {
      throw new Error('No LLM configured. Go to Settings to configure a provider.');
    }

    const eng = new AgentEngine({ workspace, provider: config.provider, config });
    await eng.initialize();
    engine = eng;
    return engine;
  }

  // File upload for chat
  const uploadsDir = path.join(workspace, '.aaas', 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });

  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, uploadsDir),
      filename: (req, file, cb) => {
        const id = crypto.randomBytes(6).toString('hex');
        const safe = file.originalname.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
        cb(null, `${id}_${safe}`);
      },
    }),
    limits: { fileSize: 20 * 1024 * 1024 },
  });

  router.post('/chat/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    res.json({
      id: req.file.filename,
      name: req.file.originalname,
      size: req.file.size,
      path: req.file.path,
    });
  });

  // Serve uploaded files
  router.get('/chat/files/:id', (req, res) => {
    const fp = path.join(uploadsDir, req.params.id);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File not found' });
    res.sendFile(fp);
  });

  // Serve raw files relative to the workspace root (for images, media, documents)
  router.get('/workspace/*', (req, res) => {
    const relPath = req.params[0];
    if (!relPath) return res.status(400).json({ error: 'path required' });
    const fp = path.resolve(workspace, relPath);
    if (!fp.startsWith(path.resolve(workspace))) return res.status(403).json({ error: 'Invalid path' });
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File not found' });
    res.sendFile(fp);
  });

  router.post('/chat', async (req, res) => {
    const { message, files, mode } = req.body;
    if (!message && (!files || files.length === 0)) {
      return res.status(400).json({ error: 'message or files required' });
    }

    try {
      const eng = await getEngine();

      // Build message content — only pass file metadata/paths to LLM, not contents
      let fullMessage = message || '';
      const processedFiles = [];
      if (files && files.length > 0) {
        const fileMeta = [];
        for (const f of files) {
          const fp = path.join(uploadsDir, f.id);
          if (!fs.existsSync(fp)) continue;

          const ext = path.extname(f.name).toLowerCase();
          const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];
          const type = imageExts.includes(ext) ? 'image' : 'file';
          processedFiles.push({ id: f.id, name: f.name, size: f.size, type });
          fileMeta.push(`- ${f.name} (${formatBytes(f.size)}) → path: ${fp}`);
        }
        if (fileMeta.length > 0) {
          fullMessage += `\n\n[Attached files — use workspace tools to move/copy these to your data/ directory if needed]\n${fileMeta.join('\n')}`;
        }
      }

      const result = await eng.processChat(fullMessage, { mode: mode || 'admin' });

      // Extract file references from the agent's response so they render as
      // real attachments instead of broken markdown image links.
      const { cleanText, files: responseFiles } = extractFiles(workspace, result.response);
      const responseAttachments = responseFiles.map(f => {
        const url = f.url
          ? f.url
          : `/api/workspace/${path.relative(workspace, f.absPath).replace(/\\/g, '/')}`;
        return { url, name: f.filename, type: f.type, mimeType: f.mimeType, alt: f.alt };
      });

      res.json({
        response: cleanText,
        toolsUsed: result.toolsUsed,
        tokensUsed: result.tokensUsed,
        files: [...processedFiles, ...responseAttachments],
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Load chat history from session file
  router.get('/chat/history', (req, res) => {
    const { mode } = req.query;
    const userId = mode === 'customer' ? 'customer' : 'owner';
    const sessionFile = path.join(workspace, '.aaas', 'sessions', `local_${userId}.json`);
    if (!fs.existsSync(sessionFile)) return res.json({ messages: [] });
    const session = readJson(sessionFile) || {};
    const messages = (session.messages || [])
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => {
        const rawContent = typeof m.content === 'string' ? m.content : (m.content || '');
        // Extract file references from past assistant messages so historical
        // markdown image links render as real attachments too.
        if (m.role === 'assistant' && rawContent) {
          const { cleanText, files } = extractFiles(workspace, rawContent);
          const attachments = files.map(f => {
            const url = f.url
              ? f.url
              : `/api/workspace/${path.relative(workspace, f.absPath).replace(/\\/g, '/')}`;
            return { url, name: f.filename, type: f.type, mimeType: f.mimeType, alt: f.alt };
          });
          return { role: m.role, content: cleanText, files: attachments, at: m.at };
        }
        return { role: m.role, content: rawContent, at: m.at };
      });
    res.json({ messages });
  });

  // Debug: get last context sent to LLM
  router.get('/chat/debug', (req, res) => {
    const debugFile = path.join(workspace, '.aaas', 'debug', 'last_context.json');
    if (!fs.existsSync(debugFile)) return res.json({ error: 'No debug data yet. Send a chat message first.' });
    res.json(JSON.parse(fs.readFileSync(debugFile, 'utf-8')));
  });

  // Clear chat session history
  router.delete('/chat/session', (req, res) => {
    const { mode } = req.query;
    const sessionsDir = path.join(workspace, '.aaas', 'sessions');
    if (!fs.existsSync(sessionsDir)) return res.json({ ok: true, message: 'No sessions to clear.' });

    const userId = mode === 'customer' ? 'customer' : 'owner';
    const sessionFile = path.join(sessionsDir, `local_${userId}.json`);

    if (fs.existsSync(sessionFile)) {
      const session = readJson(sessionFile) || {};
      session.messages = [];
      session.summary = null;
      writeJson(sessionFile, session);
    }

    // Also reset the in-memory session if engine is initialized
    if (engine?.initialized && engine.sessionManager) {
      try { engine.sessionManager.clearSession('local', userId); } catch { /* may not exist */ }
    }

    res.json({ ok: true, message: `Session cleared for ${mode || 'admin'} mode.` });
  });

  // ─── Config ────────────────────────────────────

  router.get('/config', (req, res) => {
    let config = readJson(path.join(workspace, '.aaas', 'config.json')) || {};
    // If no provider configured, inherit from hub (parent directory) config
    if (!config.provider) {
      const hubConfig = readJson(path.join(workspace, '..', '.aaas', 'config.json'));
      if (hubConfig?.provider) {
        config = { ...hubConfig, ...config };
      }
    }
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
    const configPath = path.join(workspace, '.aaas', 'config.json');
    const current = readJson(configPath) || {};
    const updated = { ...current, ...req.body };
    writeJson(configPath, updated);
    engine = null; // Reset engine to pick up new config
    res.json({ ok: true });
  });

  // ─── Credentials ──────────────────────────────

  router.post('/credentials', (req, res) => {
    const { provider, apiKey, endpoint, baseUrl } = req.body;
    if (!provider) return res.status(400).json({ error: 'provider required' });
    if (provider !== 'ollama' && !apiKey) return res.status(400).json({ error: 'apiKey required' });

    const credential = { type: 'api_key' };
    if (apiKey) credential.apiKey = apiKey;
    if (endpoint) credential.endpoint = endpoint;
    if (baseUrl) credential.baseUrl = baseUrl;

    setProviderCredential(provider, credential);
    engine = null;
    res.json({ ok: true });
  });

  router.delete('/credentials/:provider', (req, res) => {
    const removed = removeProviderCredential(req.params.provider);
    if (!removed) return res.status(404).json({ error: 'Provider not found' });
    engine = null;
    res.json({ ok: true });
  });

  // ─── Models ──────────────────────────────────

  router.get('/models/:provider', (req, res) => {
    const models = PROVIDER_MODELS[req.params.provider];
    if (!models) return res.json([]);
    res.json(models);
  });

  // ─── OAuth ───────────────────────────────────

  // OAuth state tracking (in-memory for the session)
  const oauthStates = new Map();

  router.post('/oauth/start', (req, res) => {
    const { provider, clientId, tenantId } = req.body;
    if (!provider) return res.status(400).json({ error: 'provider required' });

    const oauthConfig = OAUTH_PROVIDERS[provider];
    if (!oauthConfig) return res.status(400).json({ error: `OAuth not available for ${provider}. Only Google and Azure support OAuth.` });
    if (!clientId) return res.status(400).json({ error: 'clientId required — register an OAuth app with the provider first' });

    const state = crypto.randomBytes(16).toString('hex');
    const redirectUri = 'http://localhost:19836/oauth/callback';

    // Azure requires tenant ID in the URL
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
    // Google needs access_type=offline to get refresh token
    if (provider === 'google') params.append('access_type', 'offline');

    oauthStates.set(state, { provider, clientId, redirectUri, tokenUrl });

    // Auto-expire state after 5 minutes
    setTimeout(() => oauthStates.delete(state), 5 * 60 * 1000);

    res.json({
      authUrl: `${authUrl}?${params.toString()}`,
      state,
    });
  });

  router.post('/oauth/exchange', async (req, res) => {
    const { redirectUrl, state } = req.body;
    if (!redirectUrl || !state) return res.status(400).json({ error: 'redirectUrl and state required' });

    const oauthState = oauthStates.get(state);
    if (!oauthState) return res.status(400).json({ error: 'Invalid or expired OAuth state. Start the flow again.' });

    try {
      // Extract code from redirect URL
      const url = new URL(redirectUrl);
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');

      if (!code) return res.status(400).json({ error: 'No authorization code found in the URL. Make sure you copied the full redirect URL.' });
      if (returnedState && returnedState !== state) return res.status(400).json({ error: 'OAuth state mismatch' });

      // Exchange code for tokens
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

      // Save as credential
      setProviderCredential(oauthState.provider, {
        type: 'oauth',
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || null,
        expiresAt: tokens.expires_in
          ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
          : null,
        apiKey: tokens.access_token, // Use access token as API key
      });

      oauthStates.delete(state);
      engine = null;
      res.json({ ok: true, provider: oauthState.provider });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ─── Connections ───────────────────────────────

  router.get('/connections', (req, res) => {
    res.json(listConnections(workspace));
  });

  router.post('/connections/:platform', async (req, res) => {
    const { platform } = req.params;
    const validPlatforms = ['truuze', 'http', 'openclaw', 'telegram', 'discord', 'slack', 'whatsapp', 'relay'];
    if (!validPlatforms.includes(platform)) {
      return res.status(400).json({ error: `Invalid platform. Use: ${validPlatforms.join(', ')}` });
    }

    try {
      if (platform === 'truuze') {
        const { token, agentKey, baseUrl, skillContent } = req.body;
        const PLATFORM_API_KEY = '4a3b2c9d1e4f5a6b7c8d9e0f123456789abcdef0123456789abcdef01234567';

        if (skillContent) {
          // Parse SKILL.md frontmatter to extract token and API URL
          const parsed = parseTruuzeSkill(skillContent);
          if (!parsed) return res.status(400).json({ error: 'Could not parse SKILL.md. Make sure it has valid frontmatter with metadata.' });

          const url = parsed.apiBase || baseUrl || 'https://origin.truuze.com/api/v1';
          const provToken = parsed.provisioningToken;

          if (!provToken || provToken === 'N/A - already onboarded') {
            return res.status(400).json({ error: 'This SKILL.md does not contain a valid provisioning token. It may have already been used. Use "Existing agent key" mode instead.' });
          }

          // Sign up using the parsed token (only pass agent identity fields, not skillContent)
          const { username, first_name, last_name, job_title, email, agent_provider, agent_description } = req.body;
          // Generate a username if not provided
          const agentUsername = username || `agent_${Date.now().toString(36)}`;
          const signupBody = {
            provisioning_token: provToken,
            username: agentUsername,
            first_name: first_name || 'AaaS',
            last_name: last_name || 'Agent',
            email: email || `${agentUsername}@agent.aaas.local`,
          };
          if (job_title) signupBody.job_title = job_title;
          if (agent_provider) signupBody.agent_provider = agent_provider;
          if (agent_description) signupBody.agent_description = agent_description;

          const signupUrl = `${url}/account/create/agent/`;
          console.log('[truuze-connect] Signing up at:', signupUrl);
          console.log('[truuze-connect] Body:', JSON.stringify(signupBody, null, 2));

          const resp = await fetch(signupUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Api-Key': PLATFORM_API_KEY },
            body: JSON.stringify(signupBody),
          });
          if (!resp.ok) {
            const rawText = await resp.text();
            console.log('[truuze-connect] Signup failed:', resp.status, rawText.slice(0, 500));
            let err = {};
            try { err = JSON.parse(rawText); } catch {}
            const msg = err.detail || err.provisioning_token?.[0] || err.username?.[0] || err.email?.[0]
              || (typeof err === 'object' && Object.keys(err).length > 0 ? Object.values(err).flat().join('; ') : null)
              || `Signup failed (${resp.status}): ${rawText.slice(0, 200)}`;
            return res.status(400).json({ error: msg });
          }
          const data = await resp.json();
          console.log('[truuze-connect] Signup success, agent ID:', data.id);

          saveConnection(workspace, 'truuze', {
            baseUrl: url,
            agentKey: data.api_key,
            platformApiKey: PLATFORM_API_KEY,
            agentId: data.id,
            agentUsername: data.username,
            agentName: data.name || `${data.first_name || ''} ${data.last_name || ''}`.trim(),
            agentProvider: data.agent_provider,
            agentDescription: data.agent_description,
            avatarBgColor: data.avatar_bg_color,
            jobTitle: data.job_title,
            ownerUsername: data.owner_username,
            heartbeatInterval: 30,
            connectedAt: new Date().toISOString(),
          });

          // Fetch the appropriate skill template from the refresh endpoint
          const skillPath = path.join(workspace, 'skills', 'truuze', 'SKILL.md');
          fs.mkdirSync(path.dirname(skillPath), { recursive: true });
          const wsConfig = readJson(path.join(workspace, '.aaas', 'config.json')) || {};
          const agentType = wsConfig.agentType || 'service';
          try {
            const refreshUrl = `${url}/account/agent/skills/refresh/?type=${agentType}`;
            console.log('[truuze-connect] Fetching skill from:', refreshUrl);
            const skillResp = await fetch(refreshUrl, {
              headers: { 'X-Agent-Key': data.api_key, 'X-Api-Key': PLATFORM_API_KEY },
            });
            console.log('[truuze-connect] Refresh response status:', skillResp.status);
            if (skillResp.ok) {
              const skillData = await skillResp.json();
              const refreshedSkill = skillData.content || skillData.skills_md;
              if (refreshedSkill) {
                console.log('[truuze-connect] Got refreshed skill, length:', refreshedSkill.length);
                fs.writeFileSync(skillPath, refreshedSkill);
              } else {
                console.log('[truuze-connect] No content in refresh response, saving original');
                fs.writeFileSync(skillPath, skillContent);
              }
            } else {
              const errText = await skillResp.text();
              console.log('[truuze-connect] Refresh failed:', errText.slice(0, 200));
              fs.writeFileSync(skillPath, skillContent);
            }
          } catch (err) {
            console.log('[truuze-connect] Refresh error:', err.message);
            fs.writeFileSync(skillPath, skillContent);
          }
        } else if (agentKey) {
          const url = baseUrl || 'https://origin.truuze.com/api/v1';
          // Verify existing key
          const resp = await fetch(`${url}/account/agent/profile/`, {
            headers: { 'X-Agent-Key': agentKey, 'X-Api-Key': PLATFORM_API_KEY },
          });
          if (!resp.ok) return res.status(400).json({ error: 'Invalid agent key' });
          const profile = await resp.json();

          // Also fetch account details for display info
          let accountData = {};
          try {
            const accResp = await fetch(`${url}/account/agent/updates/`, {
              headers: { 'X-Agent-Key': agentKey, 'X-Api-Key': PLATFORM_API_KEY },
            });
            if (accResp.ok) accountData = await accResp.json();
          } catch { /* non-critical */ }

          saveConnection(workspace, 'truuze', {
            baseUrl: url,
            agentKey,
            platformApiKey: PLATFORM_API_KEY,
            agentId: profile.agent || profile.id,
            agentUsername: accountData.username || profile.username,
            agentName: profile.bio ? undefined : `Agent #${profile.agent || profile.id}`,
            agentProvider: profile.agent_provider,
            agentDescription: profile.bio,
            avatarBgColor: profile.avatar_bg_color,
            ownerUsername: profile.owner_username || accountData.owner_username,
            heartbeatInterval: 30,
            connectedAt: new Date().toISOString(),
          });

          // Fetch the appropriate skill template from the refresh endpoint
          const wsConfig = readJson(path.join(workspace, '.aaas', 'config.json')) || {};
          const agentType = wsConfig.agentType || 'service';
          try {
            const skillResp = await fetch(`${url}/account/agent/skills/refresh/?type=${agentType}`, {
              headers: { 'X-Agent-Key': agentKey, 'X-Api-Key': PLATFORM_API_KEY },
            });
            if (skillResp.ok) {
              const skillData = await skillResp.json();
              const refreshedSkill = skillData.content || skillData.skills_md;
              if (refreshedSkill) {
                const skillPath = path.join(workspace, 'skills', 'truuze', 'SKILL.md');
                fs.mkdirSync(path.dirname(skillPath), { recursive: true });
                fs.writeFileSync(skillPath, refreshedSkill);
              }
            }
          } catch { /* non-critical */ }
        } else if (token) {
          const url = baseUrl || 'https://origin.truuze.com/api/v1';
          // Signup with provisioning token (only pass agent identity fields)
          const { username, first_name, last_name, job_title, email, agent_provider, agent_description } = req.body;
          const agentUsername = username || `agent_${Date.now().toString(36)}`;
          const signupBody = {
            provisioning_token: token,
            username: agentUsername,
            first_name: first_name || 'AaaS',
            last_name: last_name || 'Agent',
            email: email || `${agentUsername}@agent.aaas.local`,
          };
          if (job_title) signupBody.job_title = job_title;
          if (agent_provider) signupBody.agent_provider = agent_provider;
          if (agent_description) signupBody.agent_description = agent_description;

          const resp = await fetch(`${url}/account/create/agent/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Api-Key': PLATFORM_API_KEY },
            body: JSON.stringify(signupBody),
          });
          if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            return res.status(400).json({ error: err.detail || err.provisioning_token?.[0] || 'Signup failed' });
          }
          const data = await resp.json();

          saveConnection(workspace, 'truuze', {
            baseUrl: url,
            agentKey: data.api_key,
            platformApiKey: PLATFORM_API_KEY,
            agentId: data.id,
            agentUsername: data.username,
            agentName: data.name || `${data.first_name || ''} ${data.last_name || ''}`.trim(),
            agentProvider: data.agent_provider,
            agentDescription: data.agent_description,
            avatarBgColor: data.avatar_bg_color,
            jobTitle: data.job_title,
            ownerUsername: data.owner_username,
            heartbeatInterval: 30,
            connectedAt: new Date().toISOString(),
          });

          // Fetch the appropriate skill template from the refresh endpoint
          const wsConfig3 = readJson(path.join(workspace, '.aaas', 'config.json')) || {};
          const agentType3 = wsConfig3.agentType || 'service';
          try {
            const skillResp = await fetch(`${url}/account/agent/skills/refresh/?type=${agentType3}`, {
              headers: { 'X-Agent-Key': data.api_key, 'X-Api-Key': PLATFORM_API_KEY },
            });
            if (skillResp.ok) {
              const skillData = await skillResp.json();
              const refreshedSkill = skillData.content || skillData.skills_md;
              if (refreshedSkill) {
                const skillPath = path.join(workspace, 'skills', 'truuze', 'SKILL.md');
                fs.mkdirSync(path.dirname(skillPath), { recursive: true });
                fs.writeFileSync(skillPath, refreshedSkill);
              }
            }
          } catch { /* non-critical */ }
        } else {
          return res.status(400).json({ error: 'Provide a SKILL.md, provisioning token, or agent key' });
        }
      } else if (platform === 'http') {
        const port = req.body.port || 3300;
        saveConnection(workspace, 'http', { port, connectedAt: new Date().toISOString() });
      } else if (platform === 'openclaw') {
        saveConnection(workspace, 'openclaw', { connectedAt: new Date().toISOString() });
      } else if (platform === 'telegram') {
        const { botToken } = req.body;
        if (!botToken) return res.status(400).json({ error: 'Bot token is required' });
        // Verify token
        const resp = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
        if (!resp.ok) return res.status(400).json({ error: 'Invalid bot token. Check your token from @BotFather.' });
        const data = await resp.json();
        saveConnection(workspace, 'telegram', {
          botToken,
          botUsername: data.result.username,
          botName: data.result.first_name,
          connectedAt: new Date().toISOString(),
        });
      } else if (platform === 'discord') {
        const { botToken } = req.body;
        if (!botToken) return res.status(400).json({ error: 'Bot token is required' });
        // Verify token
        const resp = await fetch('https://discord.com/api/v10/users/@me', {
          headers: { Authorization: `Bot ${botToken}` },
        });
        if (!resp.ok) return res.status(400).json({ error: 'Invalid bot token. Check your token from the Discord Developer Portal.' });
        const data = await resp.json();
        saveConnection(workspace, 'discord', {
          botToken,
          botUsername: data.username,
          botName: data.global_name || data.username,
          botId: data.id,
          connectedAt: new Date().toISOString(),
        });
      } else if (platform === 'whatsapp') {
        const { accessToken, phoneNumberId, verifyToken, port } = req.body;
        if (!accessToken) return res.status(400).json({ error: 'Access token is required' });
        if (!phoneNumberId) return res.status(400).json({ error: 'Phone Number ID is required' });
        if (!verifyToken) return res.status(400).json({ error: 'Verify token is required' });
        // Verify credentials
        const resp = await fetch(
          `https://graph.facebook.com/v21.0/${phoneNumberId}?fields=display_phone_number,verified_name`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (!resp.ok) return res.status(400).json({ error: 'Invalid access token or phone number ID.' });
        const data = await resp.json();
        saveConnection(workspace, 'whatsapp', {
          accessToken,
          phoneNumberId,
          verifyToken,
          port: port || 3301,
          businessName: data.verified_name || data.display_phone_number,
          phoneNumber: data.display_phone_number,
          connectedAt: new Date().toISOString(),
        });
      } else if (platform === 'slack') {
        const { botToken, appToken } = req.body;
        if (!botToken) return res.status(400).json({ error: 'Bot token (xoxb-...) is required' });
        if (!appToken) return res.status(400).json({ error: 'App-level token (xapp-...) is required' });
        // Verify bot token
        const resp = await fetch('https://slack.com/api/auth.test', {
          method: 'POST',
          headers: { Authorization: `Bearer ${botToken}` },
        });
        const data = await resp.json();
        if (!data.ok) return res.status(400).json({ error: `Invalid bot token: ${data.error}` });
        saveConnection(workspace, 'slack', {
          botToken,
          appToken,
          botUserId: data.user_id,
          botName: data.user,
          teamId: data.team_id,
          teamName: data.team,
          connectedAt: new Date().toISOString(),
        });
      } else if (platform === 'relay') {
        const { name } = req.body;
        if (!name) return res.status(400).json({ error: 'Agent name is required' });

        const relayBase = 'https://streetai.org';
        // Register with streetai.org relay
        const regResp = await fetch(`${relayBase}/relay/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        if (!regResp.ok) {
          const err = await regResp.json().catch(() => ({}));
          return res.status(400).json({ error: err.error || 'Relay registration failed' });
        }
        const regData = await regResp.json();

        // Configure WhatsApp webhook if WhatsApp is connected
        const waConn = loadConnection(workspace, 'whatsapp');
        if (waConn?.verifyToken) {
          await fetch(`${relayBase}/relay/configure`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              slug: regData.slug,
              relayKey: regData.relayKey,
              whatsapp: { verifyToken: waConn.verifyToken },
            }),
          });
        }

        const relayUrl = relayBase.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
        saveConnection(workspace, 'relay', {
          platform: 'relay',
          relayUrl,
          relayKey: regData.relayKey,
          slug: regData.slug,
          chatUrl: regData.chatUrl,
          widgetUrl: regData.widgetUrl,
          webhookUrl: regData.webhookUrl,
          connectedAt: new Date().toISOString(),
        });
      }

      engine = null;
      res.json({ ok: true, connections: listConnections(workspace) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.patch('/connections/truuze', async (req, res) => {
    try {
      const conn = loadConnection(workspace, 'truuze');
      if (!conn) return res.status(404).json({ error: 'Not connected to Truuze' });

      const { first_name, last_name, job_title, agent_description, agent_provider } = req.body;
      const PLATFORM_API_KEY = '4a3b2c9d1e4f5a6b7c8d9e0f123456789abcdef0123456789abcdef01234567';

      const patchFields = {};
      if (first_name !== undefined) patchFields.first_name = first_name;
      if (last_name !== undefined) patchFields.last_name = last_name;
      if (job_title !== undefined) patchFields.job_title = job_title;
      if (agent_provider !== undefined) patchFields.agent_provider = agent_provider;
      if (agent_description !== undefined) patchFields.agent_description = agent_description;

      if (Object.keys(patchFields).length > 0) {
        const resp = await fetch(`${conn.baseUrl}/account/agent/profile/`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'X-Agent-Key': conn.agentKey,
            'X-Api-Key': PLATFORM_API_KEY,
          },
          body: JSON.stringify(patchFields),
        });
        if (!resp.ok) {
          const err = await resp.text();
          return res.status(400).json({ error: `Failed to update: ${err.slice(0, 200)}` });
        }
      }

      // Update local config
      const updatedConfig = { ...conn };
      if (first_name !== undefined || last_name !== undefined) {
        const fn = first_name !== undefined ? first_name : (conn.agentName || '').split(' ')[0] || '';
        const ln = last_name !== undefined ? last_name : (conn.agentName || '').split(' ').slice(1).join(' ') || '';
        updatedConfig.agentName = `${fn} ${ln}`.trim();
      }
      if (job_title !== undefined) updatedConfig.jobTitle = job_title;
      if (agent_provider !== undefined) updatedConfig.agentProvider = agent_provider;
      if (agent_description !== undefined) updatedConfig.agentDescription = agent_description;
      saveConnection(workspace, 'truuze', updatedConfig);

      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/connections/:platform', (req, res) => {
    const removed = removeConnection(workspace, req.params.platform);
    if (!removed) return res.status(404).json({ error: 'Connection not found' });
    engine = null;
    res.json({ ok: true });
  });

  // ─── Engine Status ─────────────────────────────

  router.get('/engine-status', async (req, res) => {
    try {
      const eng = await getEngine();
      res.json(eng.getStatus());
    } catch (err) {
      res.json({ initialized: false, error: err.message });
    }
  });

  // ─── Deploy ───────────────────────────────────

  const activeConnectors = {};

  router.get('/deploy/status', (req, res) => {
    const connections = listConnections(workspace);
    const pidFile = path.join(workspace, '.aaas', 'agent.pid');
    const hasPid = fs.existsSync(pidFile);
    let daemonRunning = false;
    let daemonPid = null;

    if (hasPid) {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim());
      try {
        process.kill(pid, 0);
        daemonRunning = true;
        daemonPid = pid;
      } catch {
        // Stale PID file, clean up
        try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
      }
    }

    const platforms = connections.map(({ platform, config }) => {
      const connector = activeConnectors[platform];
      const skillPath = path.join(workspace, 'skills', platform, 'SKILL.md');
      const hasSkill = fs.existsSync(skillPath);
      return {
        platform,
        config,
        status: connector?.status || (daemonRunning ? 'daemon' : 'stopped'),
        error: connector?.error || null,
        hasSkill,
      };
    });

    const sessionRunning = Object.values(activeConnectors).some(c => c?.status === 'connected');
    res.json({ platforms, cliRunning: daemonRunning, daemonRunning, daemonPid, sessionRunning });
  });

  // Start a single platform in-process (legacy, for quick testing)
  router.post('/deploy/:platform/start', async (req, res) => {
    const { platform } = req.params;
    const connections = listConnections(workspace);
    const conn = connections.find(c => c.platform === platform);
    if (!conn) return res.status(404).json({ error: `No connection configured for ${platform}.` });

    if (activeConnectors[platform]?.status === 'connected') {
      return res.json({ ok: true, message: `${platform} already running.` });
    }

    try {
      const eng = await getEngine();
      const { loadConnector } = await import('../connectors/index.js');
      const ConnectorClass = await loadConnector(platform);
      if (!ConnectorClass) return res.status(400).json({ error: `No connector for ${platform}.` });

      const connector = new ConnectorClass({ ...conn.config, platform }, eng);
      await connector.connect();
      activeConnectors[platform] = connector;

      res.json({ ok: true, status: connector.status, message: `${platform} started.` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Stop a single platform in-process
  router.post('/deploy/:platform/stop', async (req, res) => {
    const { platform } = req.params;
    const connector = activeConnectors[platform];
    if (!connector) return res.json({ ok: true, message: `${platform} not running.` });

    try {
      await connector.disconnect();
      delete activeConnectors[platform];
      res.json({ ok: true, message: `${platform} stopped.` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Start agent as a background process (survives dashboard close)
  router.post('/deploy/agent/start-daemon', async (req, res) => {
    const pidFile = path.join(workspace, '.aaas', 'agent.pid');

    // Check if already running
    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim());
      try {
        process.kill(pid, 0);
        return res.json({ ok: true, pid, message: 'Agent already running in background.' });
      } catch {
        fs.unlinkSync(pidFile); // stale
      }
    }

    // Try daemon mode first
    try {
      const workerPath = path.join(__api_dirname, '..', 'cli', 'agent-worker.js');
      const logPath = path.join(workspace, '.aaas', 'agent.log');

      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      const out = fs.openSync(logPath, 'a');
      const err = fs.openSync(logPath, 'a');

      const child = spawn(process.execPath, [workerPath, workspace], {
        detached: true,
        stdio: ['ignore', out, err],
        cwd: workspace,
      });

      child.unref();

      // Wait briefly for PID file to confirm worker started
      await new Promise(resolve => setTimeout(resolve, 1500));

      if (fs.existsSync(pidFile)) {
        const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim());
        return res.json({ ok: true, pid, mode: 'daemon', message: 'Agent started in background.' });
      }
    } catch { /* daemon spawn failed — fall through to in-process */ }

    // Fallback: start all connectors in-process (won't survive dashboard close)
    try {
      const eng = await getEngine();
      const connections = listConnections(workspace);
      if (connections.length === 0) {
        return res.status(400).json({ error: 'No connections configured.' });
      }

      const { loadConnector } = await import('../connectors/index.js');
      let connected = 0;
      for (const conn of connections) {
        if (activeConnectors[conn.platform]?.status === 'connected') { connected++; continue; }
        try {
          const ConnectorClass = await loadConnector(conn.platform);
          if (!ConnectorClass) continue;
          const connector = new ConnectorClass({ ...conn.config, platform: conn.platform }, eng);
          await connector.connect();
          activeConnectors[conn.platform] = connector;
          connected++;
        } catch { /* skip failed connector */ }
      }

      if (connected === 0) {
        return res.status(500).json({ error: 'No connectors started successfully.' });
      }

      res.json({ ok: true, mode: 'session', message: `Agent running with ${connected} connection(s). Note: it will stop when you close this dashboard window.` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Stop the background agent process
  router.post('/deploy/agent/stop-daemon', (req, res) => {
    const pidFile = path.join(workspace, '.aaas', 'agent.pid');

    if (!fs.existsSync(pidFile)) {
      return res.json({ ok: true, message: 'Agent not running.' });
    }

    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim());

    try {
      process.kill(pid, 'SIGTERM');
      try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
      res.json({ ok: true, message: `Agent stopped (PID ${pid}).` });
    } catch {
      try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
      res.json({ ok: true, message: 'Agent was not running. Cleaned up.' });
    }
  });

  // Get background agent log
  router.get('/deploy/agent/log', (req, res) => {
    const logPath = path.join(workspace, '.aaas', 'agent.log');
    if (!fs.existsSync(logPath)) return res.json({ log: '' });
    const content = fs.readFileSync(logPath, 'utf-8');
    // Return last 100 lines
    const lines = content.split('\n').slice(-100).join('\n');
    res.json({ log: lines });
  });

  // Get pending owner verification codes
  router.get('/deploy/verify', (req, res) => {
    const verifyDir = path.join(workspace, '.aaas', 'verify');
    if (!fs.existsSync(verifyDir)) return res.json({ pending: [] });

    const pending = [];
    for (const f of fs.readdirSync(verifyDir).filter(f => f.endsWith('.json'))) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(verifyDir, f), 'utf-8'));
        // Only show codes less than 10 minutes old
        const age = Date.now() - new Date(data.requestedAt).getTime();
        if (age < 10 * 60 * 1000) {
          pending.push(data);
        } else {
          // Clean up expired codes
          fs.unlinkSync(path.join(verifyDir, f));
        }
      } catch { /* skip corrupt files */ }
    }
    res.json({ pending });
  });

  // ─── Platform Skills ──────────────────────────

  router.get('/deploy/skills', (req, res) => {
    const skillsDir = path.join(workspace, 'skills');
    const platforms = [];
    if (fs.existsSync(skillsDir)) {
      for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === 'aaas') continue;
        const skillPath = path.join(skillsDir, entry.name, 'SKILL.md');
        if (fs.existsSync(skillPath)) {
          const stat = fs.statSync(skillPath);
          platforms.push({
            platform: entry.name,
            size: stat.size,
            updatedAt: stat.mtime.toISOString(),
          });
        }
      }
    }
    res.json({ skills: platforms });
  });

  router.get('/deploy/skills/:platform', (req, res) => {
    const skillPath = path.join(workspace, 'skills', req.params.platform, 'SKILL.md');
    if (!fs.existsSync(skillPath)) return res.status(404).json({ error: 'No skill file for this platform' });
    res.json({ platform: req.params.platform, content: fs.readFileSync(skillPath, 'utf-8') });
  });

  router.delete('/deploy/skills/:platform', (req, res) => {
    const skillPath = path.join(workspace, 'skills', req.params.platform, 'SKILL.md');
    if (!fs.existsSync(skillPath)) return res.status(404).json({ error: 'No skill file for this platform' });
    fs.unlinkSync(skillPath);
    // Clean up empty dir
    const dir = path.dirname(skillPath);
    try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* ok */ }
    res.json({ ok: true });
  });

  return router;
}

// ─── Helpers ─────────────────────────────────────

/**
 * Parse a Truuze SKILL.md to extract connection details from frontmatter.
 * Returns { apiBase, provisioningToken, ownerUsername, ownerId } or null.
 */
function parseTruuzeSkill(content) {
  // Extract YAML frontmatter between --- markers
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;

  const frontmatter = fmMatch[1];

  // Extract metadata JSON from frontmatter
  const metaMatch = frontmatter.match(/metadata:\s*(\{[\s\S]*?\})\s*$/m);
  if (!metaMatch) return null;

  try {
    const metadata = JSON.parse(metaMatch[1]);
    return {
      apiBase: metadata.api_base || null,
      provisioningToken: metadata.provisioning_token || null,
      ownerUsername: metadata.owner_username || null,
      ownerId: metadata.owner_id || null,
    };
  } catch {
    return null;
  }
}

function loadAllTransactions(paths, includeArchived) {
  const txns = [];

  for (const f of listFiles(paths.activeTransactions, '.json')) {
    const data = readJson(path.join(paths.activeTransactions, f));
    if (data) txns.push({ ...data, _file: f, _location: 'active' });
  }

  if (includeArchived) {
    for (const f of listFiles(paths.archivedTransactions, '.json')) {
      const data = readJson(path.join(paths.archivedTransactions, f));
      if (data) txns.push({ ...data, _file: f, _location: 'archive' });
    }
  }

  return txns.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
}

function findTransaction(paths, id) {
  for (const dir of [paths.activeTransactions, paths.archivedTransactions]) {
    for (const f of listFiles(dir, '.json')) {
      const data = readJson(path.join(dir, f));
      if (!data) continue;
      if (data.id === id || f === id || f === `${id}.json`) {
        return data;
      }
    }
  }
  return null;
}

// ─── Provider Models ────────────────────────────

const PROVIDER_MODELS = {
  anthropic: [
    { value: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { value: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5' },
    { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
    { value: 'claude-opus-4-20250514', label: 'Claude Opus 4' },
    { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
  ],
  openai: [
    { value: 'gpt-5.4', label: 'GPT-5.4' },
    { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
    { value: 'o3', label: 'o3' },
    { value: 'o3-mini', label: 'o3 Mini' },
    { value: 'o4-mini', label: 'o4 Mini' },
    { value: 'gpt-5', label: 'GPT-5' },
    { value: 'gpt-4.1', label: 'GPT-4.1' },
    { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
  ],
  google: [
    { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (Preview)' },
    { value: 'gemini-3.1-flash-lite-preview', label: 'Gemini 3.1 Flash-Lite (Preview)' },
    { value: 'gemini-3.0-flash', label: 'Gemini 3.0 Flash' },
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
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
    { value: 'openai/gpt-5.4-mini', label: 'OpenAI: GPT-5.4 Mini' },
    { value: 'openai/o3', label: 'OpenAI: o3' },
    { value: 'openai/gpt-5', label: 'OpenAI: GPT-5' },
    { value: 'anthropic/claude-opus-4-6', label: 'Anthropic: Claude Opus 4.6' },
    { value: 'anthropic/claude-sonnet-4-6', label: 'Anthropic: Claude Sonnet 4.6' },
    { value: 'google/gemini-3.1-pro-preview', label: 'Google: Gemini 3.1 Pro' },
    { value: 'google/gemini-2.5-pro', label: 'Google: Gemini 2.5 Pro' },
    { value: 'mistralai/mistral-small-2603', label: 'Mistral: Mistral Small 4' },
  ],
  azure: [
    { value: 'gpt-5.4', label: 'GPT-5.4' },
    { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
    { value: 'o3', label: 'o3' },
    { value: 'o3-mini', label: 'o3 Mini' },
    { value: 'o4-mini', label: 'o4 Mini' },
    { value: 'gpt-5', label: 'GPT-5' },
    { value: 'gpt-4.1', label: 'GPT-4.1' },
    { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
  ],
};

// ─── OAuth Providers ────────────────────────────

// OAuth providers — uses the same redirect pattern as OpenClaw:
// 1. Generate auth URL with a fixed redirect URI
// 2. User opens URL, authorizes, gets redirected
// 3. User pastes the redirect URL back (since no local server is listening)
// 4. Backend extracts the code and exchanges for tokens
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
