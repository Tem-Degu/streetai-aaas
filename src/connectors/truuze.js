import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import { BaseConnector } from './index.js';
import { getPlatformSkillPath } from '../utils/workspace.js';

/**
 * Truuze connector — connects to Truuze via WebSocket for real-time events,
 * with polling as fallback. Processes events through the engine.
 */
export default class TruuzeConnector extends BaseConnector {
  constructor(config, engine) {
    super(config, engine);
    this.baseUrl = config.baseUrl;
    this.platformApiKey = config.platformApiKey;
    this.agentKey = config.agentKey;
    this.ownerUsername = config.ownerUsername || null;
    this.heartbeatInterval = (config.heartbeatInterval || 30) * 1000;
    this.mode = config.mode || 'auto'; // 'auto', 'websocket', 'polling'
    this.agentType = config.agentType || engine?.config?.agentType || 'service';
    this.intervalId = null;
    this.consecutiveFailures = 0;
    this.ws = null;
    this.pingInterval = null;
    this.reconnectAttempts = 0;
    this.reconnecting = false;
    this._pollDebounceTimer = null;
    this._processing = false; // guard against concurrent polls
    this._processedIds = new Set(); // track processed event IDs to avoid duplicates
    this._processedIdsPath = null;  // set during connect() once workspace is known
    this._persistTimer = null;      // debounce disk writes
    this._healthCheckTimer = null;  // hourly ping safety net
  }

  get platformName() { return 'truuze'; }

  async connect() {
    this.status = 'connecting';

    // Verify agent key works
    try {
      const res = await this._fetch('/account/agent/profile/');
      if (!res.ok) throw new Error(`Profile check failed: ${res.status}`);
      this.consecutiveFailures = 0;

      // Load the persisted processed-IDs set so restarts don't re-bill the LLM
      this._loadProcessedIds();

      // Fetch and save platform SKILL.md (skip if already exists from Connect step)
      const skillPath = getPlatformSkillPath(this.engine?.workspace, 'truuze');
      if (!skillPath || !fs.existsSync(skillPath)) {
        await this._fetchPlatformSkill();
      }

      // Connect based on mode
      if (this.mode === 'polling') {
        this._startPolling();
        this.status = 'connected';
      } else {
        try {
          await this._connectWebSocket();
          this.status = 'connected';
        } catch (err) {
          if (this.mode === 'auto') {
            console.log('[truuze] WebSocket failed, falling back to polling:', err.message);
            this._startPolling();
            this.status = 'connected';
          } else {
            throw err;
          }
        }
      }

      // Hourly health check ping (safety net while we rely on the WS push)
      this._startHealthCheck();
    } catch (err) {
      this.status = 'error';
      this.error = err.message;
      throw err;
    }
  }

  /**
   * Fetch the Truuze platform skill from the API, rewrite with LLM to strip
   * onboarding instructions, and save to skills/truuze/SKILL.md.
   */
  async _fetchPlatformSkill() {
    try {
      const agentType = this.agentType || 'service';
      const res = await this._fetch(`/account/agent/skills/refresh/?type=${agentType}`);
      if (!res.ok) return;

      const data = await res.json();
      let skillContent = data.content || data.skills_md || data;

      if (typeof skillContent !== 'string' || skillContent.length === 0) return;

      // Rewrite with LLM to strip signup/onboarding instructions (agent is already connected)
      try {
        skillContent = await this._rewriteSkill(skillContent);
      } catch (err) {
        console.log('[truuze] Skill rewrite failed, using original:', err.message);
      }

      // Inject AaaS-specific call guidance (the template is runtime-neutral)
      skillContent = this._injectAaasGuidance(skillContent);

      const skillPath = getPlatformSkillPath(this.engine.workspace, 'truuze');
      fs.mkdirSync(path.dirname(skillPath), { recursive: true });
      fs.writeFileSync(skillPath, skillContent);
    } catch {
      // Non-critical
    }
  }

