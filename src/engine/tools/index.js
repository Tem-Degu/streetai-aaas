import { searchData } from './search-data.js';
import { readMemory, saveMemory } from './memory.js';
import { callExtension } from './extensions.js';
import { createTransaction, updateTransaction, completeTransaction, listTransactions, attachFileToTransaction } from './transactions.js';
import { readSkill, writeSkill, readSoul, writeSoul, readDataFile, writeDataFile, addDataRecord, updateDataRecord, deleteDataRecord, readExtensions, addExtension, removeExtension, importFile } from './workspace.js';
import { runQuery, listTables } from './database.js';
import { platformRequest } from './platform-request.js';
import { webSearch, webFetch } from './web.js';

/**
 * Tool registry. Returns tool definitions for the LLM and dispatches execution.
 */
export class ToolRegistry {
  constructor(workspace, paths, config = {}) {
    this.workspace = workspace;
    this.paths = paths;
    this.config = config;
  }

  /**
   * Get tool definitions in generic format for the LLM.
   */
  getToolDefinitions() {
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
        name: 'call_extension',
        description: 'Call an external API extension or send a message to another AaaS agent. For API extensions: specify method, path, and data. For agent extensions: just provide a message and the other agent responds in natural language.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Extension name from extensions/registry.json.' },
            method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'], description: 'HTTP method (API extensions only).' },
            path: { type: 'string', description: 'API path appended to extension base URL (API extensions only).' },
            data: { type: 'object', description: 'Request body for POST/PUT (API extensions), or { message: "..." } for agent extensions.' },
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
        description: 'Add or update an extension in the registry.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Extension name.' },
            type: { type: 'string', enum: ['api', 'agent', 'human', 'tool'], description: 'Extension type.' },
            endpoint: { type: 'string', description: 'Base URL for API extensions.' },
            capabilities: { type: 'array', items: { type: 'string' }, description: 'List of capabilities.' },
            description: { type: 'string', description: 'What this extension does.' },
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
   */
  async executeTool(name, args) {
    if (name === 'platform_request') {
      console.log('[executeTool] platform_request args:', JSON.stringify(args, null, 2));
    }
    try {
      let result;
      switch (name) {
        case 'search_data':
          return await searchData(this.paths, args);
        case 'read_memory':
          return readMemory(this.paths, args);
        case 'save_memory':
          return saveMemory(this.paths, args);
        case 'call_extension':
          return await callExtension(this.paths, args);
        case 'create_transaction':
          return createTransaction(this.paths, args);
        case 'update_transaction':
          return updateTransaction(this.paths, args);
        case 'complete_transaction':
          return completeTransaction(this.paths, args);
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
          result = await platformRequest(this.workspace, args);
          console.log('[executeTool] platform_request result:', result?.slice(0, 500));
          return result;
        case 'web_search':
          return await webSearch(this.config, args);
        case 'web_fetch':
          return await webFetch(args);
        default:
          return JSON.stringify({ error: `Unknown tool: ${name}` });
      }
    } catch (err) {
      return JSON.stringify({ error: err.message });
    }
  }
}
