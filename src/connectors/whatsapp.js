import fs from 'fs';
import path from 'path';
import express from 'express';
import { createServer } from 'http';
import { BaseConnector } from './index.js';
import { readFileBuffer } from './media.js';
import { writePlatformSkill } from '../utils/workspace.js';

const WHATSAPP_MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024; // Documents go up to 100 MB

const WHATSAPP_SKILL = `---
name: whatsapp
description: Sending files to users via the WhatsApp connector
---

# WhatsApp Connector — Sending Files

You can send images, audio, video, and documents to users on WhatsApp in
addition to text. The connector handles uploading the file to Meta's Cloud API
and sending the message — you just embed the file in your reply as markdown
with a **workspace-relative** path.

## How to send a file

1. Place (or generate) the file inside your workspace, e.g. \`data/photos/foo.jpg\`.
2. Embed it in your reply using markdown:

   - Image:    \`![caption](data/photos/foo.jpg)\`
   - Audio:    \`[voice.ogg](data/audio/voice.ogg)\`
   - Video:    \`[clip.mp4](data/video/clip.mp4)\`
   - Document: \`[menu.pdf](data/files/menu.pdf)\`

3. The connector uploads the file to WhatsApp's media endpoint and sends it as
   the matching message type. Image/video/document captions come from the
   markdown alt / link text. Audio messages have no caption.

## Rules

- **Paths must be workspace-relative.** Absolute or out-of-workspace paths are
  silently dropped.
- WhatsApp media size limits (Meta Cloud API):
  - Images: 5 MB (jpeg, png)
  - Audio: 16 MB (aac, mp4, mpeg, amr, ogg)
  - Video: 16 MB (mp4, 3gpp)
  - Documents: 100 MB
- Use supported MIME types — unsupported types will be rejected by Meta.
- Files are sent before the text portion of the reply.
- Text is split into 4096-char chunks if needed.
`;

/**
 * WhatsApp connector — connects the agent to WhatsApp Business API.
 * Uses Meta's Cloud API with webhook for incoming messages.
 *
 * The user must:
 * 1. Have a Meta Business account with WhatsApp Business API access
 * 2. Set their webhook URL to http://<server>:<port>/webhook
 * 3. Provide the verify token they configured in Meta's dashboard
 *
 * Required config:
 * - accessToken: Meta's permanent access token for the WhatsApp Business API
 * - phoneNumberId: The WhatsApp Business phone number ID
 * - verifyToken: A string the user chooses for webhook verification
 * - port: Local port to listen on (default 3301)
 */
export default class WhatsAppConnector extends BaseConnector {
  constructor(config, engine) {
    super(config, engine);
    this.accessToken = config.accessToken;
    this.phoneNumberId = config.phoneNumberId;
    this.verifyToken = config.verifyToken;
    this.port = config.port || 3301;
    this.apiBase = 'https://graph.facebook.com/v21.0';
    this.server = null;
    this.businessName = null;
  }

  get platformName() { return 'whatsapp'; }

