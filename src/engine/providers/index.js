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
   * @param {Array} messages - [{ role: 'system'|'user'|'assistant'|'tool', content: string, ... }]
   * @param {Object} options - { tools?, maxTokens?, temperature? }
   * @returns {{ content: string, toolCalls: Array|null, usage: { inputTokens, outputTokens } }}
   */
  async chat(messages, options = {}) { throw new Error('Not implemented'); }

  /**
   * List available models for this provider.
   */
  listModels() { return []; }
}

const PROVIDER_MODULES = {
  anthropic: () => import('./anthropic.js'),
  openai: () => import('./openai.js'),
  google: () => import('./google.js'),
  ollama: () => import('./ollama.js'),
  openrouter: () => import('./openrouter.js'),
  azure: () => import('./azure.js'),
};

const DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-4-20250514',
  openai: 'gpt-4o',
  google: 'gemini-2.0-flash',
  ollama: 'llama3.2',
  openrouter: 'anthropic/claude-sonnet-4-20250514',
  azure: 'gpt-4o',
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
 * Translate generic tool definitions to provider-specific format.
 * Generic format: { name, description, parameters: { type: 'object', properties, required } }
 */
export function translateToolsForProvider(providerName, tools) {
  if (!tools || tools.length === 0) return undefined;

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