  /**
   * Use the LLM to strip onboarding/signup sections from the platform skill,
   * since the agent is already registered and connected.
   */
  async _rewriteSkill(originalSkill) {
    if (!this.engine?.provider) {
      await this.engine?.initialize?.();
      if (!this.engine?.provider) return originalSkill;
    }

    const prompt = `You are rewriting a platform SKILL.md file for an AI agent that has already been onboarded.

The agent is already signed up and connected. Rewrite the SKILL.md below with these changes:
1. REMOVE all signup/registration instructions (Step 1: Register, provisioning token usage, etc.)
2. REMOVE credential storage instructions (saving API keys, credentials.json, etc.)
3. REMOVE heartbeat/polling setup instructions (events are delivered automatically)
4. REMOVE "where to place this file" or installation instructions
5. REMOVE authentication setup instructions (auth headers are handled automatically)
6. KEEP all API endpoint documentation intact (messaging, escrow, kookies, profiles, etc.)
7. KEEP behavioral guidance (community guidelines, best practices, owner priority)
8. KEEP the frontmatter (--- block at the top) unchanged
9. Return ONLY the rewritten SKILL.md content, nothing else — no explanations, no wrapping

Original SKILL.md:
${originalSkill}`;

    const result = await this.engine.provider.chat([
      { role: 'user', content: prompt },
    ], { maxTokens: 8000, temperature: 0 });

    const rewritten = result.content?.trim();
    if (rewritten && rewritten.length > 500) {
      console.log('[truuze] SKILL.md rewritten by LLM (' + rewritten.length + ' chars)');
      return rewritten;
    }
    return originalSkill;
  }

  /**
   * Inject AaaS-specific instructions into the skill. The Truuze template is
   * intentionally runtime-neutral — the connector is responsible for telling
   * the agent how to actually make calls on this particular platform.
   */
  _injectAaasGuidance(skillContent) {
    const block = `
## How to Call Truuze APIs (AaaS runtime)

You are running on the AaaS platform. Use the \`platform_request\` tool for ALL Truuze API calls. Auth headers (X-Api-Key, X-Agent-Key) are added automatically — never add them yourself.

\`\`\`
platform_request({
  url: "<full truuze url>",
  method: "POST",
  body: { ... }
})
\`\`\`

Never use \`create_transaction\` for Truuze. That tool is for internal record-keeping only — it does NOT charge users or create escrows. Always use \`platform_request\`.

---
`;

    // Insert after the frontmatter block (between the closing --- and the rest)
    const fmMatch = skillContent.match(/^---\n[\s\S]*?\n---\n/);
    if (fmMatch) {
      const idx = fmMatch[0].length;
      return skillContent.slice(0, idx) + block + skillContent.slice(idx);
    }
    // No frontmatter — prepend
    return block + skillContent;
  }

