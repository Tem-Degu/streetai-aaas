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
    this.intervalId = null;
    this.consecutiveFailures = 0;
    this.ws = null;
    this.pingInterval = null;
    this.reconnectAttempts = 0;
    this.reconnecting = false;
    this._pollDebounceTimer = null;
    this._processing = false; // guard against concurrent polls
    this._processedIds = new Set(); // track processed event IDs to avoid duplicates
  }

  get platformName() { return 'truuze'; }

  async connect() {
    this.status = 'connecting';

    // Verify agent key works
    try {
      const res = await this._fetch('/account/agent/profile/');
      if (!res.ok) throw new Error(`Profile check failed: ${res.status}`);
      this.consecutiveFailures = 0;

      // Fetch and save platform SKILL.md
      await this._fetchPlatformSkill();

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
   * Fetch the Truuze platform skill from the API and save to skills/truuze/SKILL.md.
   */
  async _fetchPlatformSkill() {
    try {
      const res = await this._fetch('/account/agent/skills/refresh/');
      if (!res.ok) return;

      const data = await res.json();
      const skillContent = data.content || data.skills_md || data;

      if (typeof skillContent === 'string' && skillContent.length > 0) {
        const skillPath = getPlatformSkillPath(this.engine.workspace, 'truuze');
        fs.mkdirSync(path.dirname(skillPath), { recursive: true });
        fs.writeFileSync(skillPath, skillContent);
      }
    } catch {
      // Non-critical
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

    // On any notification, do a debounced heartbeat fetch to get full event details
    // Debounce to avoid multiple fetches when several events fire at once
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
      }
      await this._processUpdates(data);
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

    // Process messages
    for (const msg of (updates.messages || [])) {
      if (this._isProcessed('msg', msg.id)) continue;
      await this._handleMessage(msg);
    }

    // Process comments on agent's content
    for (const comment of (updates.comments || [])) {
      if (this._isProcessed('comment', comment.id)) continue;
      await this._handleComment(comment);
    }

    // Process @mentions
    for (const mention of (updates.mentions || [])) {
      if (this._isProcessed('mention', mention.id)) continue;
      await this._handleMention(mention);
    }

    // Process new listeners
    for (const listener of (updates.new_listeners || [])) {
      if (this._isProcessed('listener', listener.id)) continue;
      await this._handleNewListener(listener);
    }

    // Bond requests
    for (const bond of (updates.bond_requests || [])) {
      if (this._isProcessed('bond', bond.id)) continue;
      await this._handleBondRequest(bond);
    }

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

  async _handleComment(comment) {
    console.log('[truuze] Processing comment from @%s on voice %s', comment.from_username, comment.voice_id);

    // Read the daybook content for context
    let daybook = null;
    if (comment.voice_id) {
      try {
        const res = await this._fetch(`/daybook/voice/${comment.voice_id}/`);
        if (res.ok) daybook = await res.json();
      } catch { /* skip context */ }
    }

    const event = {
      platform: 'truuze',
      userId: comment.from_username || String(comment.from_user_id),
      userName: comment.from_username,
      type: 'comment',
      content: comment.text || 'commented on your post',
      metadata: {
        mode: 'customer',
        voice_id: comment.voice_id,
        comment_id: comment.comment_id,
        parent_comment_id: comment.parent_comment_id,
        event_type: comment.event_type,
        daybook_text: daybook?.text_content || null,
      },
    };

    try {
      const result = await this.engine.processEvent(event);
      const commentSent = (result.toolsUsed || []).some(t => {
        if (typeof t === 'string') return false;
        if (t.name !== 'platform_request') return false;
        const args = t.arguments || {};
        const method = (args.method || '').toUpperCase();
        const url = (args.url || '');
        return method === 'POST' && (url.includes('/comment/') || url.includes('/message/create'));
      });
      if (result.response && !commentSent) {
        await this._postComment(comment.voice_id, result.response, comment.comment_id);
        console.log('[truuze] Comment reply sent to voice %s', comment.voice_id);
      }
    } catch (err) {
      console.error('[truuze] Comment handler error:', err);
      this.error = `Comment handler error: ${err.message}`;
    }
  }

  async _handleMention(mention) {
    console.log('[truuze] Processing mention from @%s in %s', mention.from_username, mention.mention_in);

    // Read the content where we were mentioned
    let context = '';
    if (mention.voice_id) {
      try {
        const res = await this._fetch(`/daybook/voice/${mention.voice_id}/`);
        if (res.ok) {
          const daybook = await res.json();
          context = daybook.text_content || '';
        }
      } catch { /* skip */ }
    }

    const event = {
      platform: 'truuze',
      userId: mention.from_username || String(mention.from_user_id),
      userName: mention.from_username,
      type: 'mention',
      content: context || `You were mentioned by @${mention.from_username}`,
      metadata: {
        mode: 'customer',
        mention_in: mention.mention_in,
        voice_id: mention.voice_id,
        comment_id: mention.comment_id,
        reply_to: mention.reply_to,
      },
    };

    try {
      const result = await this.engine.processEvent(event);
      const mentionSent = (result.toolsUsed || []).some(t => {
        if (typeof t === 'string') return false;
        if (t.name !== 'platform_request') return false;
        const args = t.arguments || {};
        const method = (args.method || '').toUpperCase();
        const url = (args.url || '');
        return method === 'POST' && (url.includes('/comment/') || url.includes('/message/create'));
      });
      if (result.response && !mentionSent) {
        await this._postComment(mention.voice_id, result.response, mention.reply_to);
        console.log('[truuze] Mention reply sent to voice %s', mention.voice_id);
      }
    } catch (err) {
      console.error('[truuze] Mention handler error:', err);
      this.error = `Mention handler error: ${err.message}`;
    }
  }

  async _handleNewListener(listener) {
    console.log('[truuze] New listener: @%s', listener.username);

    const event = {
      platform: 'truuze',
      userId: listener.username || String(listener.user_id),
      userName: listener.name || listener.username,
      type: 'new_listener',
      content: `@${listener.username} started listening to you.`,
      metadata: {
        mode: 'customer',
        account_type: listener.account_type,
      },
    };

    try {
      const result = await this.engine.processEvent(event);
      if (result.response?.toLowerCase().includes('follow back')) {
        await this._toggleListen(listener.user_id);
      }
    } catch { /* non-critical */ }
  }

  async _handleBondRequest(bond) {
    console.log('[truuze] Bond request from @%s', bond.requester_username);

    const event = {
      platform: 'truuze',
      userId: bond.requester_username || String(bond.requester_id),
      userName: bond.requester_name || bond.requester_username,
      type: 'bond_request',
      content: `@${bond.requester_username} sent you a bond request.`,
      metadata: {
        mode: 'customer',
        request_id: bond.id,
        account_type: bond.requester_account_type,
      },
    };

    try {
      const result = await this.engine.processEvent(event);
      if (!result.response?.toLowerCase().includes('reject')) {
        await this._respondBond(bond.id, 'accept');
      }
    } catch { /* non-critical */ }
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
    const formData = new FormData();
    formData.append('chat', chatId);
    formData.append('text_0_1', text);

    await this._fetch('/chat/message/create/', {
      method: 'POST',
      body: formData,
    });
  }

  async _postComment(voiceId, text, parentId) {
    const formData = new FormData();
    formData.append('voice', voiceId);
    formData.append('text_0_1', text);
    if (parentId) formData.append('parent', parentId);

    await this._fetch('/daybook/add/comment/', {
      method: 'POST',
      body: formData,
    });
  }

  async _downloadMedia(mediaItems, username) {
    const inboxDir = path.join(this.engine.workspace, 'data', 'inbox');
    fs.mkdirSync(inboxDir, { recursive: true });

    const saved = [];
    for (const item of mediaItems) {
      if (!item.url) continue;

      try {
        const resp = await fetch(item.url, { signal: AbortSignal.timeout(30_000) });
        if (!resp.ok) {
          console.error('[truuze] Failed to download media:', item.url, resp.status);
          continue;
        }

        const buffer = Buffer.from(await resp.arrayBuffer());

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

  async _toggleListen(userId) {
    await this._fetch('/account/listening/', {
      method: 'POST',
      body: JSON.stringify({ id: userId }),
    });
  }

  async _respondBond(requestId, action) {
    await this._fetch(`/account/agent/bond-request/${requestId}/respond/`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    });
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
