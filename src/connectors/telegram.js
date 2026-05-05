import fs from 'fs';
import path from 'path';
import { BaseConnector } from './index.js';
import { readFileBuffer } from './media.js';
import { writePlatformSkill } from '../utils/workspace.js';
import { findAlertByChannelMessage, getRecentOpenAlerts } from '../notifications/alerts.js';
import { loadConnection, saveConnection } from '../auth/connections.js';

const TELEGRAM_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024; // Bot API hard limit

const TELEGRAM_SKILL = `---
name: telegram
description: Sending files to users via the Telegram connector
---

# Telegram Connector — Sending Files

When chatting with users on Telegram, you can send images, audio, video, and
documents in addition to text. The connector handles the upload to Telegram for
you — you just need to **embed the file in your reply as markdown using a
workspace-relative path**.

## How to send a file

1. Place (or generate) the file inside your workspace, e.g. \`data/photos/foo.png\`.
2. In your reply, embed it using markdown:

   - Image:    \`![caption](data/photos/foo.png)\`
   - Audio:    \`[song.mp3](data/audio/song.mp3)\`
   - Video:    \`[clip.mp4](data/video/clip.mp4)\`
   - Document: \`[report.pdf](data/files/report.pdf)\`

3. The connector strips the markdown ref out of the text and uploads the file
   to Telegram via \`sendPhoto\` / \`sendAudio\` / \`sendVideo\` / \`sendDocument\`.
   The \`alt\` / link text becomes the Telegram caption.

## Rules

- **Paths must be workspace-relative.** Absolute paths, \`/api/workspace/...\`
  URLs, or anything outside the workspace will be silently dropped for security.
- File type is detected from the extension. Unknown extensions are sent as
  documents.
- Telegram limits: photos ≤ 10 MB, other files ≤ 50 MB per upload.
- You may embed multiple files in one reply — they are sent before the text.
- Text replies are sent with \`parse_mode: Markdown\` and split at 4096 chars.
`;

/**
 * Telegram connector — connects the agent to a Telegram bot.
 * Uses long polling (getUpdates) for real-time message delivery.
 * No external dependencies — uses the Telegram Bot API directly via fetch.
 */
export default class TelegramConnector extends BaseConnector {
  constructor(config, engine) {
    super(config, engine);
    this.token = config.botToken;
    this.apiBase = `https://api.telegram.org/bot${this.token}`;
    this.offset = 0;
    this.polling = false;
    this.pollController = null;
  }

  get platformName() { return 'telegram'; }

