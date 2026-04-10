import fs from 'fs';
import path from 'path';
import { WebSocket } from 'ws';
import { BaseConnector } from './index.js';
import { readFileBuffer } from './media.js';
import { writePlatformSkill } from '../utils/workspace.js';

const DISCORD_MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024; // Discord caps user uploads at 25 MB by default; cap higher for boosted servers

const DISCORD_SKILL = `---
name: discord
description: Sending files to users via the Discord connector
---

# Discord Connector — Sending Files

You can attach images, audio, video, and arbitrary files to your Discord
messages. The connector uploads them as multipart attachments — you just embed
the file in your reply as markdown using a **workspace-relative** path.

## How to send a file

1. Place (or generate) the file inside your workspace, e.g. \`data/photos/foo.png\`.
2. Embed it in your reply using markdown:

   - Image:    \`![caption](data/photos/foo.png)\`
   - Audio:    \`[song.mp3](data/audio/song.mp3)\`
   - Video:    \`[clip.mp4](data/video/clip.mp4)\`
   - File:     \`[notes.pdf](data/files/notes.pdf)\`

3. The connector strips the markdown ref out of the text and attaches the
   file(s) to the Discord message via multipart upload. Images render inline
   in Discord; other files appear as attachments.

## Rules

- **Paths must be workspace-relative.** Absolute or out-of-workspace paths are
  silently dropped.
- Discord per-message attachment size limit: **25 MB total** (free server boost
  level). Larger files will be rejected.
- You can attach multiple files in one reply — they all ride along with the
  first message chunk.
- Text replies use Discord markdown and are split at 2000 chars.
`;

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
    writePlatformSkill(this.engine?.workspace, 'discord', DISCORD_SKILL);

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

      case 'MESSAGE_CREATE': {
        // Ignore messages from the bot itself
        if (data.author.id === this.botUser.id) return;
        // Ignore messages from other bots
        if (data.author.bot) return;

        // Only respond to DMs or messages that mention the bot
        const isDM = !data.guild_id;
        const isMentioned = data.mentions?.some(m => m.id === this.botUser.id);
        if (!isDM && !isMentioned) return;

        // Strip the bot mention from the message
        let textPart = data.content || '';
        if (isMentioned) {
          textPart = textPart.replace(new RegExp(`<@!?${this.botUser.id}>`, 'g'), '').trim();
        }

        const attachments = Array.isArray(data.attachments) ? data.attachments : [];
        if (!textPart && attachments.length === 0) return;

        const userName = data.author.global_name || data.author.username || 'User';

        // Download attachments + dispatch async so we don't block the WS read loop
        (async () => {
          try {
            let content = textPart || '';
            if (attachments.length > 0) {
              const safeUser = String(data.author.username || userName).replace(/[^a-zA-Z0-9._-]/g, '_');
              const savedFiles = await this._downloadMedia(attachments, safeUser);
              if (savedFiles.length > 0) {
                const fileList = savedFiles.map(f => `${f.type}: ${f.path}`).join(', ');
                content = content
                  ? `${content}\n\n[Attached files: ${fileList}]`
                  : `[Attached files: ${fileList}]`;
              }
            }

            await this.handleEvent({
              platform: 'discord',
              userId: data.author.id,
              userName,
              type: 'message',
              content,
              metadata: {
                channelId: data.channel_id,
                messageId: data.id,
                guildId: data.guild_id || null,
                isDM,
              },
            });
          } catch (err) {
            console.error('[discord] Error processing message:', err.message);
          }
        })();
        break;
      }
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

  async send(event, response, result, files = []) {
    const channelId = event.metadata?.channelId;
    if (!channelId) return;

    // If there are files, send the first message with attachments via multipart
    if (files.length > 0) {
      try {
        const formData = new FormData();
        const payload = { content: response ? this._splitMessage(response, 2000)[0] : '' };
        formData.append('payload_json', JSON.stringify(payload));

        for (let i = 0; i < files.length && i < 10; i++) {
          const buffer = await readFileBuffer(files[i]);
          const blob = new Blob([buffer], { type: files[i].mimeType });
          formData.append(`files[${i}]`, blob, files[i].filename);
        }

        await fetch(`${this.apiBase}/channels/${channelId}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bot ${this.token}` },
          body: formData,
        });

        // Send remaining text chunks if the response was too long
        if (response && response.length > 2000) {
          const chunks = this._splitMessage(response, 2000);
          for (let i = 1; i < chunks.length; i++) {
            await fetch(`${this.apiBase}/channels/${channelId}/messages`, {
              method: 'POST',
              headers: {
                Authorization: `Bot ${this.token}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ content: chunks[i] }),
            });
          }
        }
      } catch (err) {
        console.error('[discord] Failed to send files:', err.message);
        // Fallback to text-only
        if (response) {
          await this._sendTextOnly(channelId, response);
        }
      }
      return;
    }

    // Text-only
    if (response) {
      await this._sendTextOnly(channelId, response);
    }
  }

  async _sendTextOnly(channelId, text) {
    const chunks = this._splitMessage(text, 2000);
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

  _typeFromMime(mime) {
    if (!mime) return 'file';
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime.startsWith('video/')) return 'video';
    return 'file';
  }

  /**
   * Download Discord attachments into the workspace inbox.
   * Mirrors truuze.js _downloadMedia: writes to data/inbox/<user>_<ts>_<safeName>
   * and returns [{type, path}] with workspace-relative paths.
   *
   * Discord attachment URLs are CDN links and require no auth header.
   */
  async _downloadMedia(attachments, username) {
    const inboxDir = path.join(this.engine.workspace, 'data', 'inbox');
    fs.mkdirSync(inboxDir, { recursive: true });

    const saved = [];
    for (const att of attachments) {
      try {
        const url = att.url || att.proxy_url;
        if (!url) {
          console.error('[discord] attachment has no url:', att.id);
          continue;
        }
        if (att.size && att.size > DISCORD_MAX_DOWNLOAD_BYTES) {
          console.warn(`[discord] Skipping ${att.filename}: ${att.size} bytes exceeds limit`);
          continue;
        }

        const resp = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        if (!resp.ok) {
          console.error('[discord] Failed to download attachment:', att.id, resp.status);
          continue;
        }
        const buffer = Buffer.from(await resp.arrayBuffer());

        const type = this._typeFromMime(att.content_type);
        const originalName = att.filename || `file_${att.id || Date.now()}`;
        const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
        const filename = `${username}_${Date.now()}_${safeName}`;
        const filePath = path.join(inboxDir, filename);
        fs.writeFileSync(filePath, buffer);

        const relativePath = `data/inbox/${filename}`;
        saved.push({ type, path: relativePath });
        console.log('[discord] Downloaded attachment:', type, relativePath, buffer.length, 'bytes');
      } catch (err) {
        console.error('[discord] Attachment download error:', att.id, err.message);
      }
    }
    return saved;
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
