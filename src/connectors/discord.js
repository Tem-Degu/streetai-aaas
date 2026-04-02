import { WebSocket } from 'ws';
import { BaseConnector } from './index.js';

/**
 * Discord connector — connects the agent to a Discord bot.
 * Uses Discord Gateway API (WebSocket) for real-time messages.
 * No external dependencies beyond ws (already used by the project).
 */
export default class DiscordConnector extends BaseConnector {
  constructor(config, engine) {
    super(config, engine);
    this.token = config.botToken;
    this.apiBase = 'https://discord.com/api/v10';
    this.ws = null;
    this.heartbeatInterval = null;
    this.lastSequence = null;
    this.botUser = null;
    this.resumeUrl = null;
    this.sessionId = null;
  }

  get platformName() { return 'discord'; }

  async connect() {
    this.status = 'connecting';

    // Verify the bot token
    try {
      const resp = await fetch(`${this.apiBase}/users/@me`, {
        headers: { Authorization: `Bot ${this.token}` },
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.message || `Invalid bot token (${resp.status})`);
      }
      this.botUser = await resp.json();
      console.log(`[discord] Verified bot: ${this.botUser.username}#${this.botUser.discriminator}`);
    } catch (err) {
      this.status = 'error';
      this.error = err.message;
      throw err;
    }

    // Get gateway URL
    const gwResp = await fetch(`${this.apiBase}/gateway/bot`, {
      headers: { Authorization: `Bot ${this.token}` },
    });
    if (!gwResp.ok) throw new Error('Failed to get gateway URL');
    const gwData = await gwResp.json();
    const gatewayUrl = gwData.url;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${gatewayUrl}?v=10&encoding=json`);

      this.ws.on('message', (raw) => {
        const payload = JSON.parse(raw.toString());
        this._handlePayload(payload);
      });

      this.ws.on('open', () => {
        console.log('[discord] WebSocket connected');
      });

      this.ws.on('close', (code) => {
        console.log(`[discord] WebSocket closed: ${code}`);
        this._stopHeartbeat();
        if (this.status === 'connected') {
          this.status = 'reconnecting';
          setTimeout(() => this._reconnect(), 5000);
        }
      });

      this.ws.on('error', (err) => {
        console.error('[discord] WebSocket error:', err.message);
      });

      // Resolve once we get READY event
      this._connectResolve = resolve;
      this._connectReject = reject;

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.status === 'connecting') {
          this.status = 'error';
          this.error = 'Connection timeout';
          reject(new Error('Connection timeout'));
        }
      }, 30000);
    });
  }

  _handlePayload(payload) {
    const { op, t, s, d } = payload;

    if (s) this.lastSequence = s;

    switch (op) {
      case 10: // Hello
        this._startHeartbeat(d.heartbeat_interval);
        this._identify();
        break;

      case 11: // Heartbeat ACK
        break;

      case 0: // Dispatch
        this._handleDispatch(t, d);
        break;

      case 7: // Reconnect
        this._reconnect();
        break;

      case 9: // Invalid session
        setTimeout(() => this._identify(), 2000);
        break;
    }
  }

  _identify() {
    this.ws.send(JSON.stringify({
      op: 2,
      d: {
        token: this.token,
        intents: (1 << 9) | (1 << 15) | (1 << 12), // GUILD_MESSAGES | MESSAGE_CONTENT | DIRECT_MESSAGES
        properties: {
          os: 'linux',
          browser: 'aaas',
          device: 'aaas',
        },
      },
    }));
  }

  _handleDispatch(event, data) {
    switch (event) {
      case 'READY':
        this.sessionId = data.session_id;
        this.resumeUrl = data.resume_gateway_url;
        this.status = 'connected';
        this.error = null;
        console.log(`[discord] Ready as ${data.user.username}`);
        if (this._connectResolve) {
          this._connectResolve();
          this._connectResolve = null;
        }
        break;

      case 'MESSAGE_CREATE':
        // Ignore messages from the bot itself
        if (data.author.id === this.botUser.id) return;
        // Ignore messages from other bots
        if (data.author.bot) return;

        // Only respond to DMs or messages that mention the bot
        const isDM = !data.guild_id;
        const isMentioned = data.mentions?.some(m => m.id === this.botUser.id);

        if (isDM || isMentioned) {
          // Strip the bot mention from the message
          let content = data.content;
          if (isMentioned) {
            content = content.replace(new RegExp(`<@!?${this.botUser.id}>`, 'g'), '').trim();
          }
          if (!content) return;

          this.handleEvent({
            platform: 'discord',
            userId: data.author.id,
            userName: data.author.global_name || data.author.username || 'User',
            type: 'message',
            content,
            metadata: {
              channelId: data.channel_id,
              messageId: data.id,
              guildId: data.guild_id || null,
              isDM,
            },
          }).catch(err => {
            console.error('[discord] Error processing message:', err.message);
          });
        }
        break;
    }
  }

  _startHeartbeat(intervalMs) {
    this._stopHeartbeat();
    // First heartbeat after a random jitter
    setTimeout(() => {
      this._sendHeartbeat();
      this.heartbeatInterval = setInterval(() => this._sendHeartbeat(), intervalMs);
    }, intervalMs * Math.random());
  }

  _stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  _sendHeartbeat() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ op: 1, d: this.lastSequence }));
    }
  }

  async _reconnect() {
    this._stopHeartbeat();
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    if (this.status === 'disconnected') return;

    console.log('[discord] Reconnecting...');
    this.status = 'reconnecting';

    try {
      await this.connect();
    } catch (err) {
      console.error('[discord] Reconnect failed:', err.message);
      setTimeout(() => this._reconnect(), 10000);
    }
  }

  async send(event, response) {
    const channelId = event.metadata?.channelId;
    if (!channelId) return;

    // Discord has a 2000 character limit per message
    const chunks = this._splitMessage(response, 2000);
    for (const chunk of chunks) {
      await fetch(`${this.apiBase}/channels/${channelId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bot ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: chunk }),
      });
    }
  }

  async disconnect() {
    this.polling = false;
    this._stopHeartbeat();
    if (this.ws) {
      try { this.ws.close(1000); } catch { /* ignore */ }
      this.ws = null;
    }
    await super.disconnect();
  }

  getStatus() {
    return {
      ...super.getStatus(),
      botUsername: this.botUser?.username || null,
      botName: this.botUser?.global_name || this.botUser?.username || null,
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
