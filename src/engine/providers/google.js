import { BaseProvider, translateToolsForProvider } from './index.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export default class GoogleProvider extends BaseProvider {
  get name() { return 'google'; }

  listModels() {
    return ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-pro', 'gemini-1.5-flash'];
  }

  async chat(messages, options = {}) {
    // Convert messages to Gemini format
    const { systemInstruction, contents } = convertMessages(messages);

    const body = { contents };
    if (systemInstruction) body.systemInstruction = systemInstruction;

    if (options.tools?.length > 0) {
      body.tools = translateToolsForProvider('google', options.tools);
    }

    if (options.maxTokens) {
      body.generationConfig = { maxOutputTokens: options.maxTokens };
    }
    if (options.temperature !== undefined) {
      body.generationConfig = { ...body.generationConfig, temperature: options.temperature };
    }

    const url = `${API_BASE}/models/${this.model}:generateContent?key=${this.apiKey}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      if (res.status === 400) throw new Error(`Google API error: ${err}`);
      if (res.status === 403) throw new Error('Invalid Google API key. Run: aaas config');
      throw new Error(`Google API error ${res.status}: ${err}`);
    }

    const data = await res.json();
    return parseResponse(data);
  }
}

function convertMessages(messages) {
  let systemInstruction = null;
  const contents = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemInstruction = systemInstruction
        ? { parts: [{ text: systemInstruction.parts[0].text + '\n\n' + msg.content }] }
        : { parts: [{ text: msg.content }] };
      continue;
    }

    if (msg.role === 'tool') {
      contents.push({
        role: 'function',
        parts: [{
          functionResponse: {
            name: msg.toolCallId,
            response: { result: msg.content },
          },
        }],
      });
      continue;
    }

    const role = msg.role === 'assistant' ? 'model' : 'user';

    if (msg.toolCalls) {
      const parts = [];
      if (msg.content) parts.push({ text: msg.content });
      for (const tc of msg.toolCalls) {
        parts.push({
          functionCall: { name: tc.name, args: tc.arguments },
        });
      }
      contents.push({ role, parts });
      continue;
    }

    contents.push({ role, parts: [{ text: msg.content }] });
  }

  return { systemInstruction, contents };
}

function parseResponse(data) {
  const candidate = data.candidates?.[0];
  if (!candidate) throw new Error('No response from Google');

  let content = '';
  let toolCalls = null;

  for (const part of candidate.content?.parts || []) {
    if (part.text) content += part.text;
    if (part.functionCall) {
      if (!toolCalls) toolCalls = [];
      const tcName = part.functionCall.name;
      toolCalls.push({
        id: tcName,
        name: tcName,
        arguments: part.functionCall.args || {},
      });
    }
  }

  return {
    content,
    toolCalls,
    stopReason: candidate.finishReason,
    usage: {
      inputTokens: data.usageMetadata?.promptTokenCount || 0,
      outputTokens: data.usageMetadata?.candidatesTokenCount || 0,
    },
  };
}
