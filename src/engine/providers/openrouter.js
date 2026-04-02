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
      'anthropic/claude-sonnet-4-20250514',
      'anthropic/claude-haiku-4-5-20251001',
      'openai/gpt-4o',
      'openai/gpt-4o-mini',
      'google/gemini-2.0-flash-001',
      'meta-llama/llama-3.3-70b-instruct',
      'mistralai/mistral-large-latest',
    ];
  }

  async chat(messages, options = {}) {
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
      return await super.chat(messages, options);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
}
