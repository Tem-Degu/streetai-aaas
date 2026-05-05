import { searchData } from './search-data.js';
import { readMemory, saveMemory } from './memory.js';
import { callExtension } from './extensions.js';
import { createTransaction, updateTransaction, completeTransaction, listTransactions, attachFileToTransaction } from './transactions.js';
import { readSkill, writeSkill, readSoul, writeSoul, readDataFile, writeDataFile, addDataRecord, updateDataRecord, deleteDataRecord, readExtensions, addExtension, removeExtension, importFile } from './workspace.js';
import { runQuery, listTables } from './database.js';
import { platformRequest } from './platform-request.js';
import { webSearch, webFetch } from './web.js';
import { listConnections } from '../../auth/connections.js';
import { loadConnectorToolModule } from '../../connectors/index.js';
import { notifyOwner } from '../../notifications/index.js';
import { MemoryManager } from '../memory/index.js';

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
    } else if (toolName === 'notify_owner') {
      const sent = parsed.sent || [];
      if (sent.length > 0) {
        const channels = sent.map(s => s.channel).join(', ');
        this._logActivity('alert_sent',
          `Alerted owner via ${channels}: ${args.title}`,
          { alert_id: parsed.alert_id, severity: args.severity, channels }
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
   * Get tool definitions in generic format for the LLM.
   * Returns base tools merged with any connector-owned tools loaded via
   * `loadConnectorTools()`.
   */
  getToolDefinitions() {
    return [...this._getBaseToolDefinitions(), ...this.connectorDefinitions];
  }

  _getBaseToolDefinitions() {
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
        description: 'Read stored facts from agent memory. Use to recall previously learned information.',
        parameters: {
          type: 'object',
          properties: {
            topic: { type: 'string', description: 'Topic to filter facts by. If omitted, returns recent facts.' },
          },
        },
      },
      {
        name: 'save_memory',
        description: 'Save a fact to persistent agent memory. Use to remember important information for future conversations.',
        parameters: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Short label for the fact (e.g., "user_tom_preference").' },
            value: { type: 'string', description: 'The fact to remember.' },
          },
          required: ['key', 'value'],
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
        description: 'Create a new service transaction for a user.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Unique transaction ID.' },
            user_id: { type: 'string', description: 'User ID or username.' },
            user_name: { type: 'string', description: 'User display name.' },
            service: { type: 'string', description: 'Service tier name.' },
            cost: { type: 'number', description: 'Service cost.' },
            currency: { type: 'string', description: 'Currency symbol or code (e.g. $, €, TK). Defaults to $ if not specified.' },
            details: { type: 'object', description: 'Additional transaction details.' },
          },
          required: ['id', 'user_id', 'service'],
        },
      },
      {
        name: 'update_transaction',
        description: 'Update an existing transaction.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Transaction ID.' },
            updates: { type: 'object', description: 'Fields to update.' },
          },
          required: ['id', 'updates'],
        },
      },
      {
        name: 'complete_transaction',
        description: 'Mark a transaction as completed and move it to the archive.',
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
        description: 'Import an uploaded file into the data/ directory. Use this when the user attaches a file and you need to save it to your workspace.',
        parameters: {
          type: 'object',
          properties: {
            source: { type: 'string', description: 'Full path to the uploaded file.' },
            destination: { type: 'string', description: 'Filename to save as in data/ (e.g., "products.json", "logo.png").' },
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
          () => connectorEntry.fn(this.workspace, args),
          name,
        );
      }
      let result;
      switch (name) {
        case 'search_data':
          return await searchData(this.paths, args);
        case 'read_memory':
          return readMemory(this.paths, args);
        case 'save_memory':
          return saveMemory(this.paths, args);
        case 'call_extension':
          return await this._retryNetworkTool(() => callExtension(this.paths, args), 'call_extension');
        case 'create_transaction': {
          const r = createTransaction(this.paths, args);
          this._autoLogToolResult('create_transaction', args, r);
          return r;
        }
        case 'update_transaction': {
          const r = updateTransaction(this.paths, args);
          this._autoLogToolResult('update_transaction', args, r);
          return r;
        }
        case 'complete_transaction': {
          const r = completeTransaction(this.paths, args);
          this._autoLogToolResult('complete_transaction', args, r);
          return r;
        }
        case 'list_transactions':
          return listTransactions(this.paths, args);
        case 'attach_file_to_transaction':
          return attachFileToTransaction(this.paths, args);
        case 'read_skill':
          return readSkill(this.paths);
        case 'write_skill':
          return writeSkill(this.paths, args);
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
        case 'platform_request':
          result = await this._retryNetworkTool(() => platformRequest(this.workspace, args), 'platform_request');
          console.log('[executeTool] platform_request result:', result?.slice(0, 500));
          return result;
        case 'web_search':
          return await this._retryNetworkTool(() => webSearch(this.config, args), 'web_search');
        case 'web_fetch':
          return await this._retryNetworkTool(() => webFetch(args), 'web_fetch');
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
