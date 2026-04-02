import { WebSocket } from 'ws';
import { BaseConnector } from './index.js';

/**
 * Slack connector — connects the agent to a Slack bot.
 * Uses Socket Mode (WebSocket) for real-time messages.
 * No external dependencies beyond ws (already used by the project).
 *
 * Requires two tokens:
 * - Bot Token (xoxb-...) — for sending messages via Web API
 * - App-Level Token (xapp-...) — for Socket Mode WebSocket connection
 */
export default class SlackConnector extends BaseConnector {
  constructor(config, engine) {
    super(config, engine);
    this.botToken = config.botToken;
    this.appToken = config.appToken;
    this.apiBase = 'https://slack.com/api';
    this.ws = null;
    this.botUserId = null;
    this.botInfo = null;
  }

  get platformName() { return 'slack'; }

  async connect() {
    this.status = 'connecting';

    // Verify the bot token
    try {
      const resp = await fetch(`${this.apiBase}/auth.test`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.botToken}` },
      });
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || 'Invalid bot token');
      this.botUserId = data.user_id;
      this.botInfo = { userId: data.user_id, teamId: data.team_id, botName: data.user };
      console.log(`[slack] Verified bot: ${data.user} (team: ${data.team})`);
    } catch (err) {
      this.status = 'error';
      this.error = err.message;
      throw err;
    }

    // Open Socket Mode connection
    await this._connectWebSocket();
  }

  async _connectWebSocket() {
    // Get a WebSocket URL via apps.connections.open
    const resp = await fetch(`${this.apiBase}/apps.connections.open`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.appToken}` },
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(`Socket Mode failed: ${data.error}`);

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(data.url);

      this.ws.on('open', () => {
        console.log('[slack] Socket Mode connected');
      });

      this.ws.on('message', (raw) => {
        const payload = JSON.parse(raw.toString());
        this._handlePayload(payload, resolve);
      });

      this.ws.on('close', (code) => {
        console.log(`[slack] WebSocket closed: ${code}`);
        if (this.status === 'connected') {
          this.status = 'reconnecting';
          setTimeout(() => this._reconnect(), 5000);
        }
      });

      this.ws.on('error', (err) => {
        console.error('[slack] WebSocket error:', err.message);
      });

      // Timeout
      setTimeout(() => {
        if (this.status === 'connecting') {
          this.status = 'error';
          this.error = 'Connection timeout';
          reject(new Error('Connection timeout'));
        }
      }, 30000);
    });
  }

  _handlePayload(payload, connectResolve) {
    const { type, envelope_id } = payload;

    // Acknowledge all envelopes immediately
    if (envelope_id) {
      this.ws.send(JSON.stringify({ envelope_id }));
    }

    switch (type) {
      case 'hello':
        this.status = 'connected';
        this.error = null;
        console.log('[slack] Socket Mode ready');
        if (connectResolve) connectResolve();
        break;

      case 'events_api':
        this._handleEvent(payload.payload);
        break;

      case 'disconnect':
        console.log('[slack] Server requested disconnect, reconnecting...');
        this._reconnect();
        break;
    }
  }

  _handleEvent(payload) {
    const event = payload?.event;
    if (!event) return;

    // Handle message events
    if (event.type === 'message' && !event.subtype && event.user !== this.botUserId) {
      // DMs (im) or mentions in channels
      const isDM = event.channel_type === 'im';
      const isMentioned = event.text?.includes(`<@${this.botUserId}>`);

      if (isDM || isMentioned) {
        // Strip bot mention
        let content = event.text || '';
        if (isMentioned) {
          content = content.replace(new RegExp(`<@${this.botUserId}>`, 'g'), '').trim();
        }
        if (!content) return;

        this.handleEvent({
          platform: 'slack',
          userId: event.user,
          userName: event.user, // Slack doesn't include name in events, userId is fine
          type: 'message',
          content,
          metadata: {
            channelId: event.channel,
            threadTs: event.thread_ts || event.ts,
            ts: event.ts,
            isDM,
          },
        }).catch(err => {
          console.error('[slack] Error processing message:', err.message);
        });
      }
    }

    // Handle app_mention events (for channels where the bot is mentioned)
    if (event.type === 'app_mention' && event.user !== this.botUserId) {
      let content = (event.text || '').replace(new RegExp(`<@${this.botUserId}>`, 'g'), '').trim();
      if (!content) return;

      this.handleEvent({
        platform: 'slack',
        userId: event.user,
        userName: event.user,
        type: 'message',
        content,
        metadata: {
          channelId: event.channel,
          threadTs: event.thread_ts || event.ts,
          ts: event.ts,
          isDM: false,
        },
      }).catch(err => {
        console.error('[slack] Error processing mention:', err.message);
      });
    }
  }

  async send(event, response) {
    const channelId = event.metadata?.channelId;
    if (!channelId) return;

    // Reply in thread if there's a thread_ts
    const threadTs = event.metadata?.threadTs;

    // Slack has a ~4000 character limit per message (varies slightly)
    const chunks = this._splitMessage(response, 4000);
    for (const chunk of chunks) {
      const body = {
        channel: channelId,
        text: chunk,
      };
      if (threadTs) body.thread_ts = threadTs;

      await fetch(`${this.apiBase}/chat.postMessage`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.botToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    }
  }

  async _reconnect() {
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    if (this.status === 'disconnected') return;

    console.log('[slack] Reconnecting...');
    this.status = 'reconnecting';

    try {
      await this._connectWebSocket();
    } catch (err) {
      console.error('[slack] Reconnect failed:', err.message);
      setTimeout(() => this._reconnect(), 10000);
    }
  }

  async disconnect() {
    if (this.ws) {
      try { this.ws.close(1000); } catch { /* ignore */ }
      this.ws = null;
    }
    await super.disconnect();
  }

  getStatus() {
    return {
      ...super.getStatus(),
      botUserId: this.botUserId || null,
      botName: this.botInfo?.botName || null,
    };
  }

  _splitMessage(text, maxLen) {
    if (text.length <= maxLen) return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }
      let splitAt = remaining.lastIndexOf('\n', maxLen);
      if (splitAt < maxLen * 0.3) splitAt = maxLen;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }
    return chunks;
  }
}
