import { listConnections } from '../auth/connections.js';

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
   * Default event handler: route to engine, send response back.
   */
  async handleEvent(event) {
    try {
      const result = await this.engine.processEvent(event);
      if (result.response) {
        await this.send(event, result.response, result);
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
   */
  async send(event, response, result) {
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
 */
export async function loadAllConnectors(workspace, engine) {
  const connections = listConnections(workspace);
  const connectors = [];

  for (const { platform, config } of connections) {
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
