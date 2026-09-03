import OpenAIProvider from './openai.js';

// Mistral's API is OpenAI-compatible (chat/completions + function calling), so
// this mirrors the DeepSeek/streetai providers: reuse the OpenAI client, just
// point it at Mistral's base URL. The key comes from the `mistral` credential
// or the MISTRAL_API_KEY env var (already in ENV_VAR_MAP).
const DEFAULT_BASE_URL = 'https://api.mistral.ai/v1';

export default class MistralProvider extends OpenAIProvider {
  constructor(config) {
    super({ ...config, baseUrl: config.baseUrl || DEFAULT_BASE_URL });
  }

  get name() { return 'mistral'; }
  get displayName() { return 'Mistral'; }

  listModels() {
    return ['mistral-small-latest', 'mistral-medium-latest', 'mistral-large-latest'];
  }
}
