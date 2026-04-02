import { BaseConnector } from './index.js';

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
          console.error(`[telegram] Poll error: ${resp.status}`);
          await this._sleep(5000);
          continue;
        }

        const data = await resp.json();
        if (!data.ok || !data.result?.length) continue;

        for (const update of data.result) {
          this.offset = update.update_id + 1;

          if (update.message?.text) {
            const msg = update.message;
            try {
              await this.handleEvent({
                platform: 'telegram',
                userId: String(msg.from.id),
                userName: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || msg.from.username || 'User',
                type: 'message',
                content: msg.text,
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
        }
      } catch (err) {
        if (err.name === 'AbortError') break;
        console.error(`[telegram] Poll error:`, err.message);
        await this._sleep(5000);
      }
    }
  }

  async send(event, response) {
    const chatId = event.metadata?.chatId;
    if (!chatId) return;

    // Telegram has a 4096 character limit per message
    const chunks = this._splitMessage(response, 4096);
    for (const chunk of chunks) {
      await fetch(`${this.apiBase}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          parse_mode: 'Markdown',
        }),
      });
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

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
