import OpenAIProvider from './openai.js';

/**
 * StreetAI is a hosted, OpenAI-compatible multi-model gateway (same shape as the
 * OpenRouter provider). One base URL + one issued key; the `model` string
 * selects the underlying model, which the gateway routes to the right upstream
 * provider on StreetAI's accounts and meters for billing.
 *
 * v1 lists only OpenAI-native models (DeepSeek / OpenAI / Gemini) so the gateway
 * is pure pass-through. Anthropic is added once the gateway's OpenAI⇄Anthropic
 * translation layer is in.
 */
const DEFAULT_BASE_URL = 'https://streetai.org/llm/v1';

export default class StreetAIProvider extends OpenAIProvider {
  constructor(config) {
    super({ ...config, baseUrl: config.baseUrl || DEFAULT_BASE_URL });
  }

  get name() { return 'streetai'; }
  get displayName() { return 'StreetAI'; }

  listModels() {
    return [
      'deepseek-v4-flash',
      'gpt-5.4-mini',
      'gemini-2.5-flash',
      'deepseek-v4-pro',
      'gemini-2.5-pro',
      'gpt-5.4',
    ];
  }

  // Defensive: when the gateway routes to DeepSeek, thinking models return
  // `reasoning_content` that must be echoed back on later turns. Handling it
  // here (harmless no-op for other upstreams) keeps multi-turn correct
  // regardless of which model the gateway routed to.
  _extractAssistantExtras(rawMsg) {
    if (rawMsg?.reasoning_content) return { reasoning_content: rawMsg.reasoning_content };
    return null;
  }

  _applyAssistantExtras(out, extras) {
    if (extras?.reasoning_content) out.reasoning_content = extras.reasoning_content;
  }
}
