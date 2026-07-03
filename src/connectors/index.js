import { listConnections, loadConnection } from '../auth/connections.js';
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
   * Uses the in-memory snapshot — fast but can be stale right after
   * /admin verification or after notifications auto-verify.
   */
  isOwner(userId) {
    return !!(this.config.ownerId && this.config.ownerId === userId);
  }

  /**
   * Same as isOwner but reloads the connection from disk first. Use
   * this when the answer matters for routing decisions (e.g. owner-
   * reply detection) — `/admin` and `notify_owner` write `ownerId` to
   * disk without going through the connector, so the in-memory copy
   * can lag. Side effect: refreshes `this.config` so subsequent calls
   * stay current.
   */
  isOwnerFresh(userId) {
    const ws = this.engine?.workspace;
    if (!ws) return this.isOwner(userId);
    try {
      const fresh = loadConnection(ws, this.platformName);
      if (fresh) this.config = { ...this.config, ...fresh };
    } catch { /* fall through to in-memory */ }
    return this.isOwner(userId);
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
  telnyx: () => import('./telnyx.js'),
  webcall: () => import('./webcall.js'),
  voicecall: () => import('./voicecall.js'),
  relay: () => import('./relay.js'),
};

/**
 * Connector-owned LLM tools, keyed by platform. Each module's default export
 * must be `{ definitions, handlers }` — definitions is an array of tool
 * schemas, handlers is `{ [toolName]: (workspace, args) => Promise<string> }`.
 *
 * Adding a new connector with its own tools = add an entry here. ToolRegistry
 * picks them up automatically for any workspace that has a matching connection
 * configured under `.aaas/connections/<platform>.json`.
 */
const CONNECTOR_TOOL_MODULES = {
  truuze: () => import('./truuze-tools.js'),
  stripe: () => import('../payments/tools.js'),
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
 * Load a connector's tool module by platform name.
 * Returns `{ definitions, handlers }` or `null` if the platform has no tools.
 */
export async function loadConnectorToolModule(platform) {
  const loader = CONNECTOR_TOOL_MODULES[platform];
  if (!loader) return null;
  const mod = await loader();
  return mod.default;
}

/**
 * Dispatch an admin-authored direct message to a customer on the given
 * platform. Looks up the platform's connector module via the existing
 * CONNECTOR_MODULES registry and calls its named `sendDirect` export.
 *
 * Used by the dashboard's intervention endpoint (POST /transactions/:id/
 * admin-message). The agent is NOT involved — this is a direct
 * platform-API call using the connection credentials stored on disk.
 *
 * @returns {Promise<{ok:true,message_id?:string}|{ok:false,error:string}>}
 */
export async function sendDirectToCustomer(workspace, platform, recipient, text) {
  const loader = CONNECTOR_MODULES[platform];
  if (!loader) {
    return { ok: false, error: `Unknown platform "${platform}".` };
  }
  let mod;
  try {
    mod = await loader();
  } catch (err) {
    return { ok: false, error: `Failed to load connector module for "${platform}": ${err.message}` };
  }
  if (typeof mod.sendDirect !== 'function') {
    return { ok: false, error: `Direct admin intervention is not implemented for "${platform}" yet.` };
  }
  try {
    return await mod.sendDirect(workspace, recipient, text);
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Sweep paused-session flags for a given platform. Called by a connector
 * when it starts up — the policy is that pause state does not survive a
 * restart, since the admin can't see the dashboard while everything's down
 * and shouldn't be left with a silent agent on resume.
 *
 * Best-effort: failures here must never break connector startup.
 *
 * @param {object} sessionManager - The engine's SessionManager.
 * @param {string} platform - Platform name to sweep (e.g. 'telegram').
 * @returns {number} Count of sessions that had pause cleared.
 */
export function clearPausedSessionsForPlatform(sessionManager, platform) {
  if (!sessionManager?.listSessions) return 0;
  let cleared = 0;
  try {
    for (const s of sessionManager.listSessions()) {
      if (s.platformId !== platform) continue;
      if (s.meta?.paused) {
        sessionManager.setSessionMeta(platform, s.userId, 'paused', null);
        sessionManager.setSessionMeta(platform, s.userId, 'paused_at', null);
        cleared++;
      }
    }
  } catch (err) {
    console.warn(`[connectors] Pause sweep failed for "${platform}":`, err.message);
  }
  return cleared;
}

/**
 * Load and instantiate all configured connectors for a workspace.
 * When a relay connection exists, skip starting local servers for
 * whatsapp and http — the relay connector handles their traffic.
 *
 * @param {string} workspace
 * @param {object} engine
 * @param {object} [options]
 * @param {string[]} [options.platforms] - If non-empty, only load these platforms.
 */
export async function loadAllConnectors(workspace, engine, options = {}) {
  let connections = listConnections(workspace);
  const connectors = [];

  const filter = Array.isArray(options.platforms) && options.platforms.length > 0
    ? new Set(options.platforms)
    : null;
  if (filter) {
    connections = connections.filter(c => filter.has(c.platform));
  }

  const hasRelay = connections.some(c => c.platform === 'relay');
  // Platforms whose local servers are replaced by the relay (streetai.org fronts
  // their inbound traffic — WhatsApp webhooks, HTTP chat, Telnyx voice, Web Call).
  const relayedPlatforms = hasRelay ? new Set(['whatsapp', 'http', 'telnyx', 'webcall', 'voicecall']) : new Set();

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
