import fs from 'fs';
import path from 'path';
import { readText, getWorkspacePaths, getPlatformSkillPath } from '../utils/workspace.js';
import { getProviderCredential } from '../auth/credentials.js';
import { createProvider } from './providers/index.js';
import { ContextAssembler, estimateTokens } from './context.js';
import { ToolRegistry } from './tools/index.js';
import { SessionManager } from './sessions/index.js';
import { compressSession } from './sessions/compress.js';
import { MemoryManager } from './memory/index.js';
import { readJson } from '../utils/workspace.js';
import { buildBasePrompt } from './base-prompt.js';

const MAX_TOOL_ROUNDS = 10;

export class AgentEngine {
  /**
   * @param {Object} opts
   * @param {string} opts.workspace - Workspace root path
   * @param {string} opts.provider - Provider name (anthropic, openai, etc.)
   * @param {Object} opts.config - Workspace config (.aaas/config.json contents)
   */
  constructor({ workspace, provider: providerName, config = {} }) {
    this.workspace = workspace;
    this.providerName = providerName;
    this.config = config;
    this.paths = getWorkspacePaths(workspace);

    this.provider = null;
    this.contextAssembler = null;
    this.toolRegistry = null;
    this.sessionManager = null;
    this.memoryManager = null;

    this.basePrompt = '';
    this.skill = '';
    this.soul = '';
    this.agentName = '';
    this.initialized = false;
  }

