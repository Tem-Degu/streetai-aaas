import { getProviderCredential } from '../../auth/credentials.js';

/**
 * Base class for LLM providers.
 * Each provider implements chat() and optionally chatStream().
 */
export class BaseProvider {
  constructor(config) {
    this.model = config.model;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl;
  }

  get name() { throw new Error('Not implemented'); }

  /**
   * Send messages to the LLM and get a response.
   * Subclasses implement _chat(). This wrapper adds retry on transient errors.
   */
  async chat(messages, options = {}) {
    const maxRetries = 4;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this._chat(messages, options);
      } catch (err) {
        if (attempt < maxRetries && isRetriableError(err)) {
          const delayMs = isRateLimitError(err) ? 8000 : 3000;
          console.warn(`[${this.name}] ${err.message} (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delayMs / 1000}s...`);
          await sleep(delayMs);
          continue;
        }
        throw err;
      }
    }
  }

  /** Subclasses implement this instead of chat(). */
  async _chat(messages, options = {}) { throw new Error('Not implemented'); }

  /**
   * List available models for this provider.
   */
  listModels() { return []; }

  /**
   * Pull provider-specific fields off a raw response message that must be
   * roundtripped on subsequent turns (e.g. DeepSeek's `reasoning_content`).
   * Override in subclasses. Return null when there are no extras.
   */
  _extractAssistantExtras(rawMsg) { return null; }

  /**
   * Reattach provider-specific fields onto an outgoing assistant message body.
   * Mirror of _extractAssistantExtras. Default: no-op.
   */
  _applyAssistantExtras(out, extras) { /* no-op */ }
}

function isRateLimitError(err) {
  const msg = (err.message || '').toLowerCase();
  return msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests');
}

function isRetriableError(err) {
  if (isRateLimitError(err)) return true;

  const msg = (err.message || '').toLowerCase();

  // Network-level failures
  if (msg.includes('fetch failed') || msg.includes('econnreset') || msg.includes('econnrefused') ||
      msg.includes('etimedout') || msg.includes('socket hang up') || msg.includes('network') ||
      msg.includes('abort') || msg.includes('timeout')) {
    return true;
  }

  // Server errors (5xx)
  if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('529') ||
      msg.includes('server error') || msg.includes('overloaded') || msg.includes('internal error')) {
    return true;
  }

  return false;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const PROVIDER_MODULES = {
  anthropic: () => import('./anthropic.js'),
  openai: () => import('./openai.js'),
  google: () => import('./google.js'),
  ollama: () => import('./ollama.js'),
  openrouter: () => import('./openrouter.js'),
  azure: () => import('./azure.js'),
  deepseek: () => import('./deepseek.js'),
};

const DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-4-20250514',
  openai: 'gpt-4o',
  google: 'gemini-2.0-flash',
  ollama: 'llama3.2',
  openrouter: 'anthropic/claude-sonnet-4-20250514',
  azure: 'gpt-4o',
  deepseek: 'deepseek-v4-flash',
};

/**
 * Create a provider instance by name.
 * Loads credentials automatically.
 */
export async function createProvider(name, config = {}) {
  const loader = PROVIDER_MODULES[name];
  if (!loader) throw new Error(`Unknown provider: ${name}. Available: ${listAvailableProviders().join(', ')}`);

  // Load credentials
  const credential = getProviderCredential(name);
  if (!credential && name !== 'ollama') {
    throw new Error(`No API key for ${name}. Run: aaas config`);
  }

  const providerConfig = {
    model: config.model || DEFAULT_MODELS[name],
    apiKey: credential?.apiKey || null,
    baseUrl: config.baseUrl || credential?.baseUrl || null,
    endpoint: credential?.endpoint || null,
    accessToken: credential?.accessToken || null,
    ...config,
  };

  const mod = await loader();
  return new mod.default(providerConfig);
}

export function listAvailableProviders() {
  return Object.keys(PROVIDER_MODULES);
}

export function getDefaultModel(providerName) {
  return DEFAULT_MODELS[providerName] || null;
}

/**
 * Walk a JSON-Schema-ish object and throw on `type` values that are arrays
 * (e.g. `type: ['string', 'number']`). Anthropic and OpenAI tolerate this
 * dialect, but Google's function-calling validator rejects it. Catching it
 * here keeps the failure mode loud and fast — and tied to the offending
 * tool's name — so it can't silently break Google deploys.
 */
function assertNoArrayTypes(toolName, schema, path = 'parameters') {
  if (!schema || typeof schema !== 'object') return;
  if (Array.isArray(schema.type)) {
    throw new Error(
      `Tool "${toolName}" has array-typed schema at ${path} (type: ${JSON.stringify(schema.type)}). ` +
      `Use a single string type and let the description disambiguate — Google's function calling does not accept type unions.`
    );
  }
  if (schema.properties && typeof schema.properties === 'object') {
    for (const [key, sub] of Object.entries(schema.properties)) {
      assertNoArrayTypes(toolName, sub, `${path}.properties.${key}`);
    }
  }
  if (schema.items) assertNoArrayTypes(toolName, schema.items, `${path}.items`);
}

/**
 * Translate generic tool definitions to provider-specific format.
 * Generic format: { name, description, parameters: { type: 'object', properties, required } }
 */
export function translateToolsForProvider(providerName, tools) {
  if (!tools || tools.length === 0) return undefined;

  for (const t of tools) assertNoArrayTypes(t.name, t.parameters);

  switch (providerName) {
    case 'anthropic':
      return tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));

    case 'openai':
    case 'openrouter':
    case 'azure':
      return tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));

    case 'google':
      return [{
        function_declarations: tools.map(t => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      }];

    case 'ollama':
      return tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));

    default:
      return tools;
  }
}
