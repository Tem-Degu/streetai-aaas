import { BaseProvider, translateToolsForProvider } from './index.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

export default class AnthropicProvider extends BaseProvider {
  get name() { return 'anthropic'; }

  listModels() {
    return [
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5-20250929',
      'claude-haiku-4-5-20251001',
      'claude-opus-4-20250514',
      'claude-sonnet-4-20250514',
    ];
  }

  async _chat(messages, options = {}) {
    // Anthropic requires system message separate from messages
    const { system, conversation } = extractSystem(messages);

    const body = {
      model: this.model,
      max_tokens: options.maxTokens || 16384,
      messages: conversation,
    };

    if (system) {
      body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
    }
    if (options.temperature !== undefined) body.temperature = options.temperature;

    // Add tools
    if (options.tools?.length > 0) {
      const tools = translateToolsForProvider('anthropic', options.tools);
      // Cache tools (they come before system in Anthropic's cache prefix)
      if (tools.length > 0) {
        tools[tools.length - 1].cache_control = { type: 'ephemeral' };
      }
      body.tools = tools;
    }

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': API_VERSION,
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      if (res.status === 401) throw new Error('Invalid Anthropic API key. Run: aaas config');
      if (res.status === 429) throw new Error('Rate limited by Anthropic. Wait a moment and try again.');
      throw new Error(`Anthropic API error ${res.status}: ${err}`);
    }

    const data = await res.json();
    return parseResponse(data);
  }
}

function extractSystem(messages) {
  let system = '';
  const conversation = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      system += (system ? '\n\n' : '') + msg.content;
    } else {
      conversation.push(formatMessage(msg));
    }
  }

  return { system: system || undefined, conversation };
}

function formatMessage(msg) {
  // Tool results need special formatting for Anthropic
  if (msg.role === 'tool') {
    return {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: msg.toolCallId,
        content: msg.content,
      }],
    };
  }

  // Assistant messages with tool calls
  if (msg.role === 'assistant' && msg.toolCalls) {
    const content = [];
    if (msg.content) content.push({ type: 'text', text: msg.content });
    for (const tc of msg.toolCalls) {
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: tc.arguments,
      });
    }
    return { role: 'assistant', content };
  }

  return { role: msg.role, content: msg.content };
}

function parseResponse(data) {
  let content = '';
  let toolCalls = null;

  for (const block of data.content || []) {
    if (block.type === 'text') {
      content += block.text;
    } else if (block.type === 'tool_use') {
      if (!toolCalls) toolCalls = [];
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: block.input,
      });
    }
  }

  return {
    content,
    toolCalls,
    stopReason: data.stop_reason,
    usage: {
      inputTokens: data.usage?.input_tokens || 0,
      outputTokens: data.usage?.output_tokens || 0,
      cacheCreationInputTokens: data.usage?.cache_creation_input_tokens || 0,
      cacheReadInputTokens: data.usage?.cache_read_input_tokens || 0,
    },
  };
}
