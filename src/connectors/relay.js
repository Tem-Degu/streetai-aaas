import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import { BaseConnector } from './index.js';
import { extractFiles, readFileBuffer } from './media.js';
import { loadConnection } from '../auth/connections.js';
import { writePlatformSkill } from '../utils/workspace.js';

const RELAY_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024; // Match the relay upload cap

// Derive HTTPS base URL from the relay WebSocket URL (wss://host → https://host)
function relayHttpBase(relayUrl) {
  return relayUrl.replace(/^ws/, 'http').replace(/\/$/, '');
}

/**
 * Relay connector — connects to streetai.org relay server via WebSocket.
 * Receives forwarded WhatsApp webhooks and HTTP chat requests.
 * The agent never needs a public IP.
 */
export default class RelayConnector extends BaseConnector {
  constructor(config, engine) {
    super(config, engine);
    this.relayUrl = config.relayUrl || 'wss://streetai.org';
    this.relayKey = config.relayKey;
    this.slug = config.slug;
    this.ws = null;
    this.pingInterval = null;
    this.reconnectAttempts = 0;
    this.reconnecting = false;

    // Load WhatsApp credentials if available (for sending replies directly to Meta)
    this.whatsappConfig = null;
    if (engine?.workspace) {
      const waConn = loadConnection(engine.workspace, 'whatsapp');
      if (waConn) {
        this.whatsappConfig = {
          accessToken: waConn.accessToken,
          phoneNumberId: waConn.phoneNumberId,
          apiBase: 'https://graph.facebook.com/v21.0',
        };
      }
    }
  }

  get platformName() { return 'relay'; }

  async connect() {
    this.status = 'connecting';
    this._writeSkill();
    await this._connectWebSocket();
  }

  _writeSkill() {
    const httpBase = relayHttpBase(this.relayUrl);
    const content = `---
name: relay
description: Sending files to users through the streetai.org chat widget (relay connector)
---

# Relay Connector — Sending Files to the Chat Widget

When a user chats with you through the streetai.org chat widget, your replies travel
back through the relay server. Plain text and markdown work out of the box.

## How to send a file

To share an image, audio, video, or document with the user, simply embed it in your
reply using **standard markdown with a workspace-relative path**:

- Image: \`![Signature Haircut](data/photos/haircut.png)\`
- Audio: \`[relaxing-mix.mp3](data/audio/relaxing-mix.mp3)\`
- Video: \`[demo.mp4](data/video/demo.mp4)\`
- Document: \`[menu.pdf](data/files/menu.pdf)\`

The connector automatically picks up these references, uploads the files to the relay
server, and delivers them to the user's browser. You do not need to upload anything
manually — just use the correct path and the system handles the rest.

## Rules

- **Use workspace-relative paths only** — paths like \`data/photos/foo.png\` or
  \`data/inbox/bar.jpg\`. These are files inside your workspace.
- **NEVER use \`/api/workspace/...\` paths.** That format only works in the dashboard
  and will NOT be delivered to the user. Always drop the \`/api/workspace/\` prefix.
- You may embed multiple files in one reply.
- Max file size is 20 MB.
- The file must exist on disk. If you reference a file that doesn't exist, it will
  be silently skipped and the user won't receive it.

## Examples

Good:
\`\`\`
Here's our Signature Haircut service:
![Signature Haircut](data/photos/signature-haircut.png)

Price: 180 AED | Duration: 60 minutes
\`\`\`

Bad (will NOT work):
\`\`\`
![Signature Haircut](/api/workspace/data/photos/signature-haircut.png)
\`\`\`
`;
    writePlatformSkill(this.engine?.workspace, 'http', content);
  }

  async _connectWebSocket() {
    const wsUrl = `${this.relayUrl}/relay?key=${this.relayKey}`;
    console.log('[relay] Connecting to', this.relayUrl);

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      const timeout = setTimeout(() => {
        if (this.ws?.readyState !== WebSocket.OPEN) {
          this.ws?.close();
          reject(new Error('Relay connection timeout'));
        }
      }, 15_000);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        console.log('[relay] Connected to relay server');
        this.reconnectAttempts = 0;
        this.error = null;
        this.status = 'connected';

        // Keepalive ping every 30s
        this.pingInterval = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, 30_000);

