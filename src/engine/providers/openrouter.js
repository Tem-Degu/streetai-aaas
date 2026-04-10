import OpenAIProvider from './openai.js';

/**
 * OpenRouter uses the OpenAI-compatible API with a different base URL and headers.
 */
export default class OpenRouterProvider extends OpenAIProvider {
  constructor(config) {
    super({
      ...config,
      baseUrl: config.baseUrl || 'https://openrouter.ai/api/v1',
    });
    this.openRouterApiKey = config.apiKey;
  }

  get name() { return 'openrouter'; }

  listModels() {
    return [
      'openai/gpt-5.4',
      'openai/gpt-5.4-mini',
      'openai/o3',
      'openai/gpt-5',
      'anthropic/claude-opus-4-6',
      'anthropic/claude-sonnet-4-6',
      'google/gemini-3.1-pro-preview',
      'google/gemini-2.5-pro',
      'mistralai/mistral-small-2603',
    ];
  }

  async _chat(messages, options = {}) {
    // Override the fetch to add OpenRouter-specific headers
    const originalFetch = globalThis.fetch;
    const apiKey = this.openRouterApiKey;

    globalThis.fetch = (url, opts) => {
      opts.headers = {
        ...opts.headers,
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://github.com/aaas-protocol/aaas',
        'X-Title': 'AaaS Agent',
      };
      return originalFetch(url, opts);
    };

    try {
      return await super._chat(messages, options);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
}