  async initialize() {
    // Build base prompt (AaaS fundamentals + workspace state)
    this.basePrompt = buildBasePrompt(this.paths);

    // Load SKILL.md and SOUL.md
    this.skill = readText(this.paths.skill) || '';
    this.soul = readText(this.paths.soul) || '';

    // Extract agent name from SKILL.md
    const nameMatch = this.skill.match(/^#\s+(.+?)(?:\s*—|\s*-|\n)/m);
    this.agentName = nameMatch ? nameMatch[1].trim() : path.basename(this.workspace);

    // Create LLM provider
    this.provider = await createProvider(this.providerName, {
      model: this.config.model,
      baseUrl: this.config.baseUrl,
    });

    // Initialize subsystems
    const budgets = this.config.context?.budgets;
    this.contextAssembler = new ContextAssembler(budgets);
    this.toolRegistry = new ToolRegistry(this.workspace, this.paths);
    this.sessionManager = new SessionManager(this.workspace);
    this.memoryManager = new MemoryManager(this.workspace);

    this.initialized = true;
  }

  /**
   * Process an event from any platform.
   * @param {Object} event
   * @param {string} event.platform - Platform ID (truuze, telegram, http, local)
   * @param {string} event.userId - User identifier on that platform
   * @param {string} event.userName - Display name
   * @param {string} event.type - Event type (message, comment, mention, reaction, new_listener)
   * @param {string} event.content - The message/event text
   * @param {Object} event.metadata - Extra platform-specific data
   * @returns {{ response: string, toolsUsed: string[], tokensUsed: number }}
   */
  async processEvent(event) {
    if (!this.initialized) throw new Error('Engine not initialized. Call initialize() first.');

    const { platform, userId, userName, content, metadata } = event;

    // 0. Handle /admin and /customer mode commands
    const trimmed = (content || '').trim().toLowerCase();
    if (trimmed === '/admin' || trimmed === '/customer') {
      const isOwner = metadata?.is_owner || platform === 'local';
      if (!isOwner) {
        return { response: 'Only the owner can switch modes.', toolsUsed: [], tokensUsed: 0 };
      }
      const newMode = trimmed === '/admin' ? 'admin' : 'customer';
      this.sessionManager.setSessionMeta(platform, userId, 'mode', newMode);
      const modeLabel = newMode === 'admin' ? 'Admin' : 'Customer';
      return { response: `Switched to **${modeLabel}** mode.`, toolsUsed: [], tokensUsed: 0 };
    }

    // 1. Get existing session history (before adding new message)
    const sessionBefore = this.sessionManager.getSession(platform, userId);
    const previousMessages = [...sessionBefore.messages];
    const sessionSummary = sessionBefore.summary;

    // 2. Add incoming message to session
    this.sessionManager.addMessage(platform, userId, {
      role: 'user',
      content: content,
    });

    // 3. Get relevant memory facts
    const relevantFacts = this.memoryManager.getRelevantFacts(
      content,
      this.config.context?.budgets?.memory || 2000
    );

    // 4. Build platform context if available
    let platformContext = '';
    if (userName) platformContext += `User: ${userName} (${userId})\n`;
    if (platform !== 'local') platformContext += `Platform: ${platform}\n`;
    if (event.type && event.type !== 'message') platformContext += `Event type: ${event.type}\n`;
    if (metadata) {
      for (const [k, v] of Object.entries(metadata)) {
        if (typeof v === 'string' || typeof v === 'number') {
          platformContext += `${k}: ${v}\n`;
        }
      }
    }

    // 5. Refresh workspace state (data files / extensions may have changed)
    // Use session-stored mode if available (set by /admin or /customer commands)
    const sessionMode = this.sessionManager.getSessionMeta(platform, userId, 'mode');
    const mode = sessionMode || metadata?.mode || 'admin';
    this.basePrompt = buildBasePrompt(this.paths, { mode });

    // 5b. Load platform-specific skill if available (e.g. skills/truuze/SKILL.md)
    let platformSkill = '';
    if (platform && platform !== 'local') {
      const platformSkillPath = getPlatformSkillPath(this.workspace, platform);
      platformSkill = readText(platformSkillPath) || '';
    }

    // 6. Assemble context (previousMessages = full history BEFORE this message)
    const { messages } = this.contextAssembler.assemble({
      basePrompt: this.basePrompt,
      skill: this.skill,
      platformSkill,
      soul: this.soul,
      sessionMessages: previousMessages,
      sessionSummary,
      memoryFacts: relevantFacts,
      event: content,
      agentName: this.agentName,
      platformContext: platformContext || undefined,
    });

    // Debug: log full context sent to LLM
    try {
      const debugDir = path.join(this.workspace, '.aaas', 'debug');
      fs.mkdirSync(debugDir, { recursive: true });
      const debugData = {
        timestamp: new Date().toISOString(),
        mode,
        userId,
        userName,
        event: content,
        messagesCount: messages.length,
        estimatedTokens: messages.reduce((sum, m) => sum + estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)), 0),
        messages: messages.map((m, i) => ({
          index: i,
          role: m.role,
          contentLength: (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).length,
          contentPreview: (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).slice(0, 500),
        })),
        fullSystemPrompt: messages.find(m => m.role === 'system')?.content || '',
      };
      fs.writeFileSync(path.join(debugDir, 'last_context.json'), JSON.stringify(debugData, null, 2));
    } catch (e) { /* debug logging should never break chat */ }

    // 7. Call LLM with tool loop
    const ADMIN_ONLY_TOOLS = ['read_skill', 'write_skill', 'read_soul', 'write_soul', 'read_data_file', 'write_data_file', 'read_extensions', 'add_extension', 'remove_extension', 'run_query', 'list_tables'];
    let tools = this.toolRegistry.getToolDefinitions();
    if (mode !== 'admin') {
      tools = tools.filter(t => !ADMIN_ONLY_TOOLS.includes(t.name));
    }

    // Debug: append tools info
    try {
      const debugDir = path.join(this.workspace, '.aaas', 'debug');
      const debugFile = path.join(debugDir, 'last_context.json');
      const debugData = JSON.parse(fs.readFileSync(debugFile, 'utf-8'));
      debugData.toolsProvided = tools.map(t => t.name);
      debugData.toolsCount = tools.length;
      fs.writeFileSync(debugFile, JSON.stringify(debugData, null, 2));
    } catch (e) { /* */ }

    const toolsUsed = [];
    let totalTokens = 0;
    let currentMessages = [...messages];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const isLastRound = round === MAX_TOOL_ROUNDS - 1;