        resolve();
      });

      this.ws.on('message', (raw) => {
        try {
          const data = JSON.parse(raw.toString());
          this._handleMessage(data);
        } catch { /* ignore malformed */ }
      });

      this.ws.on('close', (code) => {
        clearTimeout(timeout);
        this._clearPing();
        if (this.status !== 'disconnected') {
          console.log('[relay] WebSocket closed, code:', code);
          this._handleReconnect();
        }
      });

      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        console.log('[relay] WebSocket error:', err.message);
        if (this.status === 'connecting') reject(err);
      });
    });
  }

  async _handleMessage(data) {
    if (data.type === 'welcome') {
      console.log(`[relay] Registered as: ${data.slug} (${data.agent})`);
      return;
    }

    if (data.type === 'pong') return;

    if (data.type === 'whatsapp:webhook') {
      await this._handleWhatsAppWebhook(data);
      return;
    }

    if (data.type === 'http:chat') {
      await this._handleHttpChat(data);
      return;
    }
  }

  // ─── WhatsApp webhook handling ───────────────────────────────

  async _handleWhatsAppWebhook(data) {
    const body = data.payload;
    if (!body || body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;
        const value = change.value;
        if (!value?.messages) continue;

        for (const message of value.messages) {
          if (message.type !== 'text') continue;

          const contact = value.contacts?.find(c => c.wa_id === message.from);

          try {
            const result = await this.engine.processEvent({
              platform: 'whatsapp',
              userId: message.from,
              userName: contact?.profile?.name || message.from,
              type: 'message',
              content: message.text.body,
              metadata: {
                phoneNumber: message.from,
                messageId: message.id,
                timestamp: message.timestamp,
                viaRelay: true,
              },
            });

            if (result.response) {
              await this._sendWhatsAppReply(message.from, result.response, result);
            }
          } catch (err) {
            console.error('[relay] WhatsApp processing error:', err.message);
          }
        }
      }
    }
  }

  async _sendWhatsAppReply(phoneNumber, response, result) {
    if (!this.whatsappConfig) {
      console.error('[relay] No WhatsApp credentials — cannot send reply');
      return;
    }

    const { accessToken, phoneNumberId, apiBase } = this.whatsappConfig;

    // Extract and send files
    const workspace = this.engine?.workspace;
    let text = response;
    let files = [];
    if (workspace) {
      const extracted = extractFiles(workspace, response);
      text = extracted.cleanText;
      files = extracted.files;
    }

    for (const file of files) {
      try {
        const buffer = await readFileBuffer(file);
        const blob = new Blob([buffer], { type: file.mimeType });
        const uploadForm = new FormData();
        uploadForm.append('file', blob, file.filename);
        uploadForm.append('messaging_product', 'whatsapp');
        uploadForm.append('type', file.mimeType);

        const uploadResp = await fetch(`${apiBase}/${phoneNumberId}/media`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}` },
          body: uploadForm,
        });
        if (!uploadResp.ok) continue;

        const { id: mediaId } = await uploadResp.json();
        const mediaType = file.type === 'image' ? 'image'
          : file.type === 'audio' ? 'audio'
          : file.type === 'video' ? 'video'
          : 'document';

        const mediaBody = { id: mediaId };
        if (file.alt && mediaType !== 'audio') mediaBody.caption = file.alt;
        if (mediaType === 'document') mediaBody.filename = file.filename;

        await fetch(`${apiBase}/${phoneNumberId}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messaging_product: 'whatsapp', to: phoneNumber,
            type: mediaType, [mediaType]: mediaBody,
          }),
        });
      } catch (err) {
        console.error(`[relay] WhatsApp file send error:`, err.message);
      }
    }

    // Send text
    if (text) {
      const chunks = this._splitMessage(text, 4096);
      for (const chunk of chunks) {
        await fetch(`${apiBase}/${phoneNumberId}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messaging_product: 'whatsapp', to: phoneNumber,
            type: 'text', text: { body: chunk },
          }),
        });
      }
    }
  }

  // ─── HTTP chat handling ──────────────────────────────────────

  async _handleHttpChat(data) {
    const { message, userId, userName, attachments } = data.payload;

    // Download any inbound attachments to data/inbox/ before dispatching.
    // Falls through harmlessly when streetai.org doesn't include this field (old server).
    let content = message || '';
    if (Array.isArray(attachments) && attachments.length > 0) {
      const safeUser = String(userId || 'anonymous').replace(/[^a-zA-Z0-9._-]/g, '_');
      const savedFiles = await this._downloadAttachments(attachments, safeUser);
      if (savedFiles.length > 0) {
        const fileList = savedFiles.map(f => `${f.type}: ${f.path}`).join(', ');
        content = content
          ? `${content}\n\n[Attached files: ${fileList}]`
          : `[Attached files: ${fileList}]`;
      }
    }

    if (!content) {
      this._respond(data.requestId, { response: '' });
      return;
    }

    try {
      const result = await this.engine.processEvent({
        platform: 'http',
        userId: userId || 'anonymous',
        userName: userName || 'Visitor',
        type: 'message',
        content,
        metadata: { mode: 'customer', viaRelay: true },
      });

      // Extract files from response
      const workspace = this.engine?.workspace;
      let responseText = result.response;
      let files = [];
      if (workspace && responseText) {
        const extracted = extractFiles(workspace, responseText);
        responseText = extracted.cleanText;

        // Upload local files to the relay so the widget can fetch them
        files = await Promise.all(extracted.files.map(async (f) => {
          let url = f.url || null;
          if (!url && f.absPath) {
            try {
              url = await this._uploadFile(f);
            } catch (err) {
              console.error('[relay] File upload failed:', f.filename, err.message);
            }
          }
          return {
            filename: f.filename,
            type: f.type,
            mimeType: f.mimeType,
            url,
          };
        }));
        // Drop files that failed to upload
        files = files.filter(f => f.url);
      }

      // Send response back to relay server
      this._respond(data.requestId, {
        response: responseText,
        files: files.length > 0 ? files : undefined,
        toolsUsed: result.toolsUsed,
        tokensUsed: result.tokensUsed,
      });
    } catch (err) {
      console.error('[relay] HTTP chat error:', err.message);
      this._respond(data.requestId, {
        response: 'Sorry, something went wrong. Please try again.',
      });
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────

  _typeFromMime(mime) {
    if (!mime) return 'file';
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime.startsWith('video/')) return 'video';
    return 'file';
  }

  /**
   * Download relay-hosted attachments into the workspace inbox.
   * Mirrors truuze.js _downloadMedia: writes to data/inbox/<user>_<ts>_<safeName>
   * and returns [{type, path}] with workspace-relative paths.
   *
   * The widget uploads files to streetai.org/a/<slug>/upload first; the relay
   * server then forwards public URLs in the chat payload as `attachments`.
   * Each item shape: {url, filename, mimeType, size}.
   */
  async _downloadAttachments(attachments, username) {
    const workspace = this.engine?.workspace;
    if (!workspace) return [];

    const inboxDir = path.join(workspace, 'data', 'inbox');
    fs.mkdirSync(inboxDir, { recursive: true });

    const saved = [];
    for (const att of attachments) {
      try {
        if (!att?.url) continue;
        if (att.size && att.size > RELAY_MAX_DOWNLOAD_BYTES) {
          console.warn(`[relay] Skipping ${att.filename}: ${att.size} bytes exceeds limit`);
          continue;
        }

        const resp = await fetch(att.url, { signal: AbortSignal.timeout(60_000) });
        if (!resp.ok) {
          console.error('[relay] Failed to download attachment:', att.url, resp.status);
          continue;
        }
        const buffer = Buffer.from(await resp.arrayBuffer());

        const type = this._typeFromMime(att.mimeType);
        const originalName = att.filename || `file_${Date.now()}`;
        const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
        const filename = `${username}_${Date.now()}_${safeName}`;
        const filePath = path.join(inboxDir, filename);
        fs.writeFileSync(filePath, buffer);

        const relativePath = `data/inbox/${filename}`;
        saved.push({ type, path: relativePath });
        console.log('[relay] Downloaded attachment:', type, relativePath, buffer.length, 'bytes');
      } catch (err) {
        console.error('[relay] Attachment download error:', err.message);
      }
    }
    return saved;
  }

  async _uploadFile(file) {
    const buffer = await readFileBuffer(file);
    const url = relayHttpBase(this.relayUrl) + '/u/upload';
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.relayKey}`,
        'Content-Type': file.mimeType || 'application/octet-stream',
        'X-Filename': encodeURIComponent(file.filename || 'file'),
      },
      body: buffer,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Upload failed (${resp.status}): ${text}`);
    }
    const data = await resp.json();
    return data.url;
  }

  _respond(requestId, payload) {
    if (!requestId || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'response', requestId, payload }));
  }

  _clearPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  _handleReconnect() {
    if (this.status === 'disconnected' || this.reconnecting) return;
    if (this.reconnectAttempts >= 10) {
      this.status = 'error';
      this.error = 'Relay connection lost after 10 attempts';
      return;
    }

    this.reconnecting = true;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 60_000);
    this.reconnectAttempts++;
    this.status = 'reconnecting';

    console.log(`[relay] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts})`);

    setTimeout(async () => {
      this.reconnecting = false;
      if (this.status === 'disconnected') return;
      try {
        await this._connectWebSocket();
      } catch (err) {
        console.log('[relay] Reconnect failed:', err.message);
        this._handleReconnect();
      }
    }, delay);
  }

  async send() {
    // Relay connector handles sending in _handleWhatsAppWebhook and _handleHttpChat
    // This is a no-op since the base handleEvent() is not used
  }

  async disconnect() {
    this.reconnecting = false;
    this._clearPing();
    if (this.ws) {
      this.ws.close(1000);
      this.ws = null;
    }
    await super.disconnect();
  }

  getStatus() {
    return {
      ...super.getStatus(),
      slug: this.slug,
      relayUrl: this.relayUrl,
      reconnectAttempts: this.reconnectAttempts,
      whatsapp: !!this.whatsappConfig,
    };
  }

  _splitMessage(text, maxLen) {
    if (text.length <= maxLen) return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) { chunks.push(remaining); break; }
      let splitAt = remaining.lastIndexOf('\n', maxLen);
      if (splitAt < maxLen * 0.3) splitAt = maxLen;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }
    return chunks;
  }
}
