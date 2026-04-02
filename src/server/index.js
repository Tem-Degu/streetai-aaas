import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import { apiRouter } from './api.js';
import { hubRouter } from './hub.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function startServer(workspace, port, hubDir) {
  const app = express();
  const isHub = !workspace;

  // Parse JSON for all routes except upload endpoints
  app.use((req, res, next) => {
    if (req.path.endsWith('/data/upload') || req.path.endsWith('/chat/upload')) {
      return next();
    }
    express.json({ limit: '5mb' })(req, res, next);
  });
  app.use(express.urlencoded({ extended: true }));

  // Tell the frontend which mode we're in
  app.get('/api/mode', (req, res) => {
    res.json({ mode: isHub ? 'hub' : 'workspace' });
  });

  if (isHub) {
    // Hub API
    const hub = hubRouter(hubDir);
    app.use('/api/hub', hub);

    // Mount hub config/credentials/models at /api/ so the Settings page works in hub mode
    app.use('/api', hub);

    // Workspace API — route /api/ws/<name>/... to workspace-specific API routers
    const wsRouterCache = {};
    app.use('/api/ws', (req, res, next) => {
      // req.url is like '/Lyon/overview' or '/Lyon/skill'
      const match = req.url.match(/^\/([^/]+)(\/.*)?$/);
      if (!match) return res.status(400).json({ error: 'No workspace specified' });

      const wsName = match[1];
      const remainingPath = match[2] || '/';

      const wsPath = path.join(hubDir, wsName);
      const skillPath = path.join(wsPath, 'skills', 'aaas', 'SKILL.md');

      if (!fs.existsSync(skillPath)) {
        return res.status(404).json({ error: `Workspace "${wsName}" not found` });
      }

      // Create and cache the router for this workspace
      if (!wsRouterCache[wsName]) {
        wsRouterCache[wsName] = apiRouter(wsPath);
      }

      // Rewrite req.url so the workspace router sees just the remaining path
      const originalUrl = req.url;
      req.url = remainingPath;
      wsRouterCache[wsName](req, res, (err) => {
        req.url = originalUrl; // restore on fallthrough
        next(err);
      });
    });
  } else {
    // Workspace mode — existing behavior
    app.use('/api', apiRouter(workspace));
  }

  // Serve dashboard static files
  const dashboardDist = path.join(__dirname, '..', '..', 'dashboard', 'dist');
  app.use(express.static(dashboardDist));

  // SPA fallback
  app.get('*', (req, res) => {
    res.sendFile(path.join(dashboardDist, 'index.html'));
  });

  app.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log(chalk.green(`  Dashboard running at ${chalk.bold(url)}\n`));

    // Try to open browser
    import('open').then(mod => mod.default(url)).catch(() => {});
  });
}
