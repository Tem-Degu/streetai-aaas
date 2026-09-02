import { searchData } from './search-data.js';
import { readMemory, saveMemory, forgetMemory } from './memory.js';
import { callExtension } from './extensions.js';
import { createTransaction, updateTransaction, completeTransaction, cancelTransaction, listTransactions, attachFileToTransaction } from './transactions.js';
import { scheduleAction, removeAction, loadPending } from '../scheduler.js';
import { readSkill, writeSkill, readSoul, writeSoul, readDataFile, writeDataFile, addDataRecord, updateDataRecord, deleteDataRecord, readExtensions, addExtension, removeExtension, importFile, applyTemplateVariables, renameDataFile, createAgentTool, listAgentTools, removeAgentTool } from './workspace.js';
import { runQuery, listTables, getDb } from './database.js';
import { synthesizeSpeech } from '../tts.js';
import { SessionManager } from '../sessions/index.js';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { platformRequest } from './platform-request.js';
import { webSearch, webFetch, imageSearch } from './web.js';
import { readImage } from './vision.js';
import { listConnections, loadConnection } from '../../auth/connections.js';
import { loadConnectorToolModule } from '../../connectors/index.js';
import { notifyOwner, notifyTransaction } from '../../notifications/index.js';
import { MemoryManager } from '../memory/index.js';
import { readText, readJson } from '../../utils/workspace.js';
import { parseTransactionFieldsBlock, parseItemFieldsBlock, buildToolFieldSchema, parseServiceCatalog, parseCurrencyDeclaration } from './transaction-view.js';
import { validateTransactionPayload } from './transaction-validate.js';

/**
 * place_call handler — asks the relay to originate an outbound phone call. The
 * relay owns the hard guardrails (deny-lists, international toggle, rate/spend
 * caps); this only gates on the owner's Settings switch and forwards the request
 * with the agent's own relay credentials. Returns quickly: the actual live
 * conversation runs in the voice pipeline once the call connects.
 */
