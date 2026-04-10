import { listConnections } from '../auth/connections.js';
import { extractFiles } from './media.js';

/**
 * Base class for platform connectors.
 * Each connector bridges the AgentEngine to a specific platform.
 */
export class BaseConnector {
  constructor(config, engine) {
    this.config = config;
    this.engine = engine;
    this.status = 'disconnected'; // disconnected, connecting, connected, error
    this.error = null;
  }

  get platformName() { return this.config.platform || 'unknown'; }

  async connect() { throw new Error('Not implemented'); }

  async disconnect() {
    this.status = 'disconnected';
    this.error = null;
  }

  /**
   * Check if a userId matches the configured owner for this platform.
   */
  isOwner(userId) {
    return !!(this.config.ownerId && this.config.ownerId === userId);
  }

  /**
   * Default event handler: route to engine, send response back.
   * Injects is_owner flag into metadata before passing to the engine.
   * Extracts file references from the response and passes them to send().
   */
  async handleEvent(event) {
    try {
      // Inject is_owner if not already set
      if (event.metadata && event.metadata.is_owner === undefined) {
        event.metadata.is_owner = this.isOwner(event.userId);
      } else if (!event.metadata) {
        event.metadata = { is_owner: this.isOwner(event.userId) };
      }

      const result = await this.engine.processEvent(event);
      if (result.response) {
        // Extract file references from the response text
        const workspace = this.engine?.workspace;
        let response = result.response;
        let files = [];
        if (workspace) {
          const extracted = extractFiles(workspace, response);
          response = extracted.cleanText;
          files = extracted.files;
        }
        await this.send(event, response, result, files);
      }
      return result;
    } catch (err) {
      this.error = err.message;
      throw err;
    }
  }

  /**
   * Send a response back to the platform.
   * Override in subclasses.
   * @param {object} event - The original event
   * @param {string} response - Clean text response (file refs removed)
   * @param {object} result - Full engine result
   * @param {Array} files - Extracted file descriptors from media.js
   */
  async send(event, response, result, files = []) {
    throw new Error('Not implemented');
  }

  getStatus() {
    return {
      platform: this.platformName,
      status: this.status,
      error: this.error,
    };
  }
}

const CONNECTOR_MODULES = {
  truuze: () => import('./truuze.js'),
  http: () => import('./http.js'),
  openclaw: () => import('./openclaw.js'),
  telegram: () => import('./telegram.js'),
  discord: () => import('./discord.js'),
  slack: () => import('./slack.js'),
  whatsapp: () => import('./whatsapp.js'),
  relay: () => import('./relay.js'),
};

/**
 * Load a connector module by platform name.
 */
export async function loadConnector(platform) {
  const loader = CONNECTOR_MODULES[platform];
  if (!loader) return null;
  const mod = await loader();
  return mod.default;
}

/**
 * Load and instantiate all configured connectors for a workspace.
 * When a relay connection exists, skip starting local servers for
 * whatsapp and http — the relay connector handles their traffic.
 */
export async function loadAllConnectors(workspace, engine) {
  const connections = listConnections(workspace);
  const connectors = [];

  const hasRelay = connections.some(c => c.platform === 'relay');
  // Platforms whose local servers are replaced by the relay
  const relayedPlatforms = hasRelay ? new Set(['whatsapp', 'http']) : new Set();

  for (const { platform, config } of connections) {
    if (relayedPlatforms.has(platform)) {
      console.log(`[connectors] Skipping local ${platform} server — traffic routed through relay`);
      continue;
    }
    const ConnectorClass = await loadConnector(platform);
    if (ConnectorClass) {
      connectors.push(new ConnectorClass({ ...config, platform }, engine));
    }
  }

  return connectors;
}

export function listAvailableConnectors() {
  return Object.keys(CONNECTOR_MODULES);
}
