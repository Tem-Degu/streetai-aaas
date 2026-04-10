import express from 'express';
import multer from 'multer';
import { createServer } from 'http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import crypto from 'crypto';
import { BaseConnector } from './index.js';
import { extractFiles, readFileBuffer } from './media.js';
import { writePlatformSkill } from '../utils/workspace.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HTTP_MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB per file

const UPLOAD_ALLOWED_PREFIXES = [
  'image/', 'audio/', 'video/',
  'application/pdf', 'text/plain',
];

function typeFromMime(mime) {
  if (!mime) return 'file';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'file';
}

/**
 * HTTP connector — exposes the agent as a REST API.
 * Simplest connector: request-response, no persistent connections.
 */
export default class HTTPConnector extends BaseConnector {
  constructor(config, engine) {
    super(config, engine);
    this.port = config.port || 3300;
    this.server = null;
  }

  get platformName() { return 'http'; }

  async connect() {
    this.status = 'connecting';
    this._writeSkill();

    const app = express();
    app.use(express.json());

    // Multer for multipart uploads on /chat (memory storage so we control where files land)
    const upload = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: HTTP_MAX_UPLOAD_BYTES },
    });

    // Allow cross-origin requests so websites can call the API
    app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });

    // Serve the embeddable chat widget
    app.get('/widget.js', (req, res) => {
      try {
        const widgetPath = join(__dirname, '..', 'widget', 'chat-widget.js');
        const widget = readFileSync(widgetPath, 'utf-8');
        res.set('Content-Type', 'application/javascript');
        res.set('Cache-Control', 'public, max-age=3600');
        res.send(widget);
      } catch (err) {
        res.status(404).send('// widget not found');
      }
    });

    // Serve workspace files (for file URLs returned in chat responses)
    app.get('/files/*', (req, res) => {
      const workspace = this.engine?.workspace;
      if (!workspace) return res.sendStatus(404);

      const relPath = req.params[0];
      const absPath = resolve(workspace, relPath);

      // Security: ensure the path is within the workspace
      if (!absPath.startsWith(resolve(workspace))) return res.sendStatus(403);
      if (!existsSync(absPath)) return res.sendStatus(404);

      res.sendFile(absPath);
    });

    // Upload endpoint — widget uploads files here before sending chat
    app.post('/upload',
      express.raw({ type: '*/*', limit: '20mb' }),
      (req, res) => {
        if (!req.body || req.body.length === 0) {
          return res.status(400).json({ error: 'Empty body' });
        }

        const mime = (req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
        const allowed = UPLOAD_ALLOWED_PREFIXES.some(p => mime.startsWith(p));
        if (!allowed) {
          return res.status(415).json({ error: `Unsupported type: ${mime}` });
        }

        const workspace = this.engine?.workspace;
        if (!workspace) return res.status(500).json({ error: 'No workspace' });

        const inboxDir = join(workspace, 'data', 'inbox');
        mkdirSync(inboxDir, { recursive: true });

        const originalName = decodeURIComponent(req.headers['x-filename'] || 'file');
        const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
        const filename = `widget_${Date.now()}_${safeName}`;
        const filePath = join(inboxDir, filename);

        try {
          writeFileSync(filePath, req.body);
        } catch (err) {
          console.error('[http] Upload write failed:', err.message);
          return res.status(500).json({ error: 'Write failed' });
        }

        const relativePath = `data/inbox/${filename}`;
        const type = typeFromMime(mime);
        const url = `${req.protocol}://${req.get('host')}/files/${relativePath}`;
        console.log(`[http] Widget upload: ${type} ${relativePath} (${req.body.length} bytes)`);
        res.json({ url, filename: originalName, mimeType: mime, size: req.body.length, path: relativePath, type });
      }
    );

    // Chat endpoint — accepts JSON or multipart/form-data (with optional files)
    app.post('/chat', upload.any(), async (req, res) => {
      const { message, userId, userName, attachments } = req.body;
      const uploaded = Array.isArray(req.files) ? req.files : [];
      const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
      if (!message && uploaded.length === 0 && !hasAttachments) {
        return res.status(400).json({ error: 'message or files required' });
      }

      const workspace = this.engine?.workspace;
      let content = message || '';

      // Save uploaded files to data/inbox/<safeUser>_<ts>_<safeName> like the other connectors
      if (uploaded.length > 0 && workspace) {
        try {
          const inboxDir = join(workspace, 'data', 'inbox');
          mkdirSync(inboxDir, { recursive: true });
          const safeUser = String(userId || req.ip || 'anonymous').replace(/[^a-zA-Z0-9._-]/g, '_');
          const savedFiles = [];
          for (const f of uploaded) {
            try {
              const originalName = f.originalname || `file_${Date.now()}`;
              const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
              const filename = `${safeUser}_${Date.now()}_${safeName}`;
              const filePath = join(inboxDir, filename);
              writeFileSync(filePath, f.buffer);
              const type = typeFromMime(f.mimetype);
              const relativePath = `data/inbox/${filename}`;
              savedFiles.push({ type, path: relativePath });
              console.log('[http] Saved upload:', type, relativePath, f.size, 'bytes');
            } catch (err) {
              console.error('[http] Failed to save upload:', f.originalname, err.message);
            }
          }
          if (savedFiles.length > 0) {
            const fileList = savedFiles.map(f => `${f.type}: ${f.path}`).join(', ');
            content = content
              ? `${content}\n\n[Attached files: ${fileList}]`
              : `[Attached files: ${fileList}]`;
          }
        } catch (err) {
          console.error('[http] Inbox write error:', err.message);
        }
      }

      // Handle widget-uploaded attachments (already saved to data/inbox/ via /upload)
      if (hasAttachments) {
        const fileList = attachments
          .filter(a => a.path)
          .map(a => `${a.type || typeFromMime(a.mimeType)}: ${a.path}`)
          .join(', ');
        if (fileList) {
          content = content
            ? `${content}\n\n[Attached files: ${fileList}]`
            : `[Attached files: ${fileList}]`;
        }
      }

      try {
        const result = await this.engine.processEvent({
          platform: 'http',
          userId: userId || req.ip || 'anonymous',
          userName: userName || 'User',
          type: 'message',
          content,
          metadata: { mode: 'customer' },
        });

        // Extract file references from response
        let responseText = result.response;
        let files = [];
        if (workspace && responseText) {
          const extracted = extractFiles(workspace, responseText);
          responseText = extracted.cleanText;
          // Use the request's host so URLs work through tunnels (ngrok, cloudflared, etc.)
          const baseUrl = `${req.protocol}://${req.get('host')}`;
          files = extracted.files.map(f => {
            if (f.url) return { filename: f.filename, type: f.type, mimeType: f.mimeType, url: f.url };
            const relPath = f.absPath ? f.absPath.slice(resolve(workspace).length + 1).replace(/\\/g, '/') : f.filename;
            return { filename: f.filename, type: f.type, mimeType: f.mimeType, url: `${baseUrl}/files/${relPath}` };
          });
        }

        res.json({
          response: responseText,
          files: files.length > 0 ? files : undefined,
          toolsUsed: result.toolsUsed,
          tokensUsed: result.tokensUsed,
        });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // Health check
    app.get('/health', (req, res) => {
      const status = this.engine.getStatus();
      res.json({ status: 'ok', agent: status.agentName, provider: status.provider });
    });

    // Agent info
    app.get('/info', (req, res) => {
      res.json(this.engine.getStatus());
    });

    return new Promise((resolve, reject) => {
      this.server = createServer(app);

      this.server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          this.error = `Port ${this.port} is in use`;
          this.status = 'error';
          reject(new Error(this.error));
        } else {
          this.error = err.message;
          this.status = 'error';
          reject(err);
        }
      });

      this.server.listen(this.port, () => {
        this.status = 'connected';
        this.error = null;
        resolve();
      });
    });
  }

  _writeSkill() {
    const content = `---
name: http
description: Sending files to users through the HTTP connector and chat widget
---

# HTTP Connector — Sending Files

When a user chats with you through the chat widget or HTTP API, your replies are
sent back as JSON. Plain text and markdown work out of the box.

## How to send a file

To share an image, audio, video, or document with the user, embed it in your
reply using **standard markdown with a workspace-relative path**:

- Image: \`![Signature Haircut](data/photos/haircut.png)\`
- Audio: \`[relaxing-mix.mp3](data/audio/relaxing-mix.mp3)\`
- Video: \`[demo.mp4](data/video/demo.mp4)\`
- Document: \`[menu.pdf](data/files/menu.pdf)\`

The connector automatically extracts these references, resolves the files from
your workspace, and delivers them to the user as downloadable URLs. You do not
need to upload anything manually — just use the correct path.

## Rules

- **Use workspace-relative paths only** — paths like \`data/photos/foo.png\` or
  \`data/inbox/bar.jpg\`. These are files inside your workspace.
- **NEVER use \`/api/workspace/...\` paths.** That format only works in the dashboard
  and will NOT be delivered to the user. Always drop the \`/api/workspace/\` prefix.
- You may embed multiple files in one reply.
- The file must exist on disk. If you reference a file that doesn't exist, it will
  be silently skipped and the user won't receive it.

## Examples

Good:
\`\`\`
Here's our Signature Haircut service:
![Signature Haircut](data/photos/signature-haircut.png)

Price: 180 AED | Duration: 60 minutes
\`\`\`

Bad (will NOT work):
\`\`\`
![Signature Haircut](/api/workspace/data/photos/signature-haircut.png)
\`\`\`
`;
    writePlatformSkill(this.engine?.workspace, 'http', content);
  }

  async disconnect() {
    if (this.server) {
      await new Promise(resolve => this.server.close(resolve));
      this.server = null;
    }
    await super.disconnect();
  }

  async send() {
    // HTTP is request-response — sending happens in the route handler
  }

  getStatus() {
    return {
      ...super.getStatus(),
      port: this.port,
      url: this.status === 'connected' ? `http://localhost:${this.port}` : null,
    };
  }
}
