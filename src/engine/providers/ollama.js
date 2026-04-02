import { BaseProvider, translateToolsForProvider } from './index.js';

const DEFAULT_URL = 'http://localhost:11434';

export default class OllamaProvider extends BaseProvider {
  constructor(config) {
    super(config);
    this.ollamaUrl = config.baseUrl || DEFAULT_URL;
  }

  get name() { return 'ollama'; }

  listModels() {
    return ['llama3.2', 'llama3.1', 'mistral', 'codellama', 'phi3', 'gemma2'];
  }

  async chat(messages, options = {}) {
    const body = {
      model: this.model,
      messages: messages.map(msg => ({ role: msg.role, content: msg.content })),
      stream: false,
    };

    if (options.tools?.length > 0) {
      body.tools = translateToolsForProvider('ollama', options.tools);
    }

    if (options.temperature !== undefined) {
      body.options = { temperature: options.temperature };
    }

    const url = `${this.ollamaUrl}/api/chat`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      if (res.status === 404) throw new Error(`Model "${this.model}" not found in Ollama. Run: ollama pull ${this.model}`);
      throw new Error(`Ollama error ${res.status}: ${err}`);
    }

    const data = await res.json();

    let toolCalls = null;
    if (data.message?.tool_calls?.length > 0) {
      toolCalls = data.message.tool_calls.map((tc, i) => ({
        id: `ollama_${i}`,
        name: tc.function.name,
        arguments: tc.function.arguments || {},
      }));
    }

    return {
      content: data.message?.content || '',
      toolCalls,
      stopReason: data.done ? 'end_turn' : null,
      usage: {
        inputTokens: data.prompt_eval_count || 0,
        outputTokens: data.eval_count || 0,
      },
    };
  }
}
