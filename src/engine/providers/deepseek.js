import OpenAIProvider from './openai.js';

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';

export default class DeepSeekProvider extends OpenAIProvider {
  constructor(config) {
    super({ ...config, baseUrl: config.baseUrl || DEFAULT_BASE_URL });
  }

  get name() { return 'deepseek'; }
  get displayName() { return 'DeepSeek'; }

  listModels() {
    return ['deepseek-v4-flash', 'deepseek-v4-pro'];
  }
}
