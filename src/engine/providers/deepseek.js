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

  // Thinking-mode models return `reasoning_content` alongside `content`,
  // and DeepSeek requires that field to be passed back on subsequent turns.
  _extractAssistantExtras(rawMsg) {
    if (rawMsg?.reasoning_content) {
      return { reasoning_content: rawMsg.reasoning_content };
    }
    return null;
  }

  _applyAssistantExtras(out, extras) {
    if (extras?.reasoning_content) {
      out.reasoning_content = extras.reasoning_content;
    }
  }
}
