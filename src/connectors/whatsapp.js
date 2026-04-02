import express from 'express';
import { createServer } from 'http';
import { BaseConnector } from './index.js';

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
            if (message.type !== 'text') continue;

            const contact = value.contacts?.find(c => c.wa_id === message.from);

            this.handleEvent({
              platform: 'whatsapp',
              userId: message.from,
              userName: contact?.profile?.name || message.from,
              type: 'message',
              content: message.text.body,
              metadata: {
                phoneNumber: message.from,
                messageId: message.id,
                timestamp: message.timestamp,
              },
            }).catch(err => {
              console.error('[whatsapp] Error processing message:', err.message);
            });
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

  async send(event, response) {
    const phoneNumber = event.metadata?.phoneNumber;
    if (!phoneNumber) return;

    // WhatsApp has a ~4096 character limit
    const chunks = this._splitMessage(response, 4096);
    for (const chunk of chunks) {
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

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        console.error('[whatsapp] Send failed:', err.error?.message || resp.status);
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
