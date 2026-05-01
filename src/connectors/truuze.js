import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import { BaseConnector } from './index.js';
import { buildPlatformSkill } from './truuze-skill.js';

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
    this._pollPending = false; // a poll was requested while busy — run one more after
    this._processedIds = new Set(); // track processed event IDs to avoid duplicates
    this._processedIdsPath = null;  // set during connect() once workspace is known
    this._persistTimer = null;      // debounce disk writes
    // Escrow state cache: id → { status, snapshot }. Diffed on every poll to
    // synthesize platform-event style notifications (accepted, disputed, etc.)
    // without requiring the agent to read "Escrow XXXXXX" chat messages.
    this._escrowStates = new Map();
    this._escrowsInitialized = false;
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

      // Build the Truuze platform SKILL.md from the connector's template +
      // fields extracted from the owner's uploaded SKILL.md. Skipped if the
      // file already exists — trust the workspace.
      const skillPath = this.engine?.workspace
        ? path.join(this.engine.workspace, 'skills', 'truuze', 'SKILL.md')
        : null;
      if (skillPath && !fs.existsSync(skillPath)) {
        await this._buildPlatformSkill();
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

    } catch (err) {
      this.status = 'error';
      this.error = err.message;
      throw err;
    }
  }

  /**
   * Render the Truuze platform SKILL.md from the connector-shipped template,
   * extracting the owner's service config from their uploaded SKILL.md.
   * Non-critical — failure here should never block connection.
   */
  async _buildPlatformSkill() {
    try {
      await buildPlatformSkill({
        workspace: this.engine?.workspace,
        engine: this.engine,
        connection: {
          baseUrl: this.baseUrl,
          ownerUsername: this.ownerUsername,
        },
      });
    } catch (err) {
      console.log('[truuze] Failed to build platform skill:', err.message);
    }
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

    // Pong carries a `pending` count — the server's view of how many unread
    // events this agent has. If it's >0, a push must have been dropped on
    // the way here (the WS is healthy, otherwise we wouldn't get a pong).
    // Triggering _poll() here closes the gap within ~30s on quiet
    // connections without needing a separate HTTP heartbeat.
    if (source === 'pong') {
      const pending = Number(data.pending || 0);
      if (pending > 0 && !this._processing) {
        console.log('[truuze] Pong reports %d pending — fetching updates', pending);
        this._poll();
      }
      return;
    }

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

  // ─── Polling Mode (fallback) ───────────────────────

  _startPolling() {
    console.log('[truuze] Starting polling mode, interval:', this.heartbeatInterval / 1000, 's');
    this._poll();
    this.intervalId = setInterval(() => this._poll(), this.heartbeatInterval);
  }

  async _poll() {
    // Guard against concurrent polls. If one is already running, remember that
    // a poll was requested and run exactly one more after the current finishes.
    // Bursts of N requests collapse to a single follow-up — no queue, no loop.
    if (this._processing) {
      this._pollPending = true;
      return;
    }
    this._processing = true;
    this._pollPending = false;

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

      // Diff escrow state on every tick (independent of heartbeat counts —
      // escrow transitions don't always trigger an unread item). Cheap: a few
      // GETs that short-circuit when nothing changed. The first call after
      // connect is silent (cache initialization) so existing escrows don't
      // re-fire as fresh transitions on restart.
      try {
        await this._pollEscrows();
      } catch (err) {
        console.warn('[truuze] Escrow poll failed:', err.message);
      }
    } catch (err) {
      this.consecutiveFailures++;
      this.error = err.message;
      console.log('[truuze] Poll error:', err.message);
    } finally {
      this._processing = false;
      if (this._pollPending) {
        // Defer to the next tick so we don't grow the call stack
        setImmediate(() => { this._poll(); });
      }
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
    // server-side auto-mark-as-seen (unchanged for UX reasons). Sort
    // oldest-first by id so replies arrive in the order the user sent them
    // (the server returns newest-first).
    const messages = [...(updates.messages || [])].sort((a, b) => a.id - b.id);
    for (const msg of messages) {
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

  // ─── Escrow state tracking ─────────────────────────
  //
  // The connector watches the agent's escrows and emits platform-event style
  // notifications when state changes — so the agent never has to parse
  // "Escrow XXXXXX" chat messages or remember to poll. Truuze remains the
  // source of truth: the cache is diffed against fresh server data on every
  // heartbeat tick.

  // Statuses that can still transition. Anything not in this list is terminal.
  static get _ESCROW_NON_TERMINAL() {
    return ['pending', 'active', 'delivered', 'disputed', 'negotiating'];
  }

  /**
   * Fetch all non-terminal escrows, diff against the cache, and emit synthetic
   * events for transitions. First call after connect() initializes the cache
   * silently (no events) so a restart doesn't replay every active escrow as
   * "just changed".
   */
  async _pollEscrows() {
    const fresh = new Map();
    for (const status of TruuzeConnector._ESCROW_NON_TERMINAL) {
      try {
        const res = await this._fetch(`/kookie/escrow/?status=${encodeURIComponent(status)}`);
        if (!res.ok) continue;
        const data = await res.json();
        const items = Array.isArray(data) ? data : (data.results || []);
        for (const item of items) {
          const id = item.id ?? item.escrow_id;
          if (id) fresh.set(id, item);
        }
      } catch (err) {
        console.warn('[truuze] Escrow status fetch (%s) failed: %s', status, err.message);
      }
    }

    // Initialization pass: just populate, do not emit. Anything currently in
    // a non-terminal state is "already known" — events fire only for future
    // transitions detected on subsequent polls.
    if (!this._escrowsInitialized) {
      this._escrowStates.clear();
      for (const [id, item] of fresh) {
        this._escrowStates.set(id, { status: item.status, snapshot: item });
      }
      this._escrowsInitialized = true;
      if (fresh.size > 0) {
        console.log('[truuze] Escrow cache initialized: %d non-terminal', fresh.size);
      }
      return;
    }

    // Diff: transitions within the non-terminal set.
    for (const [id, item] of fresh) {
      const prev = this._escrowStates.get(id);
      const newStatus = item.status;
      if (!prev) {
        // First time seeing this escrow. Cache it. If it's at pending, the
        // agent likely just created it — stay silent (create_service already
        // told the agent what to expect). If it's past pending, a transition
        // we missed has already happened (fast user acceptance between
        // create_service and our next poll, or a restart mid-deal).
        // Synthesize a pending → newStatus event so the agent learns what
        // changed. _escrowTransitionAction filters self-driven states like
        // delivered/negotiating, so this only fires for actionable changes.
        this._escrowStates.set(id, { status: newStatus, snapshot: item });
        if (newStatus !== 'pending') {
          await this._emitEscrowEvent('pending', newStatus, item);
        }
        continue;
      }
      if (prev.status !== newStatus) {
        console.log('[truuze] Escrow %s: %s → %s', id, prev.status, newStatus);
        this._escrowStates.set(id, { status: newStatus, snapshot: item });
        await this._emitEscrowEvent(prev.status, newStatus, item);
      }
    }

    // Detect transitions to TERMINAL states — escrow disappears from the
    // non-terminal listing. Fetch detail to learn the final status, fire one
    // event, then drop from cache.
    const goneIds = [];
    for (const [id] of this._escrowStates) {
      if (!fresh.has(id)) goneIds.push(id);
    }
    for (const id of goneIds) {
      const prev = this._escrowStates.get(id);
      try {
        const res = await this._fetch(`/kookie/escrow/${id}/`);
        if (res.ok) {
          const item = await res.json();
          if (item.status && item.status !== prev.status) {
            console.log('[truuze] Escrow %s went terminal: %s → %s', id, prev.status, item.status);
            await this._emitEscrowEvent(prev.status, item.status, item);
          }
        }
      } catch (err) {
        console.warn('[truuze] Could not resolve terminal status for %s: %s', id, err.message);
      }
      this._escrowStates.delete(id);
    }
  }

  /**
   * Decide whether a transition is worth notifying the agent about, and what
   * to call it. Returns null for noise (e.g. self-driven transitions where the
   * agent already knows because it just made the API call).
   */
  _escrowTransitionAction(from, to) {
    // User actions on the escrow — agent must hear about these:
    if (to === 'active' && from !== 'active') return 'accepted';        // user paid
    if (to === 'disputed' && from !== 'disputed') return 'disputed';    // user disputed
    if (to === 'completed') return 'completed';                          // user released or auto-released
    if (to === 'refunded') return 'refunded';                            // auto-refunded
    if (to === 'cancelled' && from !== 'pending') return 'cancelled';    // late cancel surfaced
    if (to === 'expired') return 'expired';                              // offer expired
    if (to === 'admin_review') return 'admin_review';                    // dispute escalated
    if (to === 'resolved' && from === 'admin_review') return 'admin_decided';
    // Self-driven transitions (delivered, negotiating after our respond)
    // are intentionally NOT emitted — the agent just made the call.
    return null;
  }

  /**
   * Emit one synthetic event into the engine for an escrow state change.
   * Uses a non-message event type so it can't be confused with chat content.
   * Agent's response, if any, is sent into the escrow's chat.
   */
  async _emitEscrowEvent(fromStatus, toStatus, escrow) {
    const action = this._escrowTransitionAction(fromStatus, toStatus);
    if (!action) return;

    const ref = escrow.reference_code || `#${escrow.id ?? escrow.escrow_id}`;
    const title = escrow.title || 'service';
    const chatId = escrow.chat_id;
    const userUsername = escrow.user?.username || escrow.user_username || null;

    const content = this._formatEscrowNotice(action, escrow, ref, title);

    const event = {
      platform: 'truuze',
      // Route into the customer's chat session if we know who it is, so the
      // agent's reply lands in the right context. Falls back to a synthetic
      // platform id when the username isn't surfaced by the API.
      userId: userUsername || 'truuze-platform',
      userName: userUsername ? `@${userUsername}` : 'Truuze Platform',
      type: 'platform_event',
      content,
      metadata: {
        mode: 'customer',
        is_platform_event: true,
        category: 'escrow',
        action,
        escrow_id: escrow.id ?? escrow.escrow_id,
        reference_code: escrow.reference_code,
        chat_id: chatId,
        from_status: fromStatus,
        to_status: toStatus,
      },
    };

    try {
      const result = await this.engine.processEvent(event);
      // If the agent produced a chat-worthy response and didn't already post
      // it via platform_request, send it into the escrow's chat. Without this
      // the user only sees backend-side state changes and not the agent's
      // human-facing acknowledgement.
      const sentMessage = (result?.toolsUsed || []).some(t => {
        if (typeof t === 'string') return false;
        if (t.name !== 'platform_request') return false;
        const args = t.arguments || {};
        const method = (args.method || '').toUpperCase();
        const url = (args.url || '');
        return method === 'POST' && url.includes('/message/create');
      });
      if (chatId && result?.response && !sentMessage) {
        await this._sendMessage(chatId, result.response);
        console.log('[truuze] Escrow event response posted to chat %s', chatId);
      }
    } catch (err) {
      console.error('[truuze] Escrow event handler error:', err);
      this.error = `Escrow event handler error: ${err.message}`;
    }
  }

  _formatEscrowNotice(action, escrow, ref, title) {
    const userTotal = escrow.user_total || escrow.amount;
    const agentNet = escrow.agent_net;
    switch (action) {
      case 'accepted':
        return `[Truuze] The user accepted and paid for your service "${title}" (${ref}). ${userTotal} kookies are now escrowed (you net ${agentNet || userTotal} on release). The service is ACTIVE — you can start work now. When the work is finished, deliver it in chat AND call complete_service to mark it delivered on Truuze. Without that call, the kookies stay frozen.`;
      case 'disputed':
        return `[Truuze] The user disputed your delivery of "${title}" (${ref}). Reason: ${escrow.dispute_reason || 'not provided'}. You have 48 hours to act or kookies auto-refund. Use respond_to_dispute with action "defend" to push back, or "agree_refund" if the dispute is fair. Also message the user in chat — settle in negotiation rather than letting it go to admin review.`;
      case 'completed':
        return `[Truuze] The user released payment for "${title}" (${ref}). You earned ${agentNet || userTotal} kookies. Service is complete. Send a brief, warm closing message in chat.`;
      case 'refunded':
        return `[Truuze] Service "${title}" (${ref}) was refunded to the user. No further action needed.`;
      case 'cancelled':
        return `[Truuze] Service "${title}" (${ref}) was cancelled. If you had started work, you won't be paid for it. No further action needed.`;
      case 'expired':
        return `[Truuze] Your offer for "${title}" (${ref}) expired before the user accepted. No further action needed.`;
      case 'admin_review':
        return `[Truuze] The dispute on "${title}" (${ref}) escalated to admin review — neither side settled in time. You can no longer act on this service. Truuze admin will decide.`;
      case 'admin_decided':
        return `[Truuze] Truuze admin closed the dispute on "${title}" (${ref}). Decision: ${escrow.admin_decision_reason || 'see Truuze for details'}.`;
      default:
        return `[Truuze] Service ${ref} state changed to ${escrow.status}.`;
    }
  }

  async _handleMessage(msg) {
    // Skip messages with no text and no media
    if (!msg.text && !msg.media?.length) {
      console.log('[truuze] Skipping message with no content, id:', msg.id);
      return;
    }

    // Filter out Truuze's "Escrow XXXXXX" platform-system messages. The
    // connector now drives all escrow notifications via _pollEscrows() and
    // synthetic platform_event events. Letting these into the agent's stream
    // would cause double-handling and require the agent to parse 6-letter
    // codes the connector already resolved. Ack them so the server stops
    // redelivering, then drop. Real chat content is unaffected.
    if (msg.message_type === 'system' && /^Escrow\s+[A-Z0-9]{6}\b/.test((msg.text || '').trim())) {
      console.log('[truuze] Filtering escrow system message %s (handled by escrow poller)', msg.id);
      this._ackMessage(msg.id, msg.chat_type);
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