  async connect() {
    this.status = 'connecting';
    writePlatformSkill(this.engine?.workspace, 'whatsapp', WHATSAPP_SKILL);

    // Verify the access token by fetching phone number details
    try {
      const resp = await fetch(
        `${this.apiBase}/${this.phoneNumberId}?fields=display_phone_number,verified_name`,
        { headers: { Authorization: `Bearer ${this.accessToken}` } }
      );
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error?.message || `Invalid credentials (${resp.status})`);
      }
      const data = await resp.json();
      this.businessName = data.verified_name || data.display_phone_number;
      console.log(`[whatsapp] Verified: ${this.businessName} (${data.display_phone_number})`);
    } catch (err) {
      this.status = 'error';
      this.error = err.message;
      throw err;
    }

    // Start local webhook server
    const app = express();
    app.use(express.json());

    // Webhook verification (GET) — Meta sends this to verify the endpoint
    app.get('/webhook', (req, res) => {
      const mode = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];

      if (mode === 'subscribe' && token === this.verifyToken) {
        console.log('[whatsapp] Webhook verified');
        res.status(200).send(challenge);
      } else {
        res.sendStatus(403);
      }
    });

    // Webhook events (POST) — Meta sends messages here
    app.post('/webhook', (req, res) => {
      // Always respond 200 quickly to avoid Meta retries
      res.sendStatus(200);

      const body = req.body;
      if (body.object !== 'whatsapp_business_account') return;

      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          if (change.field !== 'messages') continue;
          const value = change.value;
          if (!value?.messages) continue;

          for (const message of value.messages) {
            const mediaItems = this._extractMediaItems(message);
            const textPart = message.type === 'text' ? message.text?.body : (message[message.type]?.caption || '');
            if (!textPart && mediaItems.length === 0) continue;

            const contact = value.contacts?.find(c => c.wa_id === message.from);
            const userName = contact?.profile?.name || message.from;

            // Download media + dispatch in an async IIFE so we don't block the webhook response
            (async () => {
              try {
                let content = textPart || '';
                if (mediaItems.length > 0) {
                  const safeUser = String(userName).replace(/[^a-zA-Z0-9._-]/g, '_');
                  const savedFiles = await this._downloadMedia(mediaItems, safeUser);
                  if (savedFiles.length > 0) {
                    const fileList = savedFiles.map(f => `${f.type}: ${f.path}`).join(', ');
                    content = content
                      ? `${content}\n\n[Attached files: ${fileList}]`
                      : `[Attached files: ${fileList}]`;
                  }
                }

                await this.handleEvent({
                  platform: 'whatsapp',
                  userId: message.from,
                  userName,
                  type: 'message',
                  content,
                  metadata: {
                    phoneNumber: message.from,
                    messageId: message.id,
                    timestamp: message.timestamp,
                  },
                });
              } catch (err) {
                console.error('[whatsapp] Error processing message:', err.message);
              }
            })();
          }
        }
      }
    });

    // Health check
    app.get('/health', (req, res) => {
      res.json({ status: 'ok', platform: 'whatsapp', business: this.businessName });
    });

    return new Promise((resolve, reject) => {
      this.server = createServer(app);

      this.server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          this.error = `Port ${this.port} is in use`;
          this.status = 'error';
          reject(new Error(this.error));
        } else {
          this.error = err.message;
          this.status = 'error';
          reject(err);
        }
      });

      this.server.listen(this.port, () => {
        this.status = 'connected';
        this.error = null;
        console.log(`[whatsapp] Webhook listening on port ${this.port}`);
        console.log(`[whatsapp] Set your Meta webhook URL to: http://<your-server>:${this.port}/webhook`);
        resolve();
      });
    });
  }

  async send(event, response, result, files = []) {
    const phoneNumber = event.metadata?.phoneNumber;
    if (!phoneNumber) return;

    // Send files first via WhatsApp media messages
    for (const file of files) {
      try {
        // Step 1: Upload media to WhatsApp
        const buffer = await readFileBuffer(file);
        const blob = new Blob([buffer], { type: file.mimeType });
        const uploadForm = new FormData();
        uploadForm.append('file', blob, file.filename);
        uploadForm.append('messaging_product', 'whatsapp');
        uploadForm.append('type', file.mimeType);

        const uploadResp = await fetch(
          `${this.apiBase}/${this.phoneNumberId}/media`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${this.accessToken}` },
            body: uploadForm,
          }
        );

        if (!uploadResp.ok) {
          console.error('[whatsapp] Media upload failed:', uploadResp.status);
          continue;
        }

        const { id: mediaId } = await uploadResp.json();

        // Step 2: Send media message
        const mediaType = file.type === 'image' ? 'image'
          : file.type === 'audio' ? 'audio'
          : file.type === 'video' ? 'video'
          : 'document';

        const mediaBody = { id: mediaId };
        if (file.alt && mediaType !== 'audio') mediaBody.caption = file.alt;
        if (mediaType === 'document') mediaBody.filename = file.filename;

        await fetch(
          `${this.apiBase}/${this.phoneNumberId}/messages`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              messaging_product: 'whatsapp',
              to: phoneNumber,
              type: mediaType,
              [mediaType]: mediaBody,
            }),
          }
        );
      } catch (err) {
        console.error(`[whatsapp] Failed to send file ${file.filename}:`, err.message);
      }
    }

    // Send text response with retry
    if (response) {
      const chunks = this._splitMessage(response, 4096);
      for (const chunk of chunks) {
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const resp = await fetch(
              `${this.apiBase}/${this.phoneNumberId}/messages`,
              {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${this.accessToken}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  messaging_product: 'whatsapp',
                  to: phoneNumber,
                  type: 'text',
                  text: { body: chunk },
                }),
              }
            );
            if (resp.ok) break;
            const err = await resp.json().catch(() => ({}));
            console.warn(`[whatsapp] Send attempt ${attempt}/3 failed: ${err.error?.message || resp.status}`);
            if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
            else console.error('[whatsapp] Failed to send message after 3 attempts');
          } catch (err) {
            console.warn(`[whatsapp] Send attempt ${attempt}/3 failed: ${err.message}`);
            if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
            else console.error('[whatsapp] Failed to send message after 3 attempts');
          }
        }
      }
    }
  }

  async disconnect() {
    if (this.server) {
      await new Promise(resolve => this.server.close(resolve));
      this.server = null;
    }
    await super.disconnect();
  }

  getStatus() {
    return {
      ...super.getStatus(),
      port: this.port,
      businessName: this.businessName || null,
      webhookUrl: this.status === 'connected' ? `http://localhost:${this.port}/webhook` : null,
    };
  }

  /**
   * Pull all downloadable media off a WhatsApp incoming message into a uniform list.
   * Each item: { type: 'image'|'audio'|'video'|'file', mediaId, originalName, mimeType }
   */
  _extractMediaItems(msg) {
    const items = [];

    if (msg.type === 'image' && msg.image) {
      items.push({
        type: 'image',
        mediaId: msg.image.id,
        originalName: `image_${msg.id || Date.now()}.${this._extFromMime(msg.image.mime_type) || 'jpg'}`,
        mimeType: msg.image.mime_type,
      });
    }

    if ((msg.type === 'audio' || msg.type === 'voice') && msg.audio) {
      items.push({
        type: 'audio',
        mediaId: msg.audio.id,
        originalName: `audio_${msg.id || Date.now()}.${this._extFromMime(msg.audio.mime_type) || 'ogg'}`,
        mimeType: msg.audio.mime_type,
      });
    }

    if (msg.type === 'video' && msg.video) {
      items.push({
        type: 'video',
        mediaId: msg.video.id,
        originalName: `video_${msg.id || Date.now()}.${this._extFromMime(msg.video.mime_type) || 'mp4'}`,
        mimeType: msg.video.mime_type,
      });
    }

    if (msg.type === 'document' && msg.document) {
      items.push({
        type: 'file',
        mediaId: msg.document.id,
        originalName: msg.document.filename || `document_${msg.id || Date.now()}`,
        mimeType: msg.document.mime_type,
      });
    }

    if (msg.type === 'sticker' && msg.sticker) {
      items.push({
        type: 'image',
        mediaId: msg.sticker.id,
        originalName: `sticker_${msg.id || Date.now()}.webp`,
        mimeType: msg.sticker.mime_type,
      });
    }

    return items;
  }

  _extFromMime(mime) {
    if (!mime) return null;
    const map = {
      'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
      'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/amr': 'amr',
      'video/mp4': 'mp4', 'video/3gpp': '3gp',
      'application/pdf': 'pdf', 'application/zip': 'zip',
      'text/plain': 'txt',
    };
    return map[mime.split(';')[0].trim()] || null;
  }

  /**
   * Download WhatsApp media items into the workspace inbox.
   * Mirrors truuze.js _downloadMedia: writes to data/inbox/<user>_<ts>_<safeName>
   * and returns [{type, path}] with workspace-relative paths.
   *
   * Two-step Meta API: GET /{media_id} → {url}; then GET that url with Bearer token.
   */
  async _downloadMedia(mediaItems, username) {
    const inboxDir = path.join(this.engine.workspace, 'data', 'inbox');
    fs.mkdirSync(inboxDir, { recursive: true });

    const saved = [];
    for (const item of mediaItems) {
      try {
        let buffer;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            // Step 1: get download URL + size
            const infoResp = await fetch(`${this.apiBase}/${encodeURIComponent(item.mediaId)}`, {
              headers: { Authorization: `Bearer ${this.accessToken}` },
              signal: AbortSignal.timeout(15_000),
            });
            if (!infoResp.ok) {
              console.warn(`[whatsapp] getMedia attempt ${attempt}/3 failed: ${item.mediaId} HTTP ${infoResp.status}`);
              if (attempt < 3) { await new Promise(r => setTimeout(r, 2000)); continue; }
              break;
            }
            const info = await infoResp.json();
            if (!info.url) {
              console.error('[whatsapp] getMedia bad response: no url');
              break; // not retriable
            }
            if (info.file_size && info.file_size > WHATSAPP_MAX_DOWNLOAD_BYTES) {
              console.warn(`[whatsapp] Skipping ${item.originalName}: ${info.file_size} bytes exceeds limit`);
              break; // not retriable
            }

            // Step 2: download bytes
            const resp = await fetch(info.url, {
              headers: { Authorization: `Bearer ${this.accessToken}` },
              signal: AbortSignal.timeout(60_000),
            });
            if (!resp.ok) {
              console.warn(`[whatsapp] Download attempt ${attempt}/3 failed: ${item.mediaId} HTTP ${resp.status}`);
              if (attempt < 3) { await new Promise(r => setTimeout(r, 2000)); continue; }
              break;
            }
            buffer = Buffer.from(await resp.arrayBuffer());
            break;
          } catch (fetchErr) {
            console.warn(`[whatsapp] Download attempt ${attempt}/3 failed: ${item.mediaId} ${fetchErr.message}`);
            if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
          }
        }
        if (!buffer) {
          console.error('[whatsapp] Failed to download media after 3 attempts:', item.mediaId);
          continue;
        }

        // Build filename: username_timestamp_originalname
        const safeName = item.originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
        const filename = `${username}_${Date.now()}_${safeName}`;
        const filePath = path.join(inboxDir, filename);
        fs.writeFileSync(filePath, buffer);

        const relativePath = `data/inbox/${filename}`;
        saved.push({ type: item.type, path: relativePath });
        console.log('[whatsapp] Downloaded media:', item.type, relativePath, buffer.length, 'bytes');
      } catch (err) {
        console.error('[whatsapp] Media download error:', item.mediaId, err.message);
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
