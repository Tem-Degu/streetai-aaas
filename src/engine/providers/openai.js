import { BaseProvider, translateToolsForProvider } from './index.js';

const API_URL = 'https://api.openai.com/v1/chat/completions';

export default class OpenAIProvider extends BaseProvider {
  constructor(config) {
    super(config);
    this.apiUrl = config.baseUrl
      ? `${config.baseUrl.replace(/\/$/, '')}/chat/completions`
      : API_URL;
  }

  get name() { return 'openai'; }

  listModels() {
    return ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1', 'o1-mini'];
  }

  async chat(messages, options = {}) {
    const body = {
      model: this.model,
      messages: messages.map(formatMessage),
      max_tokens: options.maxTokens || 4096,
    };

    if (options.temperature !== undefined) body.temperature = options.temperature;

    if (options.tools?.length > 0) {
      body.tools = translateToolsForProvider('openai', options.tools);
    }

    const res = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      if (res.status === 401) throw new Error('Invalid OpenAI API key. Run: aaas config');
      if (res.status === 429) throw new Error('Rate limited by OpenAI. Wait a moment and try again.');
      throw new Error(`OpenAI API error ${res.status}: ${err}`);
    }

    const data = await res.json();
    return parseResponse(data);
  }
}

function formatMessage(msg) {
  if (msg.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: msg.toolCallId,
      content: msg.content,
    };
  }

  if (msg.role === 'assistant' && msg.toolCalls) {
    return {
      role: 'assistant',
      content: msg.content || null,
      tool_calls: msg.toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        },
      })),
    };
  }

  return { role: msg.role, content: msg.content };
}

function parseResponse(data) {
  const choice = data.choices?.[0];
  if (!choice) throw new Error('No response from OpenAI');

  const msg = choice.message;
  let toolCalls = null;

  if (msg.tool_calls?.length > 0) {
    toolCalls = msg.tool_calls.map(tc => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments || '{}'),
    }));
  }

  return {
    content: msg.content || '',
    toolCalls,
    stopReason: choice.finish_reason,
    usage: {
      inputTokens: data.usage?.prompt_tokens || 0,
      outputTokens: data.usage?.completion_tokens || 0,
    },
  };
}