async function placeCall(workspace, config, args = {}) {
  if (!config?.voice?.outbound?.enabled) {
    return JSON.stringify({ ok: false, error: 'Outbound calling is turned off. Your owner can enable it in Settings → Outbound calling.' });
  }
  const to = String(args.to || '').trim();
  const purpose = String(args.purpose || '').trim();
  if (!to) return JSON.stringify({ ok: false, error: 'A phone number (to) is required.' });

  const conn = loadConnection(workspace, 'relay');
  if (!conn?.relayKey || !conn?.slug || !conn?.relayUrl) {
    return JSON.stringify({ ok: false, error: 'Outbound calling needs the StreetAI relay, and this agent is not connected to it.' });
  }
  const base = conn.relayUrl.replace(/^ws/, 'http').replace(/\/+$/, '');
  const out = config.voice.outbound;
  const callerId = out.callerId || undefined;
  // The owner's Settings toggle drives international; the server still applies
  // its hard deny-lists and rate/spend caps on top, regardless of this.
  const allowInternational = out.denyInternational === false;
  try {
    const resp = await fetch(`${base}/relay/originate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: conn.slug, relayKey: conn.relayKey, to, purpose, callerId, allowInternational }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.ok) {
      return JSON.stringify({ ok: false, error: data.error || `The call could not be placed (HTTP ${resp.status}).` });
    }
    return JSON.stringify({ ok: true, callId: data.callId, to: data.to, note: "Calling now. When they answer you'll be speaking with them live — open by introducing yourself as an AI agent." });
  } catch (e) {
    return JSON.stringify({ ok: false, error: 'Could not reach the calling service: ' + e.message });
  }
}

/**
 * Tool registry. Returns tool definitions for the LLM and dispatches execution.
 *
 * Tools come from two layers:
 *   1. Base tools — built into the engine and always available (memory,
 *      transactions, workspace, database, web, generic platform_request).
 *   2. Connector tools — owned by individual connectors (e.g. truuze-tools.js)
 *      and only loaded when the workspace has a matching connection
 *      configured under `.aaas/connections/<platform>.json`. This keeps
 *      platform-specific tooling colocated with the connector and means
 *      adding a new connector with its own tools doesn't touch the engine.
 *
 * After construction, callers must `await registry.loadConnectorTools()`
 * before serving requests so connector definitions are merged in.
 */
export class ToolRegistry {
  constructor(workspace, paths, config = {}) {
    this.workspace = workspace;
    this.paths = paths;
    this.config = config;
    this.connectorDefinitions = [];
    this.connectorHandlers = {};
    /** Agent tools — per-agent code tools loaded from the agent's own
     *  workspace (see loadAgentTools). Third tier alongside base + connector. */
    this.agentDefinitions = [];
    this.agentHandlers = {};
    /** Per-event context, set by the engine at the start of each turn. */
    this.eventContext = null;
    /** Activity log + facts. Lightweight to construct. */
    this.memory = new MemoryManager(workspace);
  }

  /**
   * Append an activity entry. Best-effort — never throws or fails the
   * caller. Used both by the explicit log_activity tool and by automatic
   * hooks on key tools (transactions, alerts).
   */
  _logActivity(type, summary, context) {
    try {
      this.memory.appendActivity({
        type,
        summary,
        context,
        session_id: this.eventContext
          ? `${this.eventContext.platform || 'local'}:${this.eventContext.userId || 'unknown'}`
          : null,
      });
    } catch { /* swallow — logging never breaks a turn */ }
  }

  /**
   * Auto-log helper: parses the tool's JSON result and writes a one-line
   * summary to the activity log. Skips failures so we don't spam the log
   * with error noise.
   */
  _autoLogToolResult(toolName, args, resultStr) {
    let parsed;
    try { parsed = JSON.parse(resultStr); } catch { return; }
    if (!parsed || parsed.error) return;
    const ctx = this.eventContext || {};
    const customer = ctx.userName || ctx.userId || 'customer';

    if (toolName === 'create_transaction') {
      const cost = args.cost != null ? `${args.currency || '$'}${args.cost}` : '';
      this._logActivity('transaction_created',
        `Created transaction ${args.id} for ${customer}${args.service ? ` — ${args.service}` : ''}${cost ? ` (${cost})` : ''}`,
        { transaction_id: args.id, customer: ctx.userId, service: args.service, cost: args.cost, currency: args.currency }
      );
    } else if (toolName === 'update_transaction') {
      const status = args.updates?.status ? ` → ${args.updates.status}` : '';
      this._logActivity('transaction_updated',
        `Updated transaction ${args.id}${status}`,
        { transaction_id: args.id, updates: args.updates }
      );
    } else if (toolName === 'complete_transaction') {
      const rating = args.rating ? `, rating ${args.rating}` : '';
      this._logActivity('transaction_completed',
        `Completed transaction ${args.id}${rating}`,
        { transaction_id: args.id, rating: args.rating }
      );
    } else if (toolName === 'cancel_transaction') {
      const reason = args.reason ? ` — ${args.reason}` : '';
      this._logActivity('transaction_cancelled',
        `Cancelled transaction ${args.id}${reason}`,
        { transaction_id: args.id, reason: args.reason }
      );
    } else if (toolName === 'notify_owner') {
      const sent = parsed.sent || [];
      if (sent.length > 0) {
        const channels = sent.map(s => s.channel).join(', ');
        this._logActivity('alert_sent',
          `Alerted owner via ${channels}: ${args.title}`,
          { alert_id: parsed.alert_id, severity: args.severity, channels }
        );
      }
    } else if (toolName === 'forget_memory') {
      // Only audit confirmed deletions (preview responses have ok:false).
      if (parsed.ok && parsed.deleted > 0) {
        const who = parsed.scope === 'user' ? customer : 'business';
        this._logActivity('note',
          `Forgot ${parsed.deleted} ${parsed.scope} fact(s) for ${who}: ${(parsed.keys || []).join(', ')}`,
          { scope: parsed.scope, keys: parsed.keys, deleted: parsed.deleted, customer: ctx.userId }
        );
      }
    }
  }

  /**
   * Engine sets this at the start of every processEvent so tools that need
   * to know "which conversation am I in" (e.g. notify_owner recording the
   * customer session that triggered the alert) can read it.
   */
  setEventContext(ctx) {
    this.eventContext = ctx || null;
  }

  /**
   * Push a transaction card to the owner when a transaction is created or
   * changed through the tools. Best-effort and fire-and-forget — never affects
   * the tool's result.
   *
   * No mode/owner suppression: session `mode` defaults to 'admin' when unset,
   * so gating on it would silently drop most notifications (including real
   * customer orders). Echo isn't a concern here — button taps and dashboard
   * changes update transactions through other paths, not this hook, so they
   * never trigger a notification.
   */
  _notifyTransactionSafe(event, resultStr) {
    try {
      const parsed = JSON.parse(resultStr);
      if (!parsed || parsed.ok === false || parsed.error || !parsed.transaction) return;
      notifyTransaction(this.workspace, this.paths, parsed.transaction, event).catch(() => {});
    } catch { /* best-effort — notifications never break a tool call */ }
  }

  /**
   * Discover and load tools owned by configured connectors.
   * Idempotent: safe to call multiple times (re-replaces both maps).
   */
  async loadConnectorTools() {
    const definitions = [];
    const handlers = {};

    const connections = listConnections(this.workspace);
    const seen = new Set();

    for (const { platform } of connections) {
      if (seen.has(platform)) continue;
      seen.add(platform);

      let mod;
      try {
        mod = await loadConnectorToolModule(platform);
      } catch (err) {
        console.warn(`[tools] Failed to load tool module for ${platform}: ${err.message}`);
        continue;
      }
      if (!mod) continue;

      if (Array.isArray(mod.definitions)) {
        definitions.push(...mod.definitions);
      }
      if (mod.handlers && typeof mod.handlers === 'object') {
        for (const [name, fn] of Object.entries(mod.handlers)) {
          if (typeof fn !== 'function') continue;
          if (handlers[name]) {
            console.warn(`[tools] Duplicate connector tool "${name}" — ${platform} entry ignored`);
            continue;
          }
          handlers[name] = { fn, platform };
        }
      }
    }

    this.connectorDefinitions = definitions;
    this.connectorHandlers = handlers;
  }

  /**
   * Discover and load "agent tools" — per-agent code tools that live in the
   * agent's own workspace at `<root>/tools/<name>.js` and are declared in
   * `.aaas/config.json` under `agentTools: ["<name>", ...]`. Each module
   * default-exports `{ definitions, handlers }` (the same contract connector
   * tools use). Handlers are invoked as `fn(ctx, args)` where ctx carries
   * `{ workspace, paths, config, event, db, sql }`.
   *
   * Third tier alongside base tools (engine) and connector tools (platform):
   * these are owned by, and scoped to, this one agent, and run on its own
   * SQLite. Must be called AFTER loadConnectorTools() so name collisions are
   * detected. Idempotent: re-replaces both maps.
   *
   * Gated by the host env `AAAS_ALLOW_AGENT_TOOLS` (default off) because
   * this executes agent-authored code inside the engine process — enable only
   * on hosts running trusted/first-party agents.
   */
  async loadAgentTools() {
    this.agentDefinitions = [];
    this.agentHandlers = {};

    // Read the manifest from disk (config.json) so tools authored at runtime via
    // create_agent_tool are picked up on reload without restarting the engine.
    const cfg = readJson(this.paths.config) || this.config || {};
    const manifest = cfg.agentTools;
    if (!Array.isArray(manifest) || manifest.length === 0) return;

    if (!process.env.AAAS_ALLOW_AGENT_TOOLS) {
      console.warn(`[tools] Agent tools declared (${manifest.join(', ')}) but AAAS_ALLOW_AGENT_TOOLS is not set — skipping. Enable it only on trusted hosts.`);
      return;
    }

    // Names already owned by base + connector tools; agent tools must not collide.
    const taken = new Set([
      ...this._getBaseToolDefinitions().map(d => d.name),
      ...this.connectorDefinitions.map(d => d.name),
    ]);

    const toolsDir = path.join(this.paths.root, 'tools');

    for (const rawName of manifest) {
      const name = String(rawName || '').trim();
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        console.warn(`[tools] Skipping invalid agent tool name "${rawName}".`);
        continue;
      }

      const file = path.join(toolsDir, `${name}.js`);
      // Defense-in-depth: never resolve outside the agent tools/ dir.
      if (!path.resolve(file).startsWith(path.resolve(toolsDir) + path.sep)) {
        console.warn(`[tools] Refusing to load agent tool "${name}" — path escapes tools/.`);
        continue;
      }
      if (!fs.existsSync(file)) {
        console.warn(`[tools] Agent tool "${name}" declared but ${file} not found.`);
        continue;
      }

      let mod;
      try {
        // Cache-bust by mtime so a tool replaced via create_agent_tool re-imports
        // instead of returning Node's cached module; unchanged files reuse cache.
        const version = fs.statSync(file).mtimeMs;
        mod = await import(pathToFileURL(file).href + `?v=${version}`);
      } catch (err) {
        console.warn(`[tools] Failed to import agent tool "${name}": ${err.message}`);
        continue;
      }
      const def = mod.default || mod;
      if (!def || !Array.isArray(def.definitions) || !def.handlers || typeof def.handlers !== 'object') {
        console.warn(`[tools] Agent tool "${name}" must default-export { definitions: [], handlers: {} } — skipping.`);
        continue;
      }

      for (const d of def.definitions) {
        if (!d || !d.name) continue;
        if (taken.has(d.name)) {
          console.warn(`[tools] Agent tool "${name}" defines "${d.name}" which collides with an existing tool — skipped.`);
          continue;
        }
        const fn = def.handlers[d.name];
        if (typeof fn !== 'function') {
          console.warn(`[tools] Agent tool "${name}" has no handler for definition "${d.name}" — skipped.`);
          continue;
        }
        taken.add(d.name);
        this.agentDefinitions.push(d);
        this.agentHandlers[d.name] = { fn, module: name };
      }
    }

    if (this.agentDefinitions.length > 0) {
      console.log(`[tools] Loaded ${this.agentDefinitions.length} agent tool(s): [${this.agentDefinitions.map(d => d.name).join(', ')}]`);
    }
  }

  /**
   * Context object handed to agent-tool handlers. Unlike connector handlers
   * (which live inside the engine and can import its utils), workspace modules
   * live outside `src/`, so everything they need is passed in: the agent's
   * paths/config, the current event, and DB access (raw better-sqlite3 handle
   * plus a `sql()` convenience wrapping runQuery).
   */
  _agentToolContext() {
    return {
      workspace: this.workspace,
      paths: this.paths,
      config: this.config,
      event: this.eventContext,
      db: getDb(this.paths),
      sql: (sql, params, mode) => runQuery(this.paths, { sql, params, mode }),
      // Text-to-speech for agent tools that send voice notes. Returns
      // { buffer, mime }. Credentials resolve from this workspace.
      tts: (opts) => synthesizeSpeech({ ...opts, workspace: this.workspace }),
      // Vision for agent tools that need to look at an image. `args` =
      // { path, question }. Returns the raw tool result (JSON string with
      // { description } or { error }). Provider/model from config.vision.
      vision: (args) => readImage({ workspace: this.workspace, config: this.config, args }),
      // Schedule a future turn (a nudge / follow-up). `opts` =
      // { delayMinutes, instruction, session:{platform,user_id}, context }.
      // Lets a tool drive follow-through in any party's own chat.
      schedule: (opts) => scheduleAction(this.paths, opts),
      // Append a message into another party's session so out-of-band sends (e.g.
      // a matchmaker asking the client a question on the target's behalf) are
      // visible in that party's next turn instead of arriving with no context.
      // `message` = { role, content }. Best-effort; never breaks a tool call.
      appendSession: (userId, message) => {
        try { new SessionManager(this.workspace).addMessage('truuze', String(userId), message); }
        catch { /* best-effort */ }
      },
    };
  }

  /**
   * Get tool definitions in generic format for the LLM.
   * Returns base tools merged with connector-owned and agent-owned tools.
   */
  getToolDefinitions() {
    return [
      ...this._getBaseToolDefinitions(),
      ...this.connectorDefinitions,
      ...this.agentDefinitions,
    ];
  }

  /**
   * Read the workspace's declared transaction fields and produce a
   * JSON-schema fragment. Cached per skill-content hash so we only re-parse
   * when SKILL.md actually changes. Returns `{ properties: {}, required: [] }`
   * when no block is declared, which spreads cleanly into the base schema.
   */
  _getTransactionFieldSchema() {
    try {
      const skillText = readText(this.paths.skill) || '';
      if (this._txnFieldCacheKey === skillText) return this._txnFieldCacheValue;
      const parsed = parseTransactionFieldsBlock(skillText);
      const parsedItems = parseItemFieldsBlock(skillText);
      const schema = buildToolFieldSchema(parsed, parsedItems);
      schema.serviceEnum = parseServiceCatalog(skillText);
      this._txnFieldCacheKey = skillText;
      this._txnFieldCacheValue = schema;
      return schema;
    } catch {
      return { properties: {}, required: [], serviceEnum: [] };
    }
  }

  /**
   * Returns the parsed Transaction Fields + Item Fields blocks (not the JSON
   * schema), plus the workspace's `Currency:` declaration if present.
   * Used by engine-side validation, which needs the `isRequired` flags,
   * the field type, and the currency allow-list rather than the LLM-shaped
   * schema. Cached against the same skill content hash as the schema cache.
   */
  _getParsedTransactionFields() {
    try {
      const skillText = readText(this.paths.skill) || '';
      if (this._txnParsedCacheKey === skillText) return this._txnParsedCacheValue;
      const parsed = parseTransactionFieldsBlock(skillText);
      const parsedItems = parseItemFieldsBlock(skillText);
      const currencyDecl = parseCurrencyDeclaration(skillText);
      const value = { parsed, parsedItems, currencyDecl };
      this._txnParsedCacheKey = skillText;
      this._txnParsedCacheValue = value;
      return value;
    } catch {
      return { parsed: { found: false, fields: [] }, parsedItems: { found: false, fields: [] }, currencyDecl: null };
    }
  }

  _getBaseToolDefinitions() {
    const txnFields = this._getTransactionFieldSchema();
    const hasDeclaredFields = Object.keys(txnFields.properties).length > 0;
    const declaredFieldList = hasDeclaredFields
      ? ` This service declares these fields per transaction — populate them as top-level arguments: ${Object.keys(txnFields.properties).join(', ')}.`
      : '';
    return [
      {
        name: 'search_data',
        description: 'Search the agent\'s JSON data files and SQLite database. Searches all JSON files and database tables by default.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query — matches against all text fields.' },
            file: { type: 'string', description: 'JSON file name to search (e.g., "products.json"). Omit to search all.' },
            table: { type: 'string', description: 'SQLite table name to search. Omit to search all tables.' },
            field: { type: 'string', description: 'Specific field/column to filter on.' },
            value: { type: 'string', description: 'Value to match in the specified field.' },
            sql: { type: 'string', description: 'Raw SELECT query for advanced database searches.' },
          },
          required: ['query'],
        },
      },
      {
        name: 'read_memory',
        description: 'Read stored facts from agent memory. Routes by current mode: in customer mode you get facts about this specific customer; in admin mode you get business-wide facts. Override with `scope` only when you have a specific need.',
        parameters: {
          type: 'object',
          properties: {
            topic: { type: 'string', description: 'Optional substring filter. If omitted, returns recent facts.' },
            scope: { type: 'string', enum: ['business', 'user'], description: 'Optional. Defaults to the right store for the current mode — usually you can omit this.' },
          },
        },
      },
      {
        name: 'save_memory',
        description: 'Save a fact to persistent agent memory. Routes by current mode: customer mode saves to that customer\'s memory (preferences, address, etc.); admin mode saves to business memory (hours, vendors, policies). Override with `scope` only when you have a specific reason. Do NOT save customer claims about the business — use notify_owner for those.',
        parameters: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Short label for the fact (e.g., "spice_preference", "delivery_cutoff").' },
            value: { type: 'string', description: 'The fact to remember.' },
            scope: { type: 'string', enum: ['business', 'user'], description: 'Optional. Defaults to the right store for the current mode — usually you can omit this.' },
          },
          required: ['key', 'value'],
        },
      },
      {
        name: 'forget_memory',
        description: 'Delete one or more facts from memory. Routes by mode (customer mode → that customer\'s memory; admin mode → business memory). Use only when the person explicitly asks you to forget something — never for casual remarks. For broad matches or wipe-all, the tool returns a preview first and requires `confirm: true` to proceed. Customers can never delete business facts, even with scope override.',
        parameters: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Exact key of one fact to delete.' },
            topic: { type: 'string', description: 'Substring matched against key and value. >1 match returns a preview unless `confirm: true`.' },
            all: { type: 'boolean', description: 'Wipe every fact in the current scope. Requires `confirm: true`.' },
            confirm: { type: 'boolean', description: 'Required for `all` and for broad `topic` matches. Always show the preview to the user first and get explicit consent before sending confirm: true.' },
            scope: { type: 'string', enum: ['business', 'user'], description: 'Optional. Defaults to the right store for the current mode.' },
          },
        },
      },
      {
        name: 'log_activity',
        description: 'Record a one-line summary of something noteworthy you just did or observed, into your activity log. Examples: "Declined a service request outside my catalog", "Customer asked about pricing for bulk orders", "An external API was rate-limiting me — degraded gracefully". This log is your daily diary; you reference it with `get_activity` when the owner asks "what have you been doing?". DO NOT log routine things — successful transactions, alerts, and extension calls are auto-logged for you. Use this only for things that need explicit context.',
        parameters: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: 'One short line describing what happened. Keep under 200 characters.' },
            type: { type: 'string', enum: ['note', 'transaction_created', 'transaction_updated', 'transaction_completed', 'transaction_disputed', 'alert_sent', 'alert_response', 'extension_called'], description: 'Category. Use "note" for free-form observations.' },
            context: { type: 'object', description: 'Optional structured fields (transaction_id, customer, etc.).' },
          },
          required: ['summary'],
        },
      },
      {
        name: 'get_activity',
        description: 'Read recent entries from your activity log. Use this when the owner asks for a summary of what has been happening, e.g. "what have you been doing today?", "any issues this week?", "show me the disputes from the last 48 hours". Returns newest-first with optional filters.',
        parameters: {
          type: 'object',
          properties: {
            since_hours: { type: 'number', description: 'Look back this many hours (default 24).' },
            type: { type: 'string', description: 'Filter by entry type (e.g. "transaction_completed", "alert_sent").' },
            contains: { type: 'string', description: 'Substring match against the summary line.' },
            limit: { type: 'number', description: 'Max entries to return (default 100, max 500).' },
          },
        },
      },
      {
        name: 'call_extension',
        description: 'Call an external API extension or send a message to another AaaS agent. Two ways to call an API extension: (1) Operation-based (preferred) — pass `operation` matching one of the extension\'s registered operations; the runtime resolves path/method/async/output_type for you, you only supply `data`. (2) Free-form — pass `method`, `path`, and `data` directly. Async operations are polled automatically until ready or max_wait_s is reached. Binary results (audio, images, video) are saved into data/extensions/<name>/ and the tool returns { file_path, mime, size }. For agent extensions: just provide data.message.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Extension name from extensions/registry.json.' },
            operation: { type: 'string', description: 'Name of a registered operation on this extension. Preferred over free-form path/method.' },
            method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], description: 'HTTP method (free-form mode only; ignored when `operation` is given).' },
            path: { type: 'string', description: 'API path appended to the base URL (free-form mode only; ignored when `operation` is given).' },
            data: { type: 'object', description: 'Request body. For operations with path placeholders like `{user_id}`, the runtime fills them from this object before sending. For agent extensions, pass `{ message: "..." }`.' },
          },
          required: ['name'],
        },
      },
      {
        name: 'create_transaction',
        description: 'Create a new service transaction for a user. The platform assigns the transaction number automatically — do NOT pass an id. The assigned number is returned in the response (e.g. "#47") and is what you should use for any follow-up calls (update_transaction, complete_transaction, etc.) on this order.' + declaredFieldList,
        parameters: {
          type: 'object',
          properties: {
            user_id: { type: 'string', description: 'User ID or username.' },
            user_name: { type: 'string', description: 'User display name.' },
            service: txnFields.serviceEnum?.length
              ? { type: 'string', enum: txnFields.serviceEnum, description: 'Service from the catalog. Pick one of the declared values exactly.' }
              : { type: 'string', description: 'Service tier name.' },
            cost: { type: 'number', description: 'Service cost. Plain number, no currency symbol. Use at most two decimal places (e.g. 24.50, not 24.5000001).' },
            currency: { type: 'string', description: 'Currency symbol or code (e.g. $, €, TK). Defaults to $ if not specified.' },
            details: { type: 'object', description: 'Additional transaction details that are not declared as top-level fields above.' },
            ...txnFields.properties,
          },
          // Dedupe: a declared field marked `required` in SKILL.md (e.g. `service`)
          // would otherwise duplicate the platform-required keys. DeepSeek rejects
          // non-unique required arrays with HTTP 400; other providers tolerate it.
          // `id` is no longer in the schema — the engine assigns it.
          required: [...new Set(['user_id', 'service', ...txnFields.required])],
        },
      },
      {
        name: 'update_transaction',
        description: 'Update an existing transaction.' + (hasDeclaredFields ? ' Pass updated values for any of the declared transaction fields directly as top-level keys, or use `updates` for fields not in the declared list.' : ''),
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Transaction ID.' },
            updates: { type: 'object', description: 'Fields to update that are not declared as top-level fields above.' },
            ...txnFields.properties,
          },
          // `update_transaction` does not auto-require declared fields (updates
          // are partial), so the platform keys are unique on their own — but
          // dedupe defensively to match `create_transaction` and survive any
          // future change that mixes the two sources.
          required: [...new Set(['id', 'updates'])],
        },
      },
      {
        name: 'complete_transaction',
        description: 'Mark a transaction as completed (terminal). Call when the work is done — autonomously (you delivered the service) or after the owner confirms a hand-off. Allowed from pending, in_progress, or disputed. Refused if already completed/cancelled.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Transaction ID to complete.' },
            rating: { type: 'number', description: 'Optional rating (1-5).' },
          },
          required: ['id'],
        },
      },
      {
        name: 'cancel_transaction',
        description: 'Cancel a transaction. In customer mode: allowed from `pending` or `disputed`; for `in_progress` transactions, this is REFUSED — call `notify_owner` to escalate instead. In admin mode (verified owner): allowed from any non-terminal status, including `in_progress` — the owner has dashboard-level authority. Do NOT use update_transaction to set status to "cancelled"; this dedicated tool records the reason and produces an audit log entry.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Transaction ID to cancel.' },
            reason: { type: 'string', description: 'Optional short reason from the customer or owner.' },
          },
          required: ['id'],
        },
      },
      {
        name: 'schedule_action',
        description: 'Schedule a wake-up note for yourself in this same conversation. Use when you need to do something for this customer at a later time — send a reminder, follow up on a payment link, check on a booking, etc. The action will fire after `delay_minutes` and land in this customer\'s session as a system message containing your instruction. You\'ll then react to it like any normal turn. Do not abuse — keep delays meaningful (5+ minutes) and avoid scheduling many actions for the same customer.',
        parameters: {
          type: 'object',
          properties: {
            delay_minutes: { type: 'number', description: 'Minutes from now until the action fires. Between 1 and 20160 (14 days).' },
            instruction: { type: 'string', description: 'Note to your future self. Becomes the message you\'ll read when the action fires. Be specific — e.g. "Send Anya a reminder that her dinner reservation is in 15 minutes" rather than "remind".' },
            context: { type: 'object', description: 'Optional structured fields to carry forward (e.g. { transaction_id, booking_time }). Surfaced in the synthetic event\'s metadata.' },
          },
          required: ['delay_minutes', 'instruction'],
        },
      },
      {
        name: 'list_scheduled_actions',
        description: 'List your pending scheduled actions, optionally filtered to the current customer. Useful to check before scheduling another to avoid duplicates.',
        parameters: {
          type: 'object',
          properties: {
            this_customer_only: { type: 'boolean', description: 'When true, only return actions targeting the current session. Defaults to false.' },
          },
        },
      },
      {
        name: 'cancel_scheduled_action',
        description: 'Cancel a pending scheduled action by id. Use when the situation has changed (customer rescheduled, order was completed early, etc.) and the scheduled wake-up is no longer relevant.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The scheduled action id (e.g. "s_47") returned by schedule_action.' },
          },
          required: ['id'],
        },
      },
      {
        name: 'attach_file_to_transaction',
        description: 'Link a file (image, audio, video, document) that already exists in your data/ folder to a transaction. Use this whenever a customer sends a file as part of a service. The file stays where you put it — this just records a reference in the transaction so the operator can see it.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Transaction ID to attach the file to.' },
            file_path: { type: 'string', description: 'Workspace-relative path to the file under data/ (e.g. "data/jobs/logo_1/photo.jpg").' },
          },
          required: ['id', 'file_path'],
        },
      },
      {
        name: 'list_transactions',
        description: 'List transactions, optionally filtered by status.',
        parameters: {
          type: 'object',
          properties: {
            status: { type: 'string', description: 'Filter by status (e.g., "pending", "in_progress", "completed").' },
            include_archived: { type: 'boolean', description: 'Include archived transactions.' },
          },
        },
      },

      // ── Workspace management tools ──

      {
        name: 'read_skill',
        description: 'Read the current SKILL.md content. Use this to review the agent\'s service definition.',
        parameters: { type: 'object', properties: {} },
      },
      {
        name: 'write_skill',
        description: 'Write or replace the entire SKILL.md. Use this to set up or update the agent\'s service definition.',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'The full SKILL.md content (markdown).' },
          },
          required: ['content'],
        },
      },
      {
        name: 'rename_data_file',
        description: 'Rename or move a file inside data/. Use when a file is on disk under one name but other files (menu.json, etc.) reference a different name.',
        parameters: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'Current path, relative to data/.' },
            to:   { type: 'string', description: 'New path, relative to data/.' },
          },
          required: ['from', 'to'],
        },
      },
      {
        name: 'apply_template_variables',
        description: 'Mechanically substitute {{KEY}} placeholders across template files during first-time workspace setup. Reads data/template.config.json for the files_to_substitute list and replaces every {{KEY}} occurrence with the provided value. Preserves frontmatter, formatting, and structure exactly — use this INSTEAD of read_skill/write_skill loops when filling in a fresh template. Returns the substitution count per file and any placeholders that remain unfilled.',
        parameters: {
          type: 'object',
          properties: {
            values: {
              type: 'object',
              description: 'Map of variable name to substituted value. Example: { "RESTAURANT_NAME": "Mario\'s Pizza", "CURRENCY": "USD" }. Keys MUST match those listed in data/template.config.json.',
            },
            files: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional override list of files (workspace-root-relative). When omitted, the tool reads data/template.config.json and uses its files_to_substitute array.',
            },
          },
          required: ['values'],
        },
      },
      {
        name: 'read_soul',
        description: 'Read the current SOUL.md content. Use this to review the agent\'s personality definition.',
        parameters: { type: 'object', properties: {} },
      },
      {
        name: 'write_soul',
        description: 'Write or replace the entire SOUL.md. Use this to set up or update the agent\'s personality.',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'The full SOUL.md content (markdown).' },
          },
          required: ['content'],
        },
      },
      {
        name: 'read_data_file',
        description: 'Read a specific data file from the data/ directory.',
        parameters: {
          type: 'object',
          properties: {
            file: { type: 'string', description: 'File name (e.g., "products.json", "listings.json").' },
          },
          required: ['file'],
        },
      },
      {
        name: 'write_data_file',
        description: 'Create or replace a data file in the data/ directory.',
        parameters: {
          type: 'object',
          properties: {
            file: { type: 'string', description: 'File name (e.g., "products.json").' },
            data: { description: 'File content — an array, object, or string.' },
          },
          required: ['file', 'data'],
        },
      },
      {
        name: 'add_data_record',
        description: 'Add a single record to a JSON array data file. Creates the file if it doesn\'t exist.',
        parameters: {
          type: 'object',
          properties: {
            file: { type: 'string', description: 'JSON file name (e.g., "profiles.json").' },
            record: { type: 'object', description: 'The record object to add.' },
          },
          required: ['file', 'record'],
        },
      },
      {
        name: 'update_data_record',
        description: 'Update an existing record in a JSON array data file by matching a key field. If no match is found, inserts a new record.',
        parameters: {
          type: 'object',
          properties: {
            file: { type: 'string', description: 'JSON file name (e.g., "profiles.json").' },
            key: { type: 'string', description: 'Field name to match on (e.g., "user_id").' },
            value: { type: 'string', description: 'Value to match (e.g., "bobby_11").' },
            record: { type: 'object', description: 'The record data to update or insert.' },
          },
          required: ['file', 'key', 'value', 'record'],
        },
      },
      {
        name: 'delete_data_record',
        description: 'Delete a record from a JSON array data file by matching a key field.',
        parameters: {
          type: 'object',
          properties: {
            file: { type: 'string', description: 'JSON file name (e.g., "profiles.json").' },
            key: { type: 'string', description: 'Field name to match on (e.g., "user_id").' },
            value: { type: 'string', description: 'Value to match (e.g., "bobby_11").' },
          },
          required: ['file', 'key', 'value'],
        },
      },
      {
        name: 'read_extensions',
        description: 'Read the current extensions registry to see what external APIs are configured.',
        parameters: { type: 'object', properties: {} },
      },
      {
        name: 'add_extension',
        description: 'Add or update an extension in the registry. For API extensions, register operations so future calls can use `call_extension({operation: "..."})` instead of guessing paths. Strings may include `{{ENV_VAR}}` substitution; the value is read from process.env at call time.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Extension name.' },
            type: { type: 'string', enum: ['api', 'agent', 'human', 'tool'], description: 'Extension type.' },
            endpoint: { type: 'string', description: 'Base URL for API extensions, e.g. "https://api.example.com".' },
            address: { type: 'string', description: 'Endpoint URL for agent or human extensions.' },
            description: { type: 'string', description: 'One-line summary of what this extension does.' },
            capabilities: { type: 'array', items: { type: 'string' }, description: 'Free-form keywords like ["music", "audio"] for documentation.' },
            auth: {
              type: 'object',
              description: 'Auth config. type: bearer | header | query | basic. Use `apiKey: "{{MY_KEY}}"` to pull from env.',
              properties: {
                type: { type: 'string', enum: ['bearer', 'header', 'query', 'basic'] },
                apiKey: { type: 'string' },
                header: { type: 'string', description: 'Header or query-param name (for type=header or query).' },
              },
            },
            headers: { type: 'object', description: 'Static custom headers to send on every request.' },
            output_type: { type: 'string', enum: ['json', 'text', 'binary'], description: 'Default output type for free-form calls.' },
            operations: {
              type: 'array',
              description: 'Named operations the agent can call by name. Each operation hides path/method/async details from the agent.',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'How the agent refers to this operation.' },
                  description: { type: 'string', description: 'One-line summary, shown to the agent in its system prompt.' },
                  method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
                  path: { type: 'string', description: 'Relative path appended to endpoint. Supports {placeholder} substitution from the call body.' },
                  body: { type: 'object', description: 'Example/skeleton body shown to the agent.' },
                  returns: { type: 'string', description: 'Free-form description of the response shape.' },
                  output_type: { type: 'string', enum: ['json', 'text', 'binary'] },
                  timeout_s: { type: 'number', description: 'Per-request timeout in seconds (default 30).' },
                  async: {
                    type: 'object',
                    description: 'Set this when the operation kicks off a job that you have to poll. Runtime polls automatically.',
                    properties: {
                      poll_path: { type: 'string', description: 'Path to poll. {placeholder}s are filled from the initial response body.' },
                      ready_field: { type: 'string', description: 'Dotted JSON path to the status field (default "status").' },
                      ready_values: { type: 'array', items: { type: 'string' }, description: 'Values that mean "done" (default [completed, success, succeeded, done]).' },
                      failure_values: { type: 'array', items: { type: 'string' }, description: 'Values that mean "failed" (default [failed, error, cancelled]).' },
                      result_field: { type: 'string', description: 'Optional dotted path to the useful result inside the final poll response.' },
                      interval_s: { type: 'number', description: 'Seconds between polls (default 3).' },
                      max_wait_s: { type: 'number', description: 'Stop waiting after this many seconds (default 120, max 300).' },
                    },
                  },
                },
                required: ['name', 'path'],
              },
            },
            notes: { type: 'string', description: 'Free-form notes shown to the agent in its system prompt (rate limits, gotchas, etc.).' },
          },
          required: ['name'],
        },
      },
      {
        name: 'remove_extension',
        description: 'Remove an extension from the registry.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Extension name to remove.' },
          },
          required: ['name'],
        },
      },
      {
        name: 'import_file',
        description: 'Import an uploaded file into the data/ directory. Use this when the user attaches a file and you need to save it to your workspace. If a file with the same destination already exists, it will be saved with a numeric suffix instead (e.g. "foo.png" → "foo-2.png") to avoid overwriting. The response\'s `file` field is the actual saved path — use that when storing references.',
        parameters: {
          type: 'object',
          properties: {
            source: { type: 'string', description: 'Full path to the uploaded file.' },
            destination: { type: 'string', description: 'Filename to save as in data/ (e.g., "images/main_course.png"). Prefer the original filename when reasonable.' },
          },
          required: ['source', 'destination'],
        },
      },

      // ── Database tools ──

      {
        name: 'run_query',
        description: 'Execute a SQL query on the workspace SQLite database (data/database.sqlite). Use for CREATE TABLE, INSERT, UPDATE, DELETE, SELECT. Use parameterized queries with ? placeholders for user-provided values.',
        parameters: {
          type: 'object',
          properties: {
            sql: { type: 'string', description: 'SQL query to execute.' },
            params: { description: 'Array of values for ? placeholders in the query.', type: 'array', items: {} },
          },
          required: ['sql'],
        },
      },
      {
        name: 'list_tables',
        description: 'List all tables in the workspace SQLite database with their schemas.',
        parameters: { type: 'object', properties: {} },
      },

      // ── Agent tools (admin only — author your own code tools) ──

      {
        name: 'create_agent_tool',
        description: 'Create (or replace) an "agent tool" — a custom code tool that lives in this agent\'s own tools/ folder and runs deterministic logic (SQL, state machines) on the agent\'s SQLite database. Provide the full JavaScript ESM module `code` that `export default { definitions, handlers }` — each handler is `async (ctx, args) => <JSON string>`, where `ctx = { workspace, paths, config, event, db, sql }` (ctx.db is a better-sqlite3 handle; ctx.sql(query, params) runs a query). The module is written to tools/<name>.js and registered in .aaas/config.json, then loaded immediately. Tool names must be unique (they cannot override built-in or connector tools). Note: execution requires the host to allow agent tools (env AAAS_ALLOW_AGENT_TOOLS); if disabled, the tool is saved but will not run until the operator enables it. Owner/admin only.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Module name — letters, numbers, _ or - only. Becomes tools/<name>.js.' },
            code: { type: 'string', description: 'Full JS ESM module source that `export default { definitions: [...], handlers: {...} }`.' },
          },
          required: ['name', 'code'],
        },
      },
      {
        name: 'list_agent_tools',
        description: 'List this agent\'s registered agent tools (custom code tools): which are registered in config, whether their files exist on disk, and which are currently active in the running toolset. Owner/admin only.',
        parameters: { type: 'object', properties: {} },
      },
      {
        name: 'remove_agent_tool',
        description: 'Remove one of this agent\'s agent tools: deletes tools/<name>.js and unregisters it from .aaas/config.json, then drops it from the live toolset. Owner/admin only.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The agent tool module name to remove.' },
          },
          required: ['name'],
        },
      },

      // ── Operator notifications ──

      {
        name: 'notify_owner',
        description: 'Send a short message to your owner on their preferred channels (Telegram / WhatsApp / Email). Use this when you need the operator\'s attention: a customer disputes a delivery, you receive an unusual or out-of-scope request, an external API is repeatedly failing, a transaction is unusually large, or you genuinely don\'t know how to handle a situation. Keep messages short and specific. Include the transaction ID, customer name, and what you need from the owner. Do NOT use for routine activity, marketing updates, or questions you can answer yourself.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'One-line headline (e.g., "Dispute on transaction #abc123").' },
            message: { type: 'string', description: 'Plain-text body. Include the relevant transaction ID, customer name or username, and a clear ask.' },
            severity: { type: 'string', enum: ['info', 'warning', 'urgent'], description: 'Urgency hint shown as a tag in the alert. Default: info.' },
          },
          required: ['title', 'message'],
        },
      },

      // ── Platform interaction ──

      {
        name: 'platform_request',
        description: 'Make an HTTP request to a connected platform API (e.g., Truuze, OpenClaw). Auth headers are injected automatically. Use this to post content, follow users, react, send messages, and any other platform action described in the platform skill. For media fields (image_0_1, audio_0_1, video_0_1, file_0_1), provide a URL (https://...) or a workspace file path (e.g., "data/products/photo.jpg") as the value — the file will be downloaded/read and attached automatically.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Full API URL (e.g., "https://origin.truuze.com/api/v1/daybook/voice/creat/").' },
            method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'HTTP method. Defaults to GET.' },
            body: { type: 'object', description: 'Request body (JSON object). For content fields using the {type}_{index}_{group} pattern: text fields are sent as strings; media fields (image, audio, video, file) accept a URL or workspace file path and are uploaded as files automatically.' },
            headers: { type: 'object', description: 'Extra headers to include (auth headers are added automatically).' },
          },
          required: ['url'],
        },
      },

      // ── Web tools ──

      {
        name: 'web_search',
        description: 'Search the web for information. Returns titles, URLs, and snippets. Requires a search API key in .aaas/config.json.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query.' },
            num_results: { type: 'number', description: 'Number of results to return (default 5, max 10).' },
          },
          required: ['query'],
        },
      },
      {
        name: 'web_fetch',
        description: 'Fetch a web page or API endpoint and return its text content. HTML is automatically stripped to readable text. Use this to read articles, documentation, product pages, or any public URL.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The URL to fetch (must start with http:// or https://).' },
          },
          required: ['url'],
        },
      },
      {
        name: 'image_search',
        description: 'Search the web for photos matching a query and get back a list of image results — each with a direct `image_url`, a `thumbnail_url`, and the `source_page` it came from. Use this to find a picture of a person or thing (e.g. after you have confirmed who someone is: "Full Name, City, job title"). To show an image in chat, include its `image_url` in your reply text. Requires a Serper API key (Settings → Web search).',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What to find a picture of, e.g. a person\'s name plus a distinguishing detail.' },
            num_results: { type: 'number', description: 'How many image results to return (default 6).' },
          },
          required: ['query'],
        },
      },
      {
        name: 'place_call',
        description: "Place an outbound phone call to a phone number and talk live with whoever answers, on your owner's behalf — e.g. call a business to ask a question. You open by introducing yourself by name as an AI agent and stating your purpose, have a short spoken conversation, and hang up with end_call when done. Only works when the owner has enabled outbound calling in Settings. Use sparingly, for legitimate inquiries to public/business numbers; never for anything harassing or to premium/emergency numbers.",
        parameters: {
          type: 'object',
          properties: {
            to: { type: 'string', description: 'Phone number to call, ideally in +country format (e.g. "+9714XXXXXXX"). Emergency and short-code numbers are blocked; international is off unless the owner enabled it.' },
            purpose: { type: 'string', description: 'Why you are calling — one clear sentence. It becomes your spoken opening.' },
          },
          required: ['to', 'purpose'],
        },
      },
      {
        name: 'end_call',
        description: 'End the outbound phone call you are currently on. Call this once you have said your closing line and gotten what you needed — the line hangs up after your final words finish playing. Only meaningful during a live call you placed.',
        parameters: { type: 'object', properties: {} },
      },
      {
        name: 'read_image',
        description: 'Look at an image a user sent (a photo, a screenshot) and get a text description of what it contains — so you can "see" it. Pass the workspace-relative path from the message\'s "[Attached files: image: data/inbox/...]" note. Optionally pass `question` to focus the reading (e.g. "transcribe this chat, note who said what" or "describe the palm lines"). Returns { description }, or { error } when vision isn\'t set up — in which case, fall back gracefully (offer a non-visual option).',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Workspace-relative path to the saved image, e.g. "data/inbox/user_123_photo.jpg".' },
            question: { type: 'string', description: 'Optional. What to focus on when reading the image.' },
          },
          required: ['path'],
        },
      },
    ];
  }

  /**
   * Execute a tool by name with given arguments.
   * Returns a string result for the LLM.
   *
   * Connector-owned tools are dispatched first; the base switch handles the
   * engine's built-in tools.
   */
  async executeTool(name, args) {
    if (name === 'platform_request') {
      console.log('[executeTool] platform_request args:', JSON.stringify(args, null, 2));
    }
    try {
      const connectorEntry = this.connectorHandlers[name];
      if (connectorEntry) {
        return await this._retryNetworkTool(
          () => connectorEntry.fn(this.workspace, args, this.eventContext),
          name,
        );
      }
      // Workspace (agent-owned) tools — dispatched with the rich ctx. The tool
      // owns its own retry/error semantics; the outer try/catch returns { error }.
      const workspaceEntry = this.agentHandlers[name];
      if (workspaceEntry) {
        return await workspaceEntry.fn(this._agentToolContext(), args);
      }
      let result;
      switch (name) {
        case 'search_data':
          return await searchData(this.paths, args);
        case 'read_memory':
          return readMemory(this.workspace, args, this.eventContext || {});
        case 'save_memory':
          return saveMemory(this.workspace, args, this.eventContext || {});
        case 'forget_memory': {
          const r = forgetMemory(this.workspace, args, this.eventContext || {});
          this._autoLogToolResult('forget_memory', args, r);
          return r;
        }
        case 'call_extension':
          return await this._retryNetworkTool(() => callExtension(this.paths, args), 'call_extension');
        case 'create_transaction': {
          const { parsed, parsedItems, currencyDecl } = this._getParsedTransactionFields();
          const v = validateTransactionPayload(args, parsed, parsedItems, { mode: 'create', currencyDecl });
          if (!v.ok) return JSON.stringify({ error: v.error });
          // Stamp the customer session location onto the row so the dashboard
          // can later read/inject into the right session for admin messaging.
          // Lands as a top-level field via createTransaction's customFields spread.
          // When SKILL.md declares a Currency, use its default in place of
          // the engine's hardcoded `$` when the agent omits currency.
          const argsWithDefaults = {
            ...args,
            session_platform: args.session_platform || this.eventContext?.platform || null,
            currency: args.currency || currencyDecl?.default || args.currency,
          };
          const r = createTransaction(this.paths, argsWithDefaults);
          this._autoLogToolResult('create_transaction', argsWithDefaults, r);
          this._notifyTransactionSafe('created', r);
          return r;
        }
        case 'update_transaction': {
          const { parsed, parsedItems, currencyDecl } = this._getParsedTransactionFields();
          const v = validateTransactionPayload(args, parsed, parsedItems, { mode: 'update', currencyDecl });
          if (!v.ok) return JSON.stringify({ error: v.error });
          const r = updateTransaction(this.paths, args);
          this._autoLogToolResult('update_transaction', args, r);
          this._notifyTransactionSafe('updated', r);
          return r;
        }
        case 'complete_transaction': {
          const r = completeTransaction(this.paths, args);
          this._autoLogToolResult('complete_transaction', args, r);
          this._notifyTransactionSafe('completed', r);
          return r;
        }
        case 'cancel_transaction': {
          const r = cancelTransaction(this.paths, args, this.eventContext || {});
          this._autoLogToolResult('cancel_transaction', args, r);
          this._notifyTransactionSafe('cancelled', r);
          return r;
        }
        case 'list_transactions':
          return listTransactions(this.paths, args);
        case 'attach_file_to_transaction':
          return attachFileToTransaction(this.paths, args);
        case 'schedule_action': {
          // Default the target session to the current event's session so the
          // agent doesn't have to know its own platform/userId.
          const ctx = this.eventContext || {};
          if (!ctx.platform || !ctx.userId) {
            return JSON.stringify({ error: 'schedule_action requires an active conversation (no platform/userId in context).' });
          }
          const r = scheduleAction(this.paths, {
            delayMinutes: args.delay_minutes,
            instruction: args.instruction,
            session: { platform: ctx.platform, user_id: ctx.userId, user_name: ctx.userName },
            context: args.context,
          });
          if (r.error) return JSON.stringify({ error: r.error });
          return JSON.stringify({
            ok: true,
            id: r.id,
            fires_at: r.fires_at,
            message: `Scheduled action ${r.id} to fire at ${r.fires_at}.`,
          });
        }
        case 'list_scheduled_actions': {
          const ctx = this.eventContext || {};
          const all = loadPending(this.paths);
          const list = args?.this_customer_only && ctx.platform && ctx.userId
            ? all.filter(e => e.session?.platform === ctx.platform && e.session?.user_id === ctx.userId)
            : all;
          // Drop instructions over a length cap from listing — the agent
          // doesn't usually need the full text again, just ids and times.
          const slim = list.map(e => ({
            id: e.id, fires_at: e.fires_at,
            session: e.session,
            instruction_preview: (e.instruction || '').slice(0, 120),
          }));
          return JSON.stringify({ count: slim.length, actions: slim });
        }
        case 'cancel_scheduled_action': {
          if (!args?.id) return JSON.stringify({ error: 'id is required.' });
          const ok = removeAction(this.paths, args.id);
          return JSON.stringify(ok
            ? { ok: true, message: `Cancelled scheduled action ${args.id}.` }
            : { ok: false, message: `No scheduled action with id ${args.id}.` });
        }
        case 'read_skill':
          return readSkill(this.paths);
        case 'write_skill':
          return writeSkill(this.paths, args);
        case 'apply_template_variables':
          return applyTemplateVariables(this.paths, args);
        case 'rename_data_file':
          return renameDataFile(this.paths, args);
        case 'read_soul':
          return readSoul(this.paths);
        case 'write_soul':
          return writeSoul(this.paths, args);
        case 'read_data_file':
          return readDataFile(this.paths, args);
        case 'write_data_file':
          return writeDataFile(this.paths, args);
        case 'add_data_record':
          return addDataRecord(this.paths, args);
        case 'update_data_record':
          return updateDataRecord(this.paths, args);
        case 'delete_data_record':
          return deleteDataRecord(this.paths, args);
        case 'read_extensions':
          return readExtensions(this.paths);
        case 'add_extension':
          return addExtension(this.paths, args);
        case 'remove_extension':
          return removeExtension(this.paths, args);
        case 'import_file':
          return importFile(this.paths, args);
        case 'run_query':
          return runQuery(this.paths, args);
        case 'list_tables':
          return listTables(this.paths);
        case 'create_agent_tool': {
          const r = createAgentTool(this.paths, args);
          const parsed = JSON.parse(r);
          if (parsed.error) return r;
          // Hot-reload so the new tool is usable this turn (also enforces the
          // AAAS_ALLOW_AGENT_TOOLS gate and collision-checks).
          await this.loadAgentTools();
          const loaded = Object.values(this.agentHandlers || {}).some(e => e.module === args.name);
          const gateOff = !process.env.AAAS_ALLOW_AGENT_TOOLS;
          const note = gateOff
            ? 'Saved and registered, but agent-tool execution is disabled on this host (AAAS_ALLOW_AGENT_TOOLS is not set) — it will run once the operator enables it.'
            : (loaded
                ? 'Loaded and ready to use now.'
                : 'Saved and registered, but it did not load — check that the code default-exports { definitions, handlers } and that its tool names do not collide with existing tools.');
          return JSON.stringify({ ...parsed, loaded, note });
        }
        case 'list_agent_tools': {
          const parsed = JSON.parse(listAgentTools(this.paths));
          parsed.active = Object.keys(this.agentHandlers || {});
          return JSON.stringify(parsed);
        }
        case 'remove_agent_tool': {
          const r = removeAgentTool(this.paths, args);
          if (!JSON.parse(r).error) await this.loadAgentTools();
          return r;
        }
        case 'platform_request':
          result = await this._retryNetworkTool(() => platformRequest(this.workspace, args), 'platform_request');
          console.log('[executeTool] platform_request result:', result?.slice(0, 500));
          return result;
        case 'web_search':
          return await this._retryNetworkTool(() => webSearch(this.config, args, this.workspace), 'web_search');
        case 'image_search':
          return await this._retryNetworkTool(() => imageSearch(this.config, args, this.workspace), 'image_search');
        case 'place_call':
          return await this._retryNetworkTool(() => placeCall(this.workspace, this.config, args), 'place_call');
        case 'end_call':
          // A marker the voice pipeline detects in toolsUsed to hang up after the
          // agent's closing line finishes. No-op off a call.
          return JSON.stringify({ ok: true, ending: true, note: 'The call will end after your current reply finishes playing.' });
        case 'web_fetch':
          return await this._retryNetworkTool(() => webFetch(args), 'web_fetch');
        case 'read_image':
          return await this._retryNetworkTool(
            () => readImage({ workspace: this.workspace, config: this.config, args }),
            'read_image'
          );
        case 'notify_owner': {
          // Capture the conversation that triggered this alert so an owner
          // reply on Telegram/WhatsApp can be routed back here.
          const ctx = this.eventContext ? {
            session_platform: this.eventContext.platform,
            session_user_id: this.eventContext.userId,
            session_user_name: this.eventContext.userName,
            transaction_id: args?.transaction_id || null,
          } : null;
          const r = await notifyOwner(this.workspace, this.paths, args, ctx);
          const resultStr = JSON.stringify(r);
          this._autoLogToolResult('notify_owner', args, resultStr);
          return resultStr;
        }
        case 'log_activity': {
          const entry = this.memory.appendActivity({
            type: args?.type || 'note',
            summary: args?.summary,
            context: args?.context,
            session_id: this.eventContext
              ? `${this.eventContext.platform || 'local'}:${this.eventContext.userId || 'unknown'}`
              : null,
          });
          if (!entry) return JSON.stringify({ error: 'summary is required.' });
          return JSON.stringify({ ok: true, entry });
        }
        case 'get_activity': {
          const entries = this.memory.getActivity(args || {});
          const stats = this.memory.getActivityStats({ since_hours: args?.since_hours });
          return JSON.stringify({ ok: true, count: entries.length, stats, entries });
        }
        default:
          return JSON.stringify({ error: `Unknown tool: ${name}` });
      }
    } catch (err) {
      return JSON.stringify({ error: err.message });
    }
  }

  async _retryNetworkTool(fn, toolName) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const msg = (err.message || '').toLowerCase();
        const isTransient = msg.includes('fetch failed') || msg.includes('econnreset') ||
          msg.includes('econnrefused') || msg.includes('etimedout') || msg.includes('socket hang up') ||
          msg.includes('timeout') || msg.includes('abort') || msg.includes('502') || msg.includes('503');
        if (attempt < 3 && isTransient) {
          console.warn(`[${toolName}] Attempt ${attempt}/3 failed: ${err.message}, retrying...`);
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        throw err;
      }
    }
  }
}