  async connect() {
    this.status = 'connecting';
    writePlatformSkill(this.engine?.workspace, 'telegram', TELEGRAM_SKILL);

    // Verify the bot token
    try {
      const resp = await fetch(`${this.apiBase}/getMe`);
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.description || `Invalid bot token (${resp.status})`);
      }
      const data = await resp.json();
      this.botInfo = data.result;
      console.log(`[telegram] Connected as @${this.botInfo.username} (${this.botInfo.first_name})`);
    } catch (err) {
      this.status = 'error';
      this.error = err.message;
      throw err;
    }

    this.status = 'connected';
    this.error = null;
    this.polling = true;
    this.pollFailures = 0;
    this._poll();
  }

  async _poll() {
    while (this.polling) {
      try {
        this.pollController = new AbortController();
        const resp = await fetch(
          `${this.apiBase}/getUpdates?offset=${this.offset}&timeout=30&allowed_updates=["message"]`,
          { signal: this.pollController.signal }
        );

        if (!resp.ok) {
          if (resp.status === 409) {
            console.error('[telegram] Conflict: another process is polling this bot token. Stop the other instance and try again.');
            this.status = 'error';
            this.error = 'Another instance is polling this bot token. Stop the other instance and try again.';
            this.polling = false;
            break;
          }
          this.pollFailures++;
          if (this.pollFailures >= 3) {
            console.error(`[telegram] Persistent poll failure (${this.pollFailures}x): HTTP ${resp.status}`);
          } else {
            console.warn(`[telegram] Poll interrupted (HTTP ${resp.status}), retrying...`);
          }
          await this._sleep(5000);
          continue;
        }

        this.pollFailures = 0;

        const data = await resp.json();
        if (!data.ok || !data.result?.length) continue;

        for (const update of data.result) {
          this.offset = update.update_id + 1;

          const msg = update.message;
          if (!msg) continue;

          const mediaItems = this._extractMediaItems(msg);
          const hasText = !!(msg.text || msg.caption);
          if (!hasText && mediaItems.length === 0) continue;

          const userName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || msg.from.username || 'User';
          const userId = String(msg.from.id);

          // Record username → chat ID mapping. Telegram's sendMessage only
          // accepts @username for public channels/groups, not private user
          // chats — so we capture the numeric chat ID at the moment a user
          // messages the bot, and the notifications sender uses this map
          // to resolve usernames typed in the dashboard.
          if (msg.from.username) {
            try {
              const uname = String(msg.from.username).toLowerCase();
              if (!this._userMapCache) {
                const conn0 = loadConnection(this.engine.workspace, 'telegram') || {};
                this._userMapCache = { ...(conn0.userMap || {}) };
              }
              if (this._userMapCache[uname] !== userId) {
                this._userMapCache[uname] = userId;
                const conn = loadConnection(this.engine.workspace, 'telegram') || {};
                conn.userMap = this._userMapCache;
                saveConnection(this.engine.workspace, 'telegram', conn);
              }
            } catch { /* best-effort */ }
          }

          let content = msg.text || msg.caption || '';
          if (mediaItems.length > 0) {
            const safeUser = (msg.from.username || userName).replace(/[^a-zA-Z0-9._-]/g, '_');
            const savedFiles = await this._downloadMedia(mediaItems, safeUser);
            if (savedFiles.length > 0) {
              const fileList = savedFiles.map(f => `${f.type}: ${f.path}`).join(', ');
              content = content
                ? `${content}\n\n[Attached files: ${fileList}]`
                : `[Attached files: ${fileList}]`;
            }
          }

          try {
            // ── Owner-reply routing ────────────────────────────────
            // If this message is from the verified owner AND it's tied to
            // an outstanding alert (either via Telegram's reply feature or
            // a casual follow-up within the recent window), we route it as
            // admin guidance into the *customer* session that triggered
            // the alert — not as a normal message in the owner's own
            // session. Slash commands always pass through to the engine
            // so /admin and /customer keep working.
            const looksLikeCommand = (content || '').trim().startsWith('/');
            // Use fresh-from-disk check: /admin and notify_owner can update
            // ownerId after the connector started, leaving this.config stale.
            if (this.isOwnerFresh(userId) && !looksLikeCommand) {
              const replyTo = msg.reply_to_message?.message_id;
              const paths = this.engine.paths;
              let alert = null;
              let threaded = false;

              if (replyTo) {
                alert = findAlertByChannelMessage(paths, 'telegram', replyTo);
                threaded = !!alert;
              }

              if (!alert) {
                const recents = getRecentOpenAlerts(paths, {
                  channel: 'telegram',
                  recipient: String(msg.chat.id),
                  windowMinutes: 30,
                });
                if (recents.length === 1) {
                  alert = recents[0];
                } else if (recents.length > 1) {
                  // Disambiguation: ask the owner which alert they mean.
                  const lines = recents.slice(0, 5).map((a, i) =>
                    `${i + 1}. ${a.title} (${a.alert_id.slice(0, 12)}…)`
                  ).join('\n');
                  await this._sendOwnerText(msg.chat.id,
                    `You have ${recents.length} open alerts. Tap the one you want to reply to and use Telegram's reply feature, or include the alert ID in your message.\n\n${lines}`
                  );
                  continue;
                }
              }

              if (alert) {
                const result = await this.engine.processOwnerReply({
                  alert,
                  replyText: content,
                  replyChannel: 'telegram',
                  threaded,
                });
                // Echo the agent's response (if any) back to the owner so
                // they get immediate confirmation of what was done.
                if (result?.response) {
                  await this._sendOwnerText(msg.chat.id, result.response);
                }
                continue;
              }
            }

            // ── Default path: normal message handling ──────────────
            await this.handleEvent({
              platform: 'telegram',
              userId,
              userName,
              type: 'message',
              content,
              metadata: {
                chatId: msg.chat.id,
                messageId: msg.message_id,
                chatType: msg.chat.type,
              },
            });
          } catch (err) {
            console.error(`[telegram] Error processing message:`, err.message);
          }
        }
      } catch (err) {
        if (err.name === 'AbortError') break;
        this.pollFailures++;
        if (this.pollFailures >= 3) {
          console.error(`[telegram] Persistent poll failure (${this.pollFailures}x): ${err.message}`);
        } else {
          console.warn(`[telegram] Connection interrupted, retrying...`);
        }
        await this._sleep(5000);
      }
    }
  }

  async send(event, response, result, files = []) {
    const chatId = event.metadata?.chatId;
    if (!chatId) return;

    // Send files first (with retry)
    for (const file of files) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const buffer = await readFileBuffer(file);
          const blob = new Blob([buffer], { type: file.mimeType });
          const formData = new FormData();
          formData.append('chat_id', chatId);

          let endpoint;
          if (file.type === 'image') {
            formData.append('photo', blob, file.filename);
            endpoint = 'sendPhoto';
          } else if (file.type === 'audio') {
            formData.append('audio', blob, file.filename);
            endpoint = 'sendAudio';
          } else if (file.type === 'video') {
            formData.append('video', blob, file.filename);
            endpoint = 'sendVideo';
          } else {
            formData.append('document', blob, file.filename);
            endpoint = 'sendDocument';
          }
          if (file.alt) formData.append('caption', file.alt);

          const resp = await fetch(`${this.apiBase}/${endpoint}`, { method: 'POST', body: formData });
          if (resp.ok) break;
          console.warn(`[telegram] File send attempt ${attempt}/3 failed: HTTP ${resp.status}`);
          if (attempt < 3) await this._sleep(2000);
          else console.error(`[telegram] Failed to send file ${file.filename} after 3 attempts`);
        } catch (err) {
          console.warn(`[telegram] File send attempt ${attempt}/3 failed: ${err.message}`);
          if (attempt < 3) await this._sleep(2000);
          else console.error(`[telegram] Failed to send file ${file.filename} after 3 attempts`);
        }
      }
    }

    // Send text response with retry
    if (response) {
      const chunks = this._splitMessage(response, 4096);
      for (const chunk of chunks) {
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const resp = await fetch(`${this.apiBase}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: chatId,
                text: chunk,
                parse_mode: 'Markdown',
              }),
            });
            if (resp.ok) break;
            console.warn(`[telegram] Send attempt ${attempt}/3 failed: HTTP ${resp.status}`);
            if (attempt < 3) await this._sleep(2000);
            else console.error('[telegram] Failed to send message after 3 attempts');
          } catch (err) {
            console.warn(`[telegram] Send attempt ${attempt}/3 failed: ${err.message}`);
            if (attempt < 3) await this._sleep(2000);
            else console.error('[telegram] Failed to send message after 3 attempts');
          }
        }
      }
    }
  }

  async disconnect() {
    this.polling = false;
    if (this.pollController) {
      this.pollController.abort();
      this.pollController = null;
    }
    await super.disconnect();
  }

  getStatus() {
    return {
      ...super.getStatus(),
      botUsername: this.botInfo?.username || null,
      botName: this.botInfo?.first_name || null,
    };
  }

  /**
   * Send a plain-text message directly to a chat ID, bypassing the
   * full event/file machinery. Used to confirm owner-reply outcomes
   * back to the owner.
   */
  async _sendOwnerText(chatId, text) {
    if (!text) return;
    const chunks = this._splitMessage(text, 4096);
    for (const chunk of chunks) {
      try {
        await fetch(`${this.apiBase}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: chunk,
            parse_mode: 'Markdown',
          }),
        });
      } catch (err) {
        console.warn(`[telegram] Failed to confirm owner reply: ${err.message}`);
      }
    }
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
      // Try to split at a newline
      let splitAt = remaining.lastIndexOf('\n', maxLen);
      if (splitAt < maxLen * 0.3) splitAt = maxLen;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }
    return chunks;
  }

  /**
   * Pull all downloadable media off a Telegram message into a uniform list.
   * Each item: { type: 'image'|'audio'|'video'|'file', fileId, originalName, fileSize }
   */
  _extractMediaItems(msg) {
    const items = [];

    if (Array.isArray(msg.photo) && msg.photo.length > 0) {
      // Pick the largest size variant
      const largest = msg.photo.reduce((a, b) => (b.file_size || 0) > (a.file_size || 0) ? b : a, msg.photo[0]);
      items.push({
        type: 'image',
        fileId: largest.file_id,
        originalName: `photo_${largest.file_unique_id || Date.now()}.jpg`,
        fileSize: largest.file_size || 0,
      });
    }

    if (msg.voice) {
      items.push({
        type: 'audio',
        fileId: msg.voice.file_id,
        originalName: `voice_${msg.voice.file_unique_id || Date.now()}.ogg`,
        fileSize: msg.voice.file_size || 0,
      });
    }

    if (msg.audio) {
      items.push({
        type: 'audio',
        fileId: msg.audio.file_id,
        originalName: msg.audio.file_name || `audio_${msg.audio.file_unique_id || Date.now()}.mp3`,
        fileSize: msg.audio.file_size || 0,
      });
    }

    if (msg.video) {
      items.push({
        type: 'video',
        fileId: msg.video.file_id,
        originalName: msg.video.file_name || `video_${msg.video.file_unique_id || Date.now()}.mp4`,
        fileSize: msg.video.file_size || 0,
      });
    }

    if (msg.video_note) {
      items.push({
        type: 'video',
        fileId: msg.video_note.file_id,
        originalName: `video_note_${msg.video_note.file_unique_id || Date.now()}.mp4`,
        fileSize: msg.video_note.file_size || 0,
      });
    }

    if (msg.document) {
      items.push({
        type: 'file',
        fileId: msg.document.file_id,
        originalName: msg.document.file_name || `document_${msg.document.file_unique_id || Date.now()}`,
        fileSize: msg.document.file_size || 0,
      });
    }

    return items;
  }

  /**
   * Download Telegram media items into the workspace inbox.
   * Mirrors truuze.js _downloadMedia: writes to data/inbox/<user>_<ts>_<safeName>
   * and returns [{type, path}] with workspace-relative paths.
   */
  async _downloadMedia(mediaItems, username) {
    const inboxDir = path.join(this.engine.workspace, 'data', 'inbox');
    fs.mkdirSync(inboxDir, { recursive: true });

    const saved = [];
    for (const item of mediaItems) {
      try {
        if (item.fileSize && item.fileSize > TELEGRAM_MAX_DOWNLOAD_BYTES) {
          console.warn(`[telegram] Skipping ${item.originalName}: ${item.fileSize} bytes exceeds 20 MB Bot API limit`);
          continue;
        }

        let buffer;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            // Step 1: getFile
            const infoResp = await fetch(`${this.apiBase}/getFile?file_id=${encodeURIComponent(item.fileId)}`, {
              signal: AbortSignal.timeout(15_000),
            });
            if (!infoResp.ok) {
              console.warn(`[telegram] getFile attempt ${attempt}/3 failed: ${item.fileId} HTTP ${infoResp.status}`);
              if (attempt < 3) { await this._sleep(2000); continue; }
              break;
            }
            const info = await infoResp.json();
            if (!info.ok || !info.result?.file_path) {
              console.error('[telegram] getFile bad response:', info.description || 'no file_path');
              break; // not retriable
            }

            // Step 2: download bytes
            const fileUrl = `https://api.telegram.org/file/bot${this.token}/${info.result.file_path}`;
            const resp = await fetch(fileUrl, { signal: AbortSignal.timeout(60_000) });
            if (!resp.ok) {
              console.warn(`[telegram] Download attempt ${attempt}/3 failed: ${item.fileId} HTTP ${resp.status}`);
              if (attempt < 3) { await this._sleep(2000); continue; }
              break;
            }
            buffer = Buffer.from(await resp.arrayBuffer());
            break;
          } catch (fetchErr) {
            console.warn(`[telegram] Download attempt ${attempt}/3 failed: ${item.fileId} ${fetchErr.message}`);
            if (attempt < 3) await this._sleep(2000);
          }
        }
        if (!buffer) {
          console.error('[telegram] Failed to download media after 3 attempts:', item.fileId);
          continue;
        }

        // Build filename: username_timestamp_originalname
        const safeName = item.originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
        const filename = `${username}_${Date.now()}_${safeName}`;
        const filePath = path.join(inboxDir, filename);
        fs.writeFileSync(filePath, buffer);

        const relativePath = `data/inbox/${filename}`;
        saved.push({ type: item.type, path: relativePath });
        console.log('[telegram] Downloaded media:', item.type, relativePath, buffer.length, 'bytes');
      } catch (err) {
        console.error('[telegram] Media download error:', item.fileId, err.message);
      }
    }
    return saved;
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