      const result = await this.provider.chat(currentMessages, {
        tools: isLastRound ? undefined : tools, // no tools on last round to force text response
        maxTokens: this.config.context?.budgets?.response || 4096,
      });

      totalTokens += (result.usage?.inputTokens || 0) + (result.usage?.outputTokens || 0);

      // No tool calls — we have a text response
      if (!result.toolCalls || result.toolCalls.length === 0) {
        const response = result.content;

        // 7. Save response to session
        this.sessionManager.addMessage(platform, userId, {
          role: 'assistant',
          content: response,
        });

        // 8. Async: compress session if over budget
        this._maybeCompress(platform, userId);

        // 9. Async: extract memory facts
        this._maybeExtractFacts(platform, userId);

        return { response, toolsUsed, tokensUsed: totalTokens };
      }

      // Execute tool calls
      const assistantMsg = {
        role: 'assistant',
        content: result.content || '',
        toolCalls: result.toolCalls,
      };
      currentMessages.push(assistantMsg);

      for (const tc of result.toolCalls) {
        toolsUsed.push({ name: tc.name, arguments: tc.arguments });
        const toolResult = await this.toolRegistry.executeTool(tc.name, tc.arguments);

        // Reload skill/soul if they were just modified
        if (tc.name === 'write_skill') {
          this.skill = readText(this.paths.skill) || '';
          const nameMatch = this.skill.match(/^#\s+(.+?)(?:\s*—|\s*-|\n)/m);
          this.agentName = nameMatch ? nameMatch[1].trim() : path.basename(this.workspace);
        } else if (tc.name === 'write_soul') {
          this.soul = readText(this.paths.soul) || '';
        }

        currentMessages.push({
          role: 'tool',
          toolCallId: tc.id,
          content: toolResult,
        });
      }
    }

    // Shouldn't reach here, but return last content if we do
    return { response: 'I was unable to complete the request. Please try again.', toolsUsed, tokensUsed: totalTokens };
  }

  /**
   * Simplified chat for CLI/dashboard.
   * @param {string} message
   * @param {Object} opts
   * @param {'admin'|'customer'} opts.mode - Chat mode
   */
  async processChat(message, { mode = 'admin' } = {}) {
    const isAdmin = mode === 'admin';
    return this.processEvent({
      platform: 'local',
      userId: isAdmin ? 'owner' : 'customer',
      userName: isAdmin ? 'Owner' : 'Customer',
      type: 'message',
      content: message,
      metadata: { mode },
    });
  }

  getStatus() {
    return {
      initialized: this.initialized,
      agentName: this.agentName,
      provider: this.providerName,
      model: this.config.model,
      sessionsActive: this.sessionManager?.listSessions().length || 0,
      factsCount: this.memoryManager?.getAllFacts().length || 0,
      toolsAvailable: this.toolRegistry?.getToolDefinitions().length || 0,
    };
  }

  /**
   * Compress session in the background if it's getting large.
   */
  _maybeCompress(platform, userId) {
    const threshold = this.config.context?.sessionCompressAt || 4000;
    const session = this.sessionManager.getSession(platform, userId);
    const totalTokens = session.messages.reduce(
      (sum, m) => sum + estimateTokens(m.content || ''), 0
    );

    if (totalTokens > threshold) {
      compressSession(this.provider, session).then(summary => {
        if (summary) {
          this.sessionManager.applySummary(platform, userId, summary);
        }
      }).catch(() => { /* non-critical */ });
    }
  }

  /**
   * Extract memory facts in the background after an interaction.
   */
  _maybeExtractFacts(platform, userId) {
    const session = this.sessionManager.getSession(platform, userId);

    // Only extract every 5 messages to save LLM calls
    if (session.messages.length % 5 !== 0) return;

    this.memoryManager.extractFacts(this.provider, session.messages)
      .then(() => {
        const maxFacts = this.config.context?.memoryMaxFacts || 200;
        this.memoryManager.pruneOldest(maxFacts);
      })
      .catch(() => { /* non-critical */ });
  }
}
