import express from 'express';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { BaseConnector } from './index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

    const app = express();
    app.use(express.json());

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

    // Chat endpoint
    app.post('/chat', async (req, res) => {
      const { message, userId, userName } = req.body;
      if (!message) return res.status(400).json({ error: 'message required' });

      try {
        const result = await this.engine.processEvent({
          platform: 'http',
          userId: userId || req.ip || 'anonymous',
          userName: userName || 'User',
          type: 'message',
          content: message,
        });

        res.json({
          response: result.response,
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
