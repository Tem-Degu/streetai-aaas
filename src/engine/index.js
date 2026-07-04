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
import { readJson, writeJson } from '../utils/workspace.js';
import { buildBasePrompt } from './base-prompt.js';
import { saveTransactionView } from './tools/workspace.js';
import { maybeSeedTransactionFields } from './tools/transaction-view-seed.js';
import { loadPending, removeAction } from './scheduler.js';
import { syncDueDataSources } from '../datasync/index.js';
import { loadConnection, saveConnection } from '../auth/connections.js';
import { logError } from '../utils/errlog.js';
import crypto from 'crypto';

const MAX_TOOL_ROUNDS = 10;
const VOICE_MAX_TOOL_ROUNDS = 4; // tighter bound on phone calls — latency matters more than depth

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

    // Scheduler tick timer — only set when startScheduler() is called.
    // Short-lived engines (chat / run / single API call) leave it null so
    // they don't keep the process alive past their natural exit.
    this._schedulerTimer = null;
    this._schedulerTickInFlight = false;
    this._dataSyncInFlight = false;
  }

  /**
   * Start the delayed-event scheduler. Should only be called by long-lived
   * processes (the agent-worker daemon). Calls processEvent for any pending
   * scheduled action whose `fires_at` has passed. Idempotent — calling twice
   * does nothing.
   */
  startScheduler({ intervalMs = 30_000 } = {}) {
    if (this._schedulerTimer) return;
    // Catch-up sweep on start: anything overdue fires immediately, marked
    // `late: true` so the agent can word the reply accordingly.
    this._scheduledTick().catch(() => { /* non-fatal */ });
    this._dataSyncTick(); // refresh data sources on the daemon (due-checked)
    this._schedulerTimer = setInterval(() => {
      this._scheduledTick().catch(() => { /* non-fatal */ });
      this._dataSyncTick();
    }, intervalMs);
    if (this._schedulerTimer.unref) this._schedulerTimer.unref();
  }

  /**
   * Best-effort data-source refresh on the daemon. Cheap: syncDueDataSources
   * only fetches sources past their interval, and a re-entrancy guard prevents
   * overlap if a sync runs longer than the tick. No data sources → no-op.
   */
  _dataSyncTick() {
    if (this._dataSyncInFlight) return;
    this._dataSyncInFlight = true;
    syncDueDataSources(this.workspace)
      .catch(() => { /* non-fatal */ })
      .finally(() => { this._dataSyncInFlight = false; });
  }

  stopScheduler() {
    if (this._schedulerTimer) {
      clearInterval(this._schedulerTimer);
      this._schedulerTimer = null;
    }
  }

  /**
   * One tick of the scheduler. Pulls due actions, removes them from disk
   * BEFORE firing (so a concurrent tick or a crash mid-fire doesn't
   * double-trigger), then emits each as a synthetic event through
   * processEvent. Errors per-action are swallowed so one bad reminder
   * doesn't poison the rest of the batch.
   */
  async _scheduledTick() {
    if (this._schedulerTickInFlight) return;
    this._schedulerTickInFlight = true;
    try {
      const pending = loadPending(this.paths);
      const now = Date.now();
      const due = pending.filter(e => new Date(e.fires_at).getTime() <= now);
      for (const action of due) {
        // Remove first so a crash before firing doesn't leave it to retry
        // forever — at-most-once is the right tradeoff for delayed nudges.
        try { removeAction(this.paths, action.id); } catch { /* keep going */ }
        const late = (now - new Date(action.fires_at).getTime()) > 60_000;
        try {
          await this.processEvent({
            platform: action.session.platform,
            userId: action.session.user_id,
            userName: action.session.user_name || action.session.user_id,
            type: 'scheduled',
            content: `[Scheduled reminder for you${late ? ' — note: this is late, fired on next agent start' : ''}] ${action.instruction}`,
            metadata: {
              is_scheduled: true,
              scheduled_id: action.id,
              scheduled_context: action.context || null,
              late,
            },
          });
        } catch { /* per-action failures are normal turn failures */ }
      }
    } finally {
      this._schedulerTickInFlight = false;
    }
  }

  async initialize() {
    // Build base prompt (AaaS fundamentals + workspace state). The current
    // time injected here is overwritten on every processEvent — sampled at
    // the start of each turn so the model always sees fresh "now."
    this.basePrompt = buildBasePrompt(this.paths, { now: new Date() });

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
    }, this.workspace);

    // Initialize subsystems
    const budgets = this.config.context?.budgets;
    this.contextAssembler = new ContextAssembler(budgets);
    this.toolRegistry = new ToolRegistry(this.workspace, this.paths, this.config);
    this.sessionManager = new SessionManager(this.workspace);
    this.memoryManager = new MemoryManager(this.workspace);

    // Discover tools owned by configured connectors (e.g. truuze escrow tools)
    await this.toolRegistry.loadConnectorTools();

    this.initialized = true;

    // Fire-and-forget: seed the Transaction Fields block once if the skill
    // is missing it or still on template defaults. Fully isolated — never
    // throws, never blocks init. See tools/transaction-view-seed.js.
    this._kickTransactionFieldsSeed();
  }

  /**
   * Best-effort, non-blocking seeding trigger. Safe to call repeatedly —
   * the seed module dedups via a state file keyed by skill content hash.
   */
  _kickTransactionFieldsSeed() {
    if (!this.provider) return;
    Promise.resolve()
      .then(() => maybeSeedTransactionFields({ paths: this.paths, provider: this.provider }))
      .catch(() => { /* swallow — never affect the live agent loop */ });
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
    // Central error funnel: every connector reaches the agent through here, so
    // wrapping this one method captures runtime turn failures (LLM/tool/etc.)
    // for all agents in the curated error log, then re-throws so existing
    // connector fallback behavior is unchanged.
    try {
      return await this._processEvent(event);
    } catch (err) {
      logError(this.workspace, 'engine', err, {
        platform: event?.platform,
        type: event?.type,
      });
      throw err;
    }
  }

  async _processEvent(event) {
    if (!this.initialized) throw new Error('Engine not initialized. Call initialize() first.');

    const { platform, userId, userName, content, metadata } = event;

    // 0. Handle /admin and /customer mode commands + owner verification
    const trimmed = (content || '').trim().toLowerCase();

    // Check for verification code response
    if (platform !== 'local') {
      const pendingCode = this.sessionManager.getSessionMeta(platform, userId, 'pendingAdminCode');
      if (pendingCode && trimmed === pendingCode) {
        // Verification successful — save owner ID to connection config
        const conn = loadConnection(this.workspace, platform) || {};
        conn.ownerId = userId;
        saveConnection(this.workspace, platform, conn);
        this.sessionManager.setSessionMeta(platform, userId, 'pendingAdminCode', null);
        this.sessionManager.setSessionMeta(platform, userId, 'mode', 'admin');
        return { response: 'Owner verified. Switched to **Admin** mode.', toolsUsed: [], tokensUsed: 0 };
      }
    }

    if (trimmed === '/admin' || trimmed === '/customer') {
      // Re-read the saved connection config so verification done earlier in
      // this same process is honored even if the connector's in-memory
      // snapshot is stale.
      const savedConn = platform !== 'local' ? loadConnection(this.workspace, platform) : null;
      const isOwner =
        metadata?.is_owner ||
        platform === 'local' ||
        (savedConn?.ownerId && savedConn.ownerId === userId);

      if (trimmed === '/admin' && !isOwner && platform !== 'local') {
        // Generate a 6-character verification code
        const code = crypto.randomBytes(3).toString('hex');
        this.sessionManager.setSessionMeta(platform, userId, 'pendingAdminCode', code);

        // Save code to a file the dashboard can read
        const verifyDir = path.join(this.workspace, '.aaas', 'verify');
        fs.mkdirSync(verifyDir, { recursive: true });
        writeJson(path.join(verifyDir, `${platform}.json`), {
          code,
          userId,
          platform,
          requestedAt: new Date().toISOString(),
        });

        return {
          response: `To verify you are the owner, check your dashboard for the verification code and type it here.\n\nOpen the dashboard and go to **Deploy** to find the code.`,
          toolsUsed: [], tokensUsed: 0,
        };
      }

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

    // 2a. Pause check — if the admin has taken over this session via the
    // dashboard, the agent stays silent. The customer's message is still
    // recorded above (so the admin can see it in the conversation panel),
    // but we skip the LLM / tool loop entirely and return an empty
    // response so the connector doesn't auto-reply.
    //
    // Auto-resume safety net: a paused session whose `paused_at` is older
    // than pauseMaxHours (default 1h) is treated as unpaused (clears the flag
    // and proceeds normally). This protects against an admin forgetting to
    // resume the agent — a forgotten pause clears within an hour.
    //
    // The pause flag is NOT honored for events that came from the
    // dashboard itself (those are admin actions, not customer messages),
    // but right now nothing in this codepath sets metadata.from_dashboard
    // — direct admin messages bypass processEvent entirely and go straight
    // to the platform's API.
    const isPaused = this._isSessionPaused(platform, userId);
    if (isPaused) {
      return { response: '', toolsUsed: [], tokensUsed: 0, paused: true };
    }

    // 2b. Resolve mode early — needed for memory scope and tool execution.
    // Use session-stored mode if available (set by /admin or /customer commands).
    // metadata.force_admin_mode wins regardless — used by processOwnerReply
    // so an owner-reply turn runs in admin mode without polluting the
    // customer's stored session mode.
    const sessionMode = this.sessionManager.getSessionMeta(platform, userId, 'mode');
    const mode = metadata?.force_admin_mode
      ? 'admin'
      : sessionMode || metadata?.mode || 'admin';

    // 3. Get relevant memory facts. Mode determines scope: customer mode
    //    pulls this customer's user facts + business facts; admin mode pulls
    //    business facts only (admin sessions aren't customer-scoped).
    //    See engine/memory/index.js for the split rationale.
    const relevantFacts = this.memoryManager.getRelevantFactsForTurn({
      query: content,
      platform,
      userId,
      mode,
      maxTokens: this.config.context?.budgets?.memory || 2000,
    });

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

    // 5. Refresh workspace state (data files / extensions may have changed).
    // `mode` was resolved earlier (step 2b) — reused here for the base prompt.
    // `now` is sampled fresh per turn so the model's authoritative clock
    // doesn't drift across long-lived engine instances.
    this.basePrompt = buildBasePrompt(this.paths, { mode, now: new Date(), platform, channel: metadata?.channel });

    // Expose the current event to tools so notify_owner can capture context.
    if (this.toolRegistry?.setEventContext) {
      this.toolRegistry.setEventContext({
        platform, userId, userName, mode,
        is_owner: !!metadata?.is_owner,
      });
    }

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
      replyLanguage: metadata?.replyLanguage,
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
    const ADMIN_ONLY_TOOLS = ['read_skill', 'write_skill', 'apply_template_variables', 'read_soul', 'write_soul', 'read_data_file', 'write_data_file', 'rename_data_file', 'read_extensions', 'add_extension', 'remove_extension'];
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

    // Voice calls bound the tool loop tighter to keep latency low — dead air on
    // a phone call is far worse than a slightly shallower answer.
    const maxRounds = metadata?.channel === 'voice' ? VOICE_MAX_TOOL_ROUNDS : MAX_TOOL_ROUNDS;
    for (let round = 0; round < maxRounds; round++) {
      const isLastRound = round === maxRounds - 1;

      const result = await this.provider.chat(currentMessages, {
        tools: isLastRound ? undefined : tools, // no tools on last round to force text response
        maxTokens: this.config.context?.budgets?.response || 4096,
      });

      totalTokens += (result.usage?.inputTokens || 0) + (result.usage?.outputTokens || 0);

      // No tool calls — we have a text response
      if (!result.toolCalls || result.toolCalls.length === 0) {
        const response = result.content;

        // 7. Save response to session
        const finalMsg = {
          role: 'assistant',
          content: response,
        };
        if (result.providerKey) finalMsg.providerKey = result.providerKey;
        if (result.providerExtras) finalMsg.providerExtras = result.providerExtras;
        this.sessionManager.addMessage(platform, userId, finalMsg);

        // 8. Async: compress session if over budget
        this._maybeCompress(platform, userId);

        // 9. Async: extract memory facts (mode-scoped — see _maybeExtractFacts).
        this._maybeExtractFacts(platform, userId, mode);

        return { response, toolsUsed, tokensUsed: totalTokens };
      }

      // Execute tool calls
      const assistantMsg = {
        role: 'assistant',
        content: result.content || '',
        toolCalls: result.toolCalls,
      };
      if (result.providerKey) assistantMsg.providerKey = result.providerKey;
      if (result.providerExtras) assistantMsg.providerExtras = result.providerExtras;
      currentMessages.push(assistantMsg);

      // Persist a trimmed copy of this tool-call step to the session so future
      // turns see that actions go through real tool calls (which stops the model
      // from later fabricating "done" without calling the tool) and so it
      // remembers what it did. Best-effort — never breaks the turn.
      try {
        this.sessionManager.addMessage(platform, userId, {
          role: 'assistant',
          content: result.content || '',
          toolCalls: result.toolCalls.map(tc => ({ ...tc, arguments: this._trimArgs(tc.arguments) })),
        });
      } catch { /* best-effort */ }

      for (const tc of result.toolCalls) {
        toolsUsed.push({ name: tc.name, arguments: tc.arguments });
        // Inject mode into run_query so it can block DDL in customer mode
        const toolArgs = tc.name === 'run_query' ? { ...tc.arguments, mode } : tc.arguments;
        const toolResult = await this.toolRegistry.executeTool(tc.name, toolArgs);

        // Reload skill/soul if they were just modified
        if (tc.name === 'write_skill') {
          this.skill = readText(this.paths.skill) || '';
          const nameMatch = this.skill.match(/^#\s+(.+?)(?:\s*—|\s*-|\n)/m);
          this.agentName = nameMatch ? nameMatch[1].trim() : path.basename(this.workspace);
          // Skill content changed — re-evaluate whether the Transaction Fields
          // block now needs seeding. Fire-and-forget; deduped by content hash.
          this._kickTransactionFieldsSeed();
        } else if (tc.name === 'write_soul') {
          this.soul = readText(this.paths.soul) || '';
        }
        // Note: the transaction view config is no longer auto-generated from
        // the first transaction. It's derived from SKILL.md's `## Transaction
        // Fields` block (see tools/transaction-view.js), reconciled on every
        // write_skill, and refinable by the owner via the dashboard editor.

        currentMessages.push({
          role: 'tool',
          toolCallId: tc.id,
          content: toolResult,
        });
        // Persist the matching (trimmed) tool result so the call/result pair
        // stays intact in history.
        try {
          this.sessionManager.addMessage(platform, userId, {
            role: 'tool',
            toolCallId: tc.id,
            content: this._trimToolResult(tc.name, toolResult),
          });
        } catch { /* best-effort */ }
      }
    }

    // Shouldn't reach here, but return last content if we do
    return { response: 'I was unable to complete the request. Please try again.', toolsUsed, tokensUsed: totalTokens };
  }

  /**
   * Owner reply to an alert. Resumes the customer session that triggered
   * the alert, injects the owner's text as admin guidance, runs one turn,
   * and records the reply on the alert ledger.
   *
   * @param {Object} params
   * @param {Object} params.alert - The matched alert from the ledger
   * @param {string} params.replyText - What the owner said
   * @param {string} params.replyChannel - 'telegram' | 'whatsapp' | 'email'
   * @param {boolean} params.threaded - True if the owner explicitly replied
   *   to the alert message (Telegram reply / WhatsApp context). False if
   *   we matched on recent-window heuristic.
   */
  async processOwnerReply({ alert, replyText, replyChannel, threaded = false }) {
    if (!alert?.context?.session_platform || !alert?.context?.session_user_id) {
      // No customer-session context — just run a normal admin chat in the
      // owner's own thread on this channel. Falls back to today's behavior.
      return null;
    }
    const { session_platform, session_user_id, session_user_name } = alert.context;

    // Build a synthetic admin-mode message that injects clearly into the
    // customer session history. Header is unambiguous so the agent reads
    // it as authoritative guidance, not a customer turn — and is action-
    // oriented so the agent actually executes (calls tools / sends a
    // message) rather than narrating what it "would" do.
    const channelLabel = replyChannel.charAt(0).toUpperCase() + replyChannel.slice(1);
    const matchKind = threaded ? 'replying directly' : 'sending a follow-up';
    const content = [
      `[ADMIN GUIDANCE — your owner is ${matchKind} on ${channelLabel} regarding the alert you sent earlier:`,
      `  Title: "${alert.title}"`,
      alert.context.transaction_id ? `  Transaction: ${alert.context.transaction_id}` : null,
      ``,
      `Treat the message below as authoritative instructions from your owner about the customer conversation shown above. NOT a customer message. Take whatever action follows from it — message the customer, update the transaction, call an extension, or whatever the situation calls for. Don't just describe what you would do; do it. Then briefly confirm to the owner what you did.]`,
      ``,
      `> ${replyText}`,
    ].filter(Boolean).join('\n');

    const result = await this.processEvent({
      platform: session_platform,
      userId: session_user_id,
      userName: session_user_name || 'Customer',
      type: 'owner_reply',
      content,
      metadata: {
        force_admin_mode: true,
        is_owner_reply: true,
        reply_to_alert: alert.alert_id,
        reply_channel: replyChannel,
      },
    });

    // Record the reply on the alert so subsequent replies still match.
    try {
      const { recordResponse } = await import('../notifications/alerts.js');
      recordResponse(this.paths, alert.alert_id, {
        channel: replyChannel,
        text: replyText,
        threaded,
        agent_response: (result?.response || '').slice(0, 500),
      });
    } catch (err) {
      console.warn('[engine] Failed to record alert response:', err.message);
    }

    // Activity log: ties off the alert lifecycle in the agent's diary.
    try {
      this.memoryManager?.appendActivity({
        type: 'alert_response',
        summary: `Owner replied via ${replyChannel} on alert "${alert.title}": ${replyText.slice(0, 120)}`,
        context: {
          alert_id: alert.alert_id,
          channel: replyChannel,
          threaded,
          transaction_id: alert.context?.transaction_id || null,
        },
        session_id: `${session_platform}:${session_user_id}`,
      });
    } catch { /* best-effort */ }

    return result;
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
   * Check whether the agent has been paused on this session by an admin
   * via the dashboard. Reads the `paused` / `paused_at` flags from session
   * meta. Auto-clears (returns false) if the pause is older than the max
   * duration — a safety net for admins who forget to resume.
   *
   * Max pause duration default: 1h. Override via config.pauseMaxHours.
   */
  _isSessionPaused(platform, userId) {
    const paused = this.sessionManager.getSessionMeta(platform, userId, 'paused');
    if (!paused) return false;

    const pausedAt = this.sessionManager.getSessionMeta(platform, userId, 'paused_at');
    const maxHours = this.config.pauseMaxHours || 1;
    if (pausedAt) {
      const ageMs = Date.now() - new Date(pausedAt).getTime();
      if (Number.isFinite(ageMs) && ageMs > maxHours * 60 * 60 * 1000) {
        // Stale pause — auto-resume.
        this.sessionManager.setSessionMeta(platform, userId, 'paused', null);
        this.sessionManager.setSessionMeta(platform, userId, 'paused_at', null);
        console.log(`[engine] Auto-resumed session ${platform}:${userId} (paused > ${maxHours}h)`);
        return false;
      }
    }
    return true;
  }

  /**
   * Cap large string values inside tool-call arguments before persisting them
   * to the session, so a call like write_data_file can't bloat the history.
   * Structure is preserved so the provider can still format the call. The full
   * arguments are still used within the turn — only the persisted copy is trimmed.
   */
  _trimArgs(args, depth = 0) {
    if (!args || typeof args !== 'object' || depth > 4) return args;
    const out = Array.isArray(args) ? [] : {};
    for (const [k, v] of Object.entries(args)) {
      if (typeof v === 'string' && v.length > 200) out[k] = v.slice(0, 200) + '…[truncated]';
      else if (v && typeof v === 'object') out[k] = this._trimArgs(v, depth + 1);
      else out[k] = v;
    }
    return out;
  }

  /**
   * Reduce a tool result to a compact form for the session history. Transaction
   * results keep their essential outcome (id/status); everything else is capped.
   * The full result is still used within the current turn — only the persisted
   * copy is trimmed, so large data never accumulates across turns.
   */
  _trimToolResult(name, resultStr) {
    if (!resultStr) return resultStr;
    const TXN = ['create_transaction', 'update_transaction', 'complete_transaction', 'cancel_transaction'];
    if (TXN.includes(name)) {
      try {
        const p = JSON.parse(resultStr);
        const t = p.transaction || {};
        return JSON.stringify({ ok: p.ok ?? !p.error, id: p.id ?? t.id, status: t.status, error: p.error });
      } catch { /* fall through to generic cap */ }
    }
    const CAP = 600;
    if (resultStr.length <= CAP) return resultStr;
    return resultStr.slice(0, CAP) + ` …[truncated ${resultStr.length - CAP} chars; re-run the tool for full data]`;
  }

  /**
   * Compress session in the background if it's getting large.
   */
  _maybeCompress(platform, userId) {
    const threshold = this.config.context?.sessionCompressAt || 10000;
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
   *
   * Mode determines the destination store:
   *   admin    → business facts (memory/facts.json)
   *   customer → user facts     (memory/users/<platform>/<userId>.json)
   *
   * Only business facts get the periodic pruneOldest call — user files are
   * naturally bounded by how much a single customer has talked to the agent
   * and are not at risk of unbounded growth in the same way.
   */
  _maybeExtractFacts(platform, userId, mode = 'admin') {
    const session = this.sessionManager.getSession(platform, userId);

    // Only extract every 5 messages to save LLM calls
    if (session.messages.length % 5 !== 0) return;

    this.memoryManager
      .extractFacts(this.provider, session.messages, { mode, platform, userId })
      .then(() => {
        if (mode === 'admin') {
          const maxFacts = this.config.context?.memoryMaxFacts || 200;
          this.memoryManager.pruneBusinessFacts(maxFacts);
        }
      })
      .catch(() => { /* non-critical */ });
  }

  /**
   * Auto-generate transaction view config after the first transaction.
   * Fire-and-forget: if it fails, the dashboard falls back to scanning.
   */
  _maybeGenerateTransactionView(transaction) {
    // Skip if config already exists
    if (fs.existsSync(this.paths.transactionView)) return;

    const skill = this.skill || '';
    const txnJson = JSON.stringify(transaction, null, 2);

    const prompt = `You are a UI configuration generator. Given a service description and a sample transaction, generate a JSON configuration for how to display transactions in a dashboard.

SERVICE DESCRIPTION:
${skill.slice(0, 2000)}

SAMPLE TRANSACTION:
${txnJson}

Generate a JSON object with these fields:
- "table_columns": array of field names to show as columns in the transactions table. Always include "service", "status", "cost". Add 2-3 of the most important custom fields from the transaction.
- "detail_sections": array of {title, fields} objects grouping related fields into named sections for a detail view. Cover all meaningful fields from the transaction.
- "labels": object mapping field names to human-readable display labels (e.g. "match_score" → "Compatibility Score").
- "formats": object mapping field names to format hints. Valid formats: "currency", "percentage", "date", "datetime", "rating", "boolean", "list".

Respond with ONLY the JSON object, no markdown fences, no explanation.`;

    this.provider.chat([
      { role: 'system', content: 'You output only valid JSON. No markdown, no explanation.' },
      { role: 'user', content: prompt },
    ], { maxTokens: 1500 }).then(result => {
      let text = (result.content || '').trim();
      // Strip markdown fences if present
      text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      try {
        const config = JSON.parse(text);
        saveTransactionView(this.paths, config);
      } catch { /* parse failed — dashboard will use scanning fallback */ }
    }).catch(() => { /* non-critical */ });
  }
}
