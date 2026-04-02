import OpenAIProvider from './openai.js';

/**
 * Azure OpenAI uses the same format as OpenAI but with different URL structure and auth.
 * Supports both API key and OAuth (Azure AD) authentication.
 */
export default class AzureProvider extends OpenAIProvider {
  constructor(config) {
    const endpoint = config.endpoint || config.baseUrl;
    if (!endpoint) {
      throw new Error('Azure OpenAI requires an endpoint URL. Set AZURE_OPENAI_ENDPOINT or provide it in config.');
    }

    // Azure URL: https://{resource}.openai.azure.com/openai/deployments/{model}/chat/completions?api-version=2024-02-01
    const azureUrl = `${endpoint.replace(/\/$/, '')}/openai/deployments/${config.model}/chat/completions?api-version=2024-02-01`;

    super({
      ...config,
      baseUrl: null, // prevent OpenAI base URL override
    });

    this.azureUrl = azureUrl;
    this.azureApiKey = config.apiKey;
    this.accessToken = config.accessToken;
  }

  get name() { return 'azure'; }

  listModels() {
    return ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'];
  }

  async chat(messages, options = {}) {
    // Override fetch to use Azure URL and auth
    const originalFetch = globalThis.fetch;
    const azureUrl = this.azureUrl;
    const azureApiKey = this.azureApiKey;
    const accessToken = this.accessToken;

    globalThis.fetch = (url, opts) => {
      // Replace the URL with Azure endpoint
      const headers = { ...opts.headers };

      if (accessToken) {
        headers['Authorization'] = `Bearer ${accessToken}`;
      } else if (azureApiKey) {
        headers['api-key'] = azureApiKey;
      }

      return originalFetch(azureUrl, { ...opts, headers });
    };

    try {
      return await super.chat(messages, options);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
}