  async disconnect() {
    this.reconnecting = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this._pollDebounceTimer) {
      clearTimeout(this._pollDebounceTimer);
      this._pollDebounceTimer = null;
    }
    if (this._healthCheckTimer) {
      clearInterval(this._healthCheckTimer);
      this._healthCheckTimer = null;
    }
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
      this._persistProcessedIds();  // final flush
    }
    await super.disconnect();
  }

  // ─── WebSocket Mode ────────────────────────────────

  async _connectWebSocket() {
    // Convert http(s) base URL to ws(s) URL
    const wsBase = this.baseUrl
      .replace(/\/api\/v1$/, '')  // strip /api/v1 suffix
      .replace(/^https:/, 'wss:')
      .replace(/^http:/, 'ws:');
    const wsUrl = `${wsBase}/ws/?agent_key=${this.agentKey}`;

    console.log('[truuze] Connecting WebSocket:', wsUrl.replace(this.agentKey, '***'));

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      const connectTimeout = setTimeout(() => {
        if (this.ws?.readyState !== WebSocket.OPEN) {
          this.ws?.close();
          reject(new Error('WebSocket connection timeout'));
        }
      }, 15_000);

      this.ws.on('open', () => {
        clearTimeout(connectTimeout);
        console.log('[truuze] WebSocket connected');
        this.reconnectAttempts = 0;
        this.error = null;

        // Start ping keepalive
        this.pingInterval = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ source: 'ping' }));
          }
        }, 30_000);

        // Do one heartbeat fetch to catch up on missed events
        this._poll().then(resolve).catch(resolve);
      });

      this.ws.on('message', (raw) => {
        try {
          const data = JSON.parse(raw.toString());
          this._handleWebSocketMessage(data);
        } catch { /* ignore malformed */ }
      });

      this.ws.on('close', (code) => {
        clearTimeout(connectTimeout);
        if (this.pingInterval) {
          clearInterval(this.pingInterval);
          this.pingInterval = null;
        }
        if (this.status !== 'disconnected') {
          console.log('[truuze] WebSocket closed, code:', code);
          this._handleReconnect();
        }
      });

      this.ws.on('error', (err) => {
        clearTimeout(connectTimeout);
        console.log('[truuze] WebSocket error:', err.message);
        if (this.status === 'connecting') {
          reject(err);
        }
      });
    });
  }

  _handleWebSocketMessage(data) {
    const source = data.source;
    if (!source) return;

    // Ignore pong, connection confirmations
    if (source === 'pong') return;

    console.log('[truuze] WebSocket event:', source);

    // WebSocket push received — fetch details. Debounce to coalesce bursts.
    if (this._pollDebounceTimer) clearTimeout(this._pollDebounceTimer);
    this._pollDebounceTimer = setTimeout(() => {
      this._poll();
    }, 500);
  }

  _handleReconnect() {
    const MAX_RECONNECT_ATTEMPTS = 5;

    if (this.status === 'disconnected' || this.reconnecting) return;

    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.status = 'error';
      this.error = `WebSocket connection lost. Failed to reconnect after ${MAX_RECONNECT_ATTEMPTS} attempts.`;
      console.log(`[truuze] Giving up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`);
      return;
    }

    this.reconnecting = true;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30_000);
    this.reconnectAttempts++;
    this.status = 'reconnecting';
    this.error = `Connection lost. Reconnecting (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`;

    console.log(`[truuze] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

    setTimeout(async () => {
      this.reconnecting = false;
      if (this.status === 'disconnected') return;

      try {
        await this._connectWebSocket();
        this.status = 'connected';
        this.error = null;
      } catch (err) {
        console.log('[truuze] Reconnect failed:', err.message);
        this._handleReconnect();
      }
    }, delay);
  }

  /**
   * Hourly lightweight health check via GET /account/agent/ping/.
   * Returns just a count — no event details, so no LLM spend.
   * Triggers a full _poll() only when the server reports pending work,
   * which handles the rare case where a WebSocket push was missed.
   */
  _startHealthCheck() {
    const HOUR = 60 * 60 * 1000;
    if (this._healthCheckTimer) clearInterval(this._healthCheckTimer);
    this._healthCheckTimer = setInterval(async () => {
      try {
        const res = await this._fetch('/account/agent/ping/');
        if (!res.ok) return;
        const data = await res.json();
        const pending = Number(data.pending || 0);
        if (pending > 0) {
          console.log('[truuze] Health check: %d pending — fetching updates', pending);
          this._poll();
        }
      } catch (err) {
        console.log('[truuze] Health check failed:', err.message);
      }
    }, HOUR);
  }

  // ─── Polling Mode (fallback) ───────────────────────

  _startPolling() {
    console.log('[truuze] Starting polling mode, interval:', this.heartbeatInterval / 1000, 's');
    this._poll();
    this.intervalId = setInterval(() => this._poll(), this.heartbeatInterval);
  }

  async _poll() {
    // Guard against concurrent polls (e.g. debounce fires while previous poll is still processing)
    if (this._processing) {
      console.log('[truuze] Poll skipped — already processing');
      return;
    }
    this._processing = true;

    try {
      const res = await this._fetch('/account/agent/updates/');
      if (!res.ok) {
        this.consecutiveFailures++;
        console.log('[truuze] Heartbeat failed:', res.status);
        if (this.consecutiveFailures >= 5) {
          this.status = 'error';
          this.error = `Heartbeat failing (${this.consecutiveFailures} consecutive)`;
        }
        return;
      }

      this.consecutiveFailures = 0;
      if (this.status !== 'reconnecting') {
        this.status = 'connected';
      }
      this.error = null;

      const data = await res.json();
      const counts = data.counts || {};
      const total = Object.values(counts).reduce((s, n) => s + n, 0);
      if (total > 0) {
        console.log('[truuze] Heartbeat returned updates:', JSON.stringify(counts));
        await this._processUpdates(data);
      }
    } catch (err) {
      this.consecutiveFailures++;
      this.error = err.message;
      console.log('[truuze] Poll error:', err.message);
    } finally {
      this._processing = false;
    }
  }

  /**
   * Check if an event ID has already been processed. Uses a composite key
   * of type + id to avoid cross-type collisions.
   */
  _isProcessed(type, id) {
    const key = `${type}:${id}`;
    if (this._processedIds.has(key)) return true;
    this._processedIds.add(key);
    // Cap the set size to prevent unbounded growth
    if (this._processedIds.size > 5000) {
      const arr = [...this._processedIds];
      this._processedIds = new Set(arr.slice(-2500));
    }
    return false;
  }

  async _processUpdates(data) {
    const updates = data.updates || {};

    // Messages are real conversations — keep individual processing and
    // server-side auto-mark-as-seen (unchanged for UX reasons).
    for (const msg of (updates.messages || [])) {
      if (this._isProcessed('msg', msg.id)) continue;
      await this._handleMessage(msg);
    }

    // Everything else (comments, mentions, reactions, listeners, new daybooks,
    // bond requests) gets aggregated into ONE LLM call. The agent decides what
    // to do — reply, ignore, accept a bond, follow back — via platform_request.
    const batch = [];

    for (const comment of (updates.comments || [])) {
      if (this._isProcessed('comment', comment.id)) continue;
      batch.push({ kind: 'comment', category: 'event', item: comment });
    }
    for (const mention of (updates.mentions || [])) {
      if (this._isProcessed('mention', mention.id)) continue;
      batch.push({ kind: 'mention', category: 'event', item: mention });
    }
    for (const reaction of (updates.reactions || [])) {
      if (this._isProcessed('reaction', reaction.id)) continue;
      batch.push({ kind: 'reaction', category: 'event', item: reaction });
    }
    for (const listener of (updates.new_listeners || [])) {
      if (this._isProcessed('listener', listener.id)) continue;
      batch.push({ kind: 'new_listener', category: 'listener', item: listener });
    }
    for (const daybook of (updates.new_daybooks || [])) {
      if (this._isProcessed('daybook', daybook.id)) continue;
      batch.push({ kind: 'new_daybook', category: 'daybook', item: daybook });
    }
    for (const bond of (updates.bond_requests || [])) {
      if (this._isProcessed('bond', bond.id)) continue;
      batch.push({ kind: 'bond_request', category: 'bond_request', item: bond });
    }

    if (batch.length > 0) {
      await this._handleBatch(batch);
    }

    // Persist the processed-IDs set so a restart doesn't re-bill the LLM.
    this._persistProcessedIds();
  }

  /**
   * Send one consolidated event to the engine summarizing every non-message
   * update, then mark each server-side record as read. The agent is free to
   * act (reply, follow back, accept a bond) via platform_request inside the
   * single LLM call; we don't auto-take any actions here.
   */
  async _handleBatch(batch) {
    const summary = this._formatBatchSummary(batch);
    console.log('[truuze] Processing batch: %d item(s)', batch.length);

    const event = {
      platform: 'truuze',
      userId: 'truuze-activity',
      userName: 'Truuze Activity',
      type: 'activity_batch',
      content: summary,
      metadata: {
        mode: 'customer',
        batch_size: batch.length,
        items: batch.map(b => ({ kind: b.kind, id: b.item.id })),
      },
    };

    try {
      await this.engine.processEvent(event);
    } catch (err) {
      console.error('[truuze] Batch handler error:', err);
      this.error = `Batch handler error: ${err.message}`;
    }

    // Mark every item read regardless of whether the agent responded — the
    // heartbeat filters on is_unread, so leaving these unread would redeliver
    // the same batch on every poll and re-bill the LLM.
    for (const { category, item } of batch) {
      try {
        await this._markAsRead(category, item.id);
      } catch (err) {
        console.warn('[truuze] mark-as-read failed (%s %s): %s', category, item.id, err.message);
      }
    }
  }

  /**
   * Build a human-readable summary the LLM can reason over. Keeps each entry
   * short so a batch of 20 stays well under a few hundred tokens.
   */
  _formatBatchSummary(batch) {
    const lines = [`You have ${batch.length} new activity notification(s) on Truuze:`, ''];

    for (const { kind, item } of batch) {
      const from = item.from_username || item.requester_username || item.username || item.owner_username || 'someone';
      if (kind === 'comment') {
        const text = (item.text || '').slice(0, 200);
        lines.push(`- @${from} commented on your daybook ${item.voice_id}: "${text}"`);
      } else if (kind === 'mention') {
        lines.push(`- @${from} mentioned you in ${item.mention_in || 'a post'} (voice ${item.voice_id || '?'}${item.comment_id ? `, comment ${item.comment_id}` : ''})`);
      } else if (kind === 'reaction') {
        lines.push(`- @${from} reacted (${item.event_type}) on voice ${item.voice_id || '?'}${item.comment_id ? `, comment ${item.comment_id}` : ''}`);
      } else if (kind === 'new_listener') {
        lines.push(`- @${from} started listening to you (${item.account_type || 'user'})`);
      } else if (kind === 'new_daybook') {
        lines.push(`- @${from} posted a new daybook (voice ${item.voice_id})`);
      } else if (kind === 'bond_request') {
        lines.push(`- @${from} sent you a bond request (request ${item.id}, ${item.requester_account_type || 'user'})`);
      }
    }

    lines.push('');
    lines.push('Decide what (if anything) to do. You may reply, follow back, accept/reject bonds, or simply note them. Use platform_request for any action. If nothing warrants a response, say nothing.');
    return lines.join('\n');
  }

  /**
   * Mark a server-side record as read so the heartbeat stops redelivering it.
   * Categories match MarkAsReadAPIView: event, listener, bond_request, daybook.
   */
  async _markAsRead(category, id) {
    const res = await this._fetch('/account/mark-as-read/', {
      method: 'PATCH',
      body: JSON.stringify({ category, id }),
    });
    if (!res.ok && res.status !== 204) {
      throw new Error(`HTTP ${res.status}`);
    }
  }

  /**
   * Restore the processed-IDs set from disk so a connector restart doesn't
   * re-bill the LLM on every event that arrived while we were offline.
   */
  _loadProcessedIds() {
    try {
      const ws = this.engine?.workspace;
      if (!ws) return;
      this._processedIdsPath = path.join(ws, '.aaas', 'truuze-processed.json');
      if (!fs.existsSync(this._processedIdsPath)) return;
      const raw = fs.readFileSync(this._processedIdsPath, 'utf-8');
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        this._processedIds = new Set(arr);
        console.log('[truuze] Loaded %d processed IDs from disk', this._processedIds.size);
      }
    } catch (err) {
      console.log('[truuze] Could not load processed IDs:', err.message);
    }
  }

  /**
   * Persist the processed-IDs set. Debounced to avoid hammering disk when a
   * burst of events arrives.
   */
  _persistProcessedIds() {
    if (!this._processedIdsPath) return;
    if (this._persistTimer) clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      try {
        fs.mkdirSync(path.dirname(this._processedIdsPath), { recursive: true });
        fs.writeFileSync(
          this._processedIdsPath,
          JSON.stringify([...this._processedIds]),
        );
      } catch (err) {
        console.log('[truuze] Could not persist processed IDs:', err.message);
      }
    }, 1000);
  }

  async _handleMessage(msg) {
    // Skip messages with no text and no media
    if (!msg.text && !msg.media?.length) {
      console.log('[truuze] Skipping message with no content, id:', msg.id);
      return;
    }

    console.log('[truuze] Processing message from @%s: "%s"', msg.from_username, msg.text?.slice(0, 80));

    // Download any media attachments to data/inbox/
    let content = msg.text || '';
    if (msg.media?.length) {
      const savedFiles = await this._downloadMedia(msg.media, msg.from_username);
      if (savedFiles.length > 0) {
        const fileList = savedFiles.map(f => `${f.type}: ${f.path}`).join(', ');
        content = content
          ? `${content}\n\n[Attached files: ${fileList}]`
          : `[Attached files: ${fileList}]`;
      }
    }

    const isOwner = this.ownerUsername && msg.from_username === this.ownerUsername;
    const isSystem = msg.message_type === 'system';

    // For system messages, find the other participant's username from chat history
    // so the message lands in the correct user session (not a separate "system" session)
    let systemSessionUser = null;
    if (isSystem && msg.history?.length) {
      const otherMsg = msg.history.find(h => !h.is_you && h.sender_username);
      systemSessionUser = otherMsg?.sender_username;
    }

    const event = {
      platform: 'truuze',
      userId: isSystem ? (systemSessionUser || 'system') : (msg.from_username || String(msg.from_user_id)),
      userName: isSystem ? 'Truuze System' : (msg.from_name || msg.from_username),
      type: 'message',
      content: isSystem ? content : content,
      metadata: {
        mode: 'customer',
        is_owner: isOwner,
        is_system: isSystem,
        chat_id: msg.chat_id,
        chat_type: msg.chat_type,
        message_id: msg.id,
        history: msg.history,
      },
    };

    // Ack the message as soon as we accept it for processing. Fire-and-forget
    // so the network round-trip doesn't delay the LLM call. The server-side
    // auto-mark has been removed, so this is the authoritative ack.
    this._ackMessage(msg.id, msg.chat_type);

    try {
      const result = await this.engine.processEvent(event);
      const toolNames = (result.toolsUsed || []).map(t => typeof t === 'string' ? t : t.name);
      console.log('[truuze] Engine response: %d chars, tools: [%s]',
        result.response?.length || 0, toolNames.join(', ') || 'none');
      // Only skip auto-send if the agent used platform_request to POST a message (not just GET checks)
      const sentMessage = (result.toolsUsed || []).some(t => {
        if (typeof t === 'string') return false;
        if (t.name !== 'platform_request') return false;
        const args = t.arguments || {};
        const method = (args.method || '').toUpperCase();
        const url = (args.url || '');
        return method === 'POST' && url.includes('/message/create');
      });
      if (result.response && !sentMessage) {
        await this._sendMessage(msg.chat_id, result.response);
        console.log('[truuze] Reply sent to chat %s', msg.chat_id);
      }
    } catch (err) {
      console.error('[truuze] Message handler error:', err);
      this.error = `Message handler error: ${err.message}`;
    }
  }

  /**
   * Mark a chat message as SEEN on the server. Fire-and-forget: the agent
   * shouldn't wait on this before thinking. Handles both regular chats and
   * bond rooms — the server endpoint fires every side effect a human client
   * would trigger via the `mark.as.seen` WebSocket frame.
   */
  _ackMessage(messageId, chatType) {
    if (!messageId) return;
    const faRoom = chatType === 'bondroom';
    this._fetch('/account/agent/message-ack/', {
      method: 'PATCH',
      body: JSON.stringify({ message_id: messageId, fa_room: faRoom }),
    }).then((res) => {
      if (!res.ok && res.status !== 204) {
        console.warn('[truuze] message-ack failed for %s: HTTP %d', messageId, res.status);
      }
    }).catch((err) => {
      console.warn('[truuze] message-ack error for %s: %s', messageId, err.message);
    });
  }

  // ─── Truuze API Helpers ────────────────────────────

  async _fetch(apiPath, options = {}) {
    const url = `${this.baseUrl}${apiPath}`;
    const headers = {
      'X-Api-Key': this.platformApiKey,
      'X-Agent-Key': this.agentKey,
      ...options.headers,
    };

    // Only set Content-Type for non-FormData bodies
    if (!(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      return await fetch(url, {
        ...options,
        headers,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async _sendMessage(chatId, text) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const formData = new FormData();
        formData.append('chat', chatId);
        formData.append('text_0_1', text);

        const resp = await this._fetch('/chat/message/create/', {
          method: 'POST',
          body: formData,
        });
        if (resp.ok) return;
        console.warn(`[truuze] Send attempt ${attempt}/3 failed: HTTP ${resp.status}`);
        if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
        else console.error('[truuze] Failed to send message after 3 attempts');
      } catch (err) {
        console.warn(`[truuze] Send attempt ${attempt}/3 failed: ${err.message}`);
        if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
        else console.error('[truuze] Failed to send message after 3 attempts');
      }
    }
  }

  async _downloadMedia(mediaItems, username) {
    const inboxDir = path.join(this.engine.workspace, 'data', 'inbox');
    fs.mkdirSync(inboxDir, { recursive: true });

    const saved = [];
    for (const item of mediaItems) {
      if (!item.url) continue;

      try {
        let buffer;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const resp = await fetch(item.url, { signal: AbortSignal.timeout(30_000) });
            if (!resp.ok) {
              console.warn(`[truuze] Download attempt ${attempt}/3 failed: HTTP ${resp.status}`);
              if (attempt < 3) { await new Promise(r => setTimeout(r, 2000)); continue; }
              break;
            }
            buffer = Buffer.from(await resp.arrayBuffer());
            break;
          } catch (fetchErr) {
            console.warn(`[truuze] Download attempt ${attempt}/3 failed: ${fetchErr.message}`);
            if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
          }
        }
        if (!buffer) {
          console.error('[truuze] Failed to download media after 3 attempts:', item.url);
          continue;
        }

        // Build filename: username_timestamp_originalname
        const urlPath = new URL(item.url).pathname;
        const originalName = item.original_name || path.basename(urlPath) || `file_${Date.now()}`;
        const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
        const filename = `${username}_${Date.now()}_${safeName}`;
        const filePath = path.join(inboxDir, filename);

        fs.writeFileSync(filePath, buffer);

        // Return workspace-relative path
        const relativePath = `data/inbox/${filename}`;
        saved.push({ type: item.type, path: relativePath });
        console.log('[truuze] Downloaded media:', item.type, relativePath, buffer.length, 'bytes');
      } catch (err) {
        console.error('[truuze] Media download error:', item.url, err.message);
      }
    }
    return saved;
  }

  getStatus() {
    return {
      ...super.getStatus(),
      baseUrl: this.baseUrl,
      mode: this.ws ? 'websocket' : 'polling',
      heartbeatInterval: this.heartbeatInterval / 1000,
      consecutiveFailures: this.consecutiveFailures,
      reconnectAttempts: this.reconnectAttempts,
    };
  }
}
