import fs from 'fs';
import path from 'path';
import { readJson, writeJson } from '../utils/workspace.js';
import { loadConnection, saveConnection } from '../auth/connections.js';
import { newAlertId, saveAlert, defaultTtlMs } from './alerts.js';
import { renderTransactionCard } from './transaction-card.js';

/**
 * Owner notifications. The agent calls notifyOwner({...}) when something
 * needs the operator's attention. The orchestrator fans the message out to
 * every enabled channel: Telegram, WhatsApp, Email.
 *
 * Config shape (`.aaas/notifications.json`):
 *
 *   {
 *     telegram: { enabled: true, chat_id: "12345678" },
 *     whatsapp: { enabled: false, phone: "+1234567890" },
 *     email: {
 *       enabled: true,
 *       to: "you@example.com",
 *       from: "agent@example.com",
 *       smtp: { host, port, secure, user, pass }
 *     }
 *   }
 *
 * Strings may include {{ENV_VAR}} substitution.
 */

const SECRET_FIELDS = new Set(['pass', 'access_token']);

export function loadNotificationsConfig(paths) {
  return readJson(paths.notifications) || { telegram: {}, whatsapp: {}, email: {} };
}

export function saveNotificationsConfig(paths, config) {
  fs.mkdirSync(path.dirname(paths.notifications), { recursive: true });
  writeJson(paths.notifications, config || {});
}

/**
 * Return a copy of the config with secrets masked. For surfacing to the UI
 * without leaking the actual SMTP password (or {{ENV_VAR}} placeholder).
 */
export function maskNotificationsConfig(config) {
  const out = JSON.parse(JSON.stringify(config || {}));
  if (out.email?.smtp?.pass) {
    const v = out.email.smtp.pass;
    out.email.smtp.pass = v.startsWith('{{') ? v : '••••••••';
    out.email.smtp.passSet = true;
  }
  return out;
}

function substitute(value) {
  if (typeof value === 'string') {
    return value.replace(/\{\{(\w+)\}\}/g, (m, name) => {
      const v = process.env[name];
      if (v === undefined) throw new Error(`environment variable not set: ${name}`);
      return v;
    });
  }
  if (Array.isArray(value)) return value.map(substitute);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = substitute(v);
    return out;
  }
  return value;
}

function buildText({ title, message, severity }) {
  const sev = severity ? `[${severity.toUpperCase()}] ` : '';
  if (title && message) return `${sev}${title}\n\n${message}`;
  return `${sev}${title || message || ''}`.trim();
}

// ─── Notification routes ────────────────────────────────────────
//
// A "route" is an optional, named bundle of destinations that OVERRIDES the
// default channels for a single notification — e.g. one route per branch or
// team. Config shape (`.aaas/notifications.json`):
//
//   routes: {
//     seef:    { telegram: "-100aaa" },
//     juffair: { telegram: ["-100bbb", "-100ccc"], email: "juffair@x" }
//   }
//
// Each channel value may be a single id/address, a comma-separated string, or
// an array (fan-out). A route is generic: any agent can define routes and steer
// a notification to one. No route (or an unknown name) → the default channels,
// exactly as before. This is fully additive — absent `routes` changes nothing.

// Split a route channel value (string, comma-list, or array) into a clean list.
export function asList(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean);
  return String(v).split(',').map(s => s.trim()).filter(Boolean);
}

// Resolve a route NAME against config.routes into explicit per-channel targets,
// or null when no route applies (→ caller falls back to default channels).
export function resolveRoute(config, routeName) {
  const name = routeName == null ? '' : String(routeName).trim();
  if (!name) return null;
  const entry = config?.routes?.[name];
  if (!entry || typeof entry !== 'object') return null;
  return {
    name,
    telegram: asList(entry.telegram),
    whatsapp: asList(entry.whatsapp),
    email: asList(entry.email),
  };
}

// Determine the route name for a transaction: an explicit `notify_route` the
// agent set wins; otherwise, when the workspace names a `route_field` (e.g.
// "branch"), use that column's value off the transaction row. This lets an
// agent derive routing deterministically from data it already records, with no
// extra value to pass or remember.
export function routeNameForTxn(config, txn) {
  if (txn && txn.notify_route != null && String(txn.notify_route).trim() !== '') {
    return String(txn.notify_route);
  }
  const field = config?.route_field;
  if (field && txn && txn[field] != null && String(txn[field]).trim() !== '') {
    return String(txn[field]);
  }
  return null;
}

// ─── Senders ───────────────────────────────────────────────────

/**
 * Resolve a Telegram target (whatever the owner typed) to a numeric chat
 * ID. Telegram's sendMessage cannot send to a `@username` for private
 * user chats — only for public channels/groups — so usernames have to be
 * resolved to numeric IDs before the API call.
 *
 * Resolution order:
 *   1. Numeric input (e.g. "12345678") → use as-is.
 *   2. Username + entry in conn.userMap (recorded by the connector when
 *      the user messages the bot) → use the cached chat ID.
 *   3. Username + conn.ownerId set (owner already did /admin) → call
 *      Telegram's getChat(ownerId) and confirm the username matches.
 *      Cache the result for future calls.
 *   4. Otherwise → clear, actionable error.
 *
 * Mutates `conn.userMap` (and saves it) when step 3 succeeds.
 */
async function resolveTelegramTarget(workspace, conn, raw) {
  const v = String(raw || '').trim();
  if (!v) return { ok: false, error: 'Telegram target (username or chat ID) is not set.' };

  // Step 1: numeric → done.
  if (/^-?\d+$/.test(v)) return { ok: true, target: v };

  // Step 2: cached username → done.
  const username = v.replace(/^@+/, '');
  const lower = username.toLowerCase();
  const cached = conn?.userMap?.[lower];
  if (cached) return { ok: true, target: String(cached), username };

  // Step 3: getChat fallback when ownerId is known.
  if (conn?.ownerId && conn.botToken) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${conn.botToken}/getChat?chat_id=${encodeURIComponent(conn.ownerId)}`);
      const j = await r.json().catch(() => ({}));
      if (j.ok && j.result?.username && String(j.result.username).toLowerCase() === lower) {
        const id = String(conn.ownerId);
        try {
          const updated = {
            ...conn,
            userMap: { ...(conn.userMap || {}), [lower]: id },
          };
          saveConnection(workspace, 'telegram', updated);
        } catch { /* best-effort cache */ }
        return { ok: true, target: id, username, resolved_via: 'getChat' };
      }
    } catch { /* fall through to final error */ }
  }

  return {
    ok: false,
    error: `I don't know the chat ID for @${username} yet. Telegram requires the bot to receive a message from a user before it can send to them — the @username form only works for public channels, not private chats. Have @${username} DM your bot once, then try again. (After their first message, AaaS captures their chat ID automatically and the username will keep working.)`,
  };
}

async function sendTelegram(workspace, ownerCfg, payload) {
  const conn = loadConnection(workspace, 'telegram');
  if (!conn?.botToken) {
    throw new Error('Telegram bot is not connected. Connect a Telegram bot in the Deploy tab first.');
  }

  const resolved = await resolveTelegramTarget(workspace, conn, ownerCfg?.chat_id);
  if (!resolved.ok) throw new Error(resolved.error);
  const target = resolved.target;

  const url = `https://api.telegram.org/bot${conn.botToken}/sendMessage`;
  // payload.text overrides the default; payload.parse_mode and payload.buttons
  // (inline keyboard) are optional — used by transaction cards.
  const msgBody = { chat_id: target, text: payload.text || buildText(payload) };
  if (payload.parse_mode) msgBody.parse_mode = payload.parse_mode;
  if (Array.isArray(payload.buttons) && payload.buttons.length) {
    // Telegram inline keyboards allow mixing callback buttons (Complete/Cancel)
    // and URL buttons (Message Customer) — a button with a `url` opens the link
    // directly on tap. Keep action buttons on the first row and any link button
    // on its own row below.
    const actionRow = payload.buttons.filter(b => !b.url).map(b => ({ text: b.title, callback_data: b.id }));
    const linkRow = payload.buttons.filter(b => b.url).map(b => ({ text: b.title, url: b.url }));
    const rows = [];
    if (linkRow.length) rows.push(linkRow);     // Message Customer on top
    if (actionRow.length) rows.push(actionRow); // Complete / Cancel below
    msgBody.reply_markup = { inline_keyboard: rows };
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(msgBody),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    throw new Error(`Telegram API ${res.status}: ${body.description || 'unknown error'}`);
  }
  // Always prefer the actual numeric chat.id from the response — that's
  // the value incoming messages will carry, used for owner-reply routing.
  const numericChatId = body.result?.chat?.id ? String(body.result.chat.id) : target;
  const messageId = body.result?.message_id ? String(body.result.message_id) : null;

  // Auto-verify: link the numeric chat ID as the owner if not already set.
  try {
    if (!conn.ownerId) {
      const updated = { ...loadConnection(workspace, 'telegram'), ownerId: numericChatId };
      saveConnection(workspace, 'telegram', updated);
    }
  } catch { /* best-effort */ }
  // Auto-cache the username mapping if we resolved via getChat (or even
  // if the owner typed a username that was already in the cache — keeps
  // the cache fresh).
  try {
    if (resolved.username) {
      const fresh = loadConnection(workspace, 'telegram') || conn;
      const userMap = { ...(fresh.userMap || {}), [resolved.username.toLowerCase()]: numericChatId };
      saveConnection(workspace, 'telegram', { ...fresh, userMap });
    }
  } catch { /* best-effort */ }

  return {
    channel: 'telegram',
    ok: true,
    channel_message_id: messageId,
    sent_to: numericChatId,
  };
}

async function sendWhatsapp(workspace, ownerCfg, payload) {
  if (!ownerCfg?.phone) {
    throw new Error('WhatsApp phone number is not set.');
  }
  const conn = loadConnection(workspace, 'whatsapp');
  if (!conn?.accessToken || !conn?.phoneNumberId) {
    throw new Error('WhatsApp is not connected. Connect WhatsApp in the Deploy tab first.');
  }
  const accessToken = substitute(conn.accessToken);
  const url = `https://graph.facebook.com/v21.0/${conn.phoneNumberId}/messages`;
  const phone = String(ownerCfg.phone).replace(/[^\d+]/g, '');
  const text = payload.text || buildText(payload);
  // With buttons → interactive reply-button message (one tap, no confirm).
  // Up to 3 buttons; titles capped at 20 chars per WhatsApp limits.
  let messageBody;
  if (Array.isArray(payload.buttons) && payload.buttons.length) {
    messageBody = {
      messaging_product: 'whatsapp',
      to: phone,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text },
        action: {
          buttons: payload.buttons.slice(0, 3).map(b => ({
            type: 'reply',
            reply: { id: b.id, title: b.title.slice(0, 20) },
          })),
        },
      },
    };
  } else {
    messageBody = { messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: text } };
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify(messageBody),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    throw new Error(`WhatsApp API ${res.status}: ${body.error?.message || 'unknown error'}. Note: WhatsApp only allows free-form messages within 24h of the recipient's last message — for older windows you need a pre-approved template.`);
  }
  // Auto-verify: link the configured WhatsApp phone as owner if not set.
  // For WhatsApp, ownerId is the phone number (digits only, no '+').
  try {
    if (!conn.ownerId) {
      const ownerPhone = phone.replace(/[^\d]/g, '');
      const updated = { ...conn, ownerId: ownerPhone };
      saveConnection(workspace, 'whatsapp', updated);
    }
  } catch { /* best-effort */ }
  return {
    channel: 'whatsapp',
    ok: true,
    channel_message_id: body.messages?.[0]?.id || null,
    sent_to: phone,
  };
}

async function sendEmail(ownerCfg, payload) {
  if (!ownerCfg?.to) {
    throw new Error('Email recipient is not set.');
  }
  const smtp = ownerCfg.smtp || {};
  if (!smtp.host || !smtp.user || !smtp.pass) {
    throw new Error('SMTP host, user, and pass are required.');
  }
  // nodemailer is loaded lazily so the dependency is only required when
  // email notifications are actually used.
  let nodemailer;
  try {
    nodemailer = (await import('nodemailer')).default;
  } catch {
    throw new Error('nodemailer is not installed. Run: npm install nodemailer');
  }
  const transport = nodemailer.createTransport({
    host: substitute(smtp.host),
    port: Number(smtp.port) || 587,
    secure: smtp.secure === true || Number(smtp.port) === 465,
    auth: {
      user: substitute(smtp.user),
      pass: substitute(smtp.pass),
    },
  });
  const info = await transport.sendMail({
    from: substitute(ownerCfg.from || ownerCfg.to),
    to: substitute(ownerCfg.to),
    subject: payload.title || 'Agent notification',
    text: buildText(payload),
  });
  return {
    channel: 'email',
    ok: true,
    channel_message_id: info?.messageId || null,
    sent_to: substitute(ownerCfg.to),
  };
}

// ─── Orchestrator ───────────────────────────────────────────────

/**
 * Send a notification to all enabled channels. Failures on one channel do
 * not block the others. Returns { alert_id, sent: [...], failed: [...] }.
 *
 * `context` (optional) records what conversation triggered this alert so
 * an owner reply can be routed back to the right customer session:
 *   { session_platform, session_user_id, session_user_name, transaction_id }
 */
export async function notifyOwner(workspace, paths, payload, context) {
  const config = loadNotificationsConfig(paths);
  const text = buildText(payload);
  if (!text) return { sent: [], failed: [{ channel: 'all', error: 'Empty notification.' }] };

  // Optional route override: the agent may direct this alert to a named route
  // (payload.notify_route) or it may ride on the triggering context. No route →
  // the default channels, unchanged.
  const route = resolveRoute(config, payload?.notify_route || context?.notify_route);

  const tasks = [];
  if (route) {
    if (config.telegram?.enabled) for (const chat_id of route.telegram) tasks.push(sendTelegram(workspace, { chat_id }, payload));
    if (config.whatsapp?.enabled) for (const phone of route.whatsapp) tasks.push(sendWhatsapp(workspace, { phone }, payload));
    if (config.email?.enabled) for (const to of route.email) tasks.push(sendEmail({ ...config.email, to }, payload));
  } else {
    if (config.telegram?.enabled) tasks.push(sendTelegram(workspace, config.telegram, payload));
    if (config.whatsapp?.enabled) tasks.push(sendWhatsapp(workspace, config.whatsapp, payload));
    if (config.email?.enabled) tasks.push(sendEmail(config.email, payload));
  }

  if (tasks.length === 0) {
    return { sent: [], failed: [{ channel: 'none', error: 'No notification channels are enabled. Configure them in the dashboard Notifications tab.' }] };
  }

  const results = await Promise.allSettled(tasks);
  const sent = [], failed = [];
  for (const r of results) {
    if (r.status === 'fulfilled') sent.push(r.value);
    else failed.push({ channel: r.reason?.channel || 'unknown', error: r.reason?.message || String(r.reason) });
  }

  // Save a ledger entry so an owner reply on Telegram/WhatsApp can be routed
  // back to this conversation. Skip the ledger only when literally nothing
  // was sent — without channel_message_ids, there's nothing to match against.
  let alert_id = null;
  if (sent.length > 0) {
    alert_id = newAlertId();
    const now = new Date();
    saveAlert(paths, {
      alert_id,
      sent_at: now.toISOString(),
      expires_at: new Date(now.getTime() + defaultTtlMs()).toISOString(),
      status: 'pending',
      title: payload.title || '',
      message: payload.message || '',
      severity: payload.severity || 'info',
      channels: sent,
      failed,
      context: context || null,
      responses: [],
    });
  }

  return { alert_id, sent, failed };
}

/**
 * Send a single test message on one specific channel. Used by the dashboard
 * Test button so the operator gets instant feedback that their config works.
 */
export async function testChannel(workspace, paths, channel, payload) {
  const config = loadNotificationsConfig(paths);
  const ownerCfg = config[channel];
  if (!ownerCfg) throw new Error(`No config for channel "${channel}".`);
  const msg = payload || {
    title: 'Test from your agent',
    message: 'If you received this, owner notifications are working. Reply to keep the channel alive.',
  };
  if (channel === 'telegram') return await sendTelegram(workspace, ownerCfg, msg);
  if (channel === 'whatsapp') return await sendWhatsapp(workspace, ownerCfg, msg);
  if (channel === 'email') return await sendEmail(ownerCfg, msg);
  throw new Error(`Unknown channel "${channel}".`);
}

/**
 * Send a test message to every target defined on a named route, across all the
 * channels that route specifies. Lets the operator verify each route's chat IDs
 * / numbers / emails at setup — routing failures are otherwise silent. Sends
 * regardless of a channel's global on/off flag (the point is to prove the
 * destination is reachable), but still needs the channel's connection/SMTP.
 * Returns { ok, sent, failed } so the caller can report which targets worked.
 */
export async function testRoute(workspace, paths, routeName, payload) {
  const config = loadNotificationsConfig(paths);
  const route = resolveRoute(config, routeName);
  if (!route) throw new Error(`No route named "${routeName}". Save the route first, then test it.`);
  const msg = payload || {
    title: `Test · route "${route.name}"`,
    message: `If you received this, the "${route.name}" route is wired correctly.`,
  };

  const tasks = [];
  for (const chat_id of route.telegram) tasks.push(sendTelegram(workspace, { chat_id }, msg).then(r => ({ ...r, target: chat_id })));
  for (const phone of route.whatsapp) tasks.push(sendWhatsapp(workspace, { phone }, msg).then(r => ({ ...r, target: phone })));
  for (const to of route.email) tasks.push(sendEmail({ ...config.email, to }, msg).then(r => ({ ...r, target: to })));
  if (tasks.length === 0) throw new Error(`Route "${route.name}" has no destinations. Add a Telegram ID, WhatsApp number, or email.`);

  const results = await Promise.allSettled(tasks);
  const sent = [], failed = [];
  for (const r of results) {
    if (r.status === 'fulfilled') sent.push(r.value);
    else failed.push({ channel: r.reason?.channel || 'unknown', error: r.reason?.message || String(r.reason) });
  }
  return { ok: failed.length === 0, sent, failed };
}

// ─── Transaction alerts ─────────────────────────────────────────
//
// Pushes a per-transaction card to the owner's enabled channels when
// `transaction_alerts.enabled` is set. Opt-in, off by default. Reuses the same
// recipients (telegram.chat_id / whatsapp.phone) and senders as owner alerts.
// WhatsApp sends that fail (e.g. closed 24h window) are queued and replayed on
// the owner's next inbound message — see flushPendingWhatsApp.

/**
 * Build a deep link that opens the customer's chat thread for the owner to
 * message them directly (human-to-human, outside the agent). Returns
 * { url, label } or null when the customer has no reachable handle.
 *
 *  - WhatsApp customer → https://wa.me/<digits> (user_id is the phone number).
 *  - Telegram customer → https://t.me/<username>, but only if the customer has
 *    a public username (reverse-looked-up from the connection's userMap).
 *    Telegram blocks opening a fresh DM by numeric id, so no username → no link.
 *  - Truuze / website / anonymous → no external thread → null.
 *
 * Note: the link opens the owner's OWN WhatsApp/Telegram, so the message
 * reaches the customer from the owner's personal account, not the business.
 */
export function buildCustomerLink(workspace, txn) {
  const platform = txn?.session_platform;
  const uid = txn?.user_id != null ? String(txn.user_id) : '';
  if (!platform || !uid) return null;

  if (platform === 'whatsapp') {
    const digits = uid.replace(/[^\d]/g, '');
    return digits ? { url: `https://wa.me/${digits}`, label: '💬 Message Customer' } : null;
  }

  if (platform === 'telegram') {
    try {
      const conn = loadConnection(workspace, 'telegram');
      const map = conn?.userMap || {};
      for (const [uname, chatId] of Object.entries(map)) {
        if (String(chatId) === uid) return { url: `https://t.me/${uname}`, label: '💬 Message Customer' };
      }
    } catch { /* no connection / no map → no link */ }
    return null; // no username on file → can't deep-link
  }

  return null; // other platforms have no external chat thread
}

/**
 * True if `userId` on `platform` is authorized to act on transaction-card
 * buttons (Complete / Cancel). The single source of truth is the Notifications
 * tab: whoever is configured to RECEIVE transaction cards on that channel may
 * act on them. Change the recipient there and the tap permission moves with it —
 * no separate, drift-prone "owner" record.
 *
 *  - whatsapp → compares against `whatsapp.phone`, digit-normalized so
 *    "+971 50…" and "971…" match.
 *  - telegram → compares the numeric tapper id against `telegram.chat_id`
 *    (also tolerates an @username being configured).
 */
export function isTransactionActor(paths, platform, userId) {
  let config;
  try { config = loadNotificationsConfig(paths); } catch { return false; }

  if (platform === 'whatsapp') {
    const recipient = config?.whatsapp?.phone;
    if (!recipient) return false;
    const digits = s => String(s).replace(/\D/g, '');
    return digits(recipient) === digits(userId) && digits(userId) !== '';
  }

  if (platform === 'telegram') {
    const recipient = config?.telegram?.chat_id;
    if (!recipient) return false;
    const norm = s => String(s).replace(/^@+/, '').trim().toLowerCase();
    return norm(recipient) === norm(userId) && norm(userId) !== '';
  }

  return false;
}

function pendingWhatsAppPath(paths) {
  return path.join(path.dirname(paths.notifications), 'pending_whatsapp.json');
}

function enqueuePendingWhatsApp(paths, item) {
  try {
    const fp = pendingWhatsAppPath(paths);
    const list = readJson(fp) || [];
    list.push({ ...item, queued_at: new Date().toISOString() });
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    writeJson(fp, list.slice(-100)); // cap to avoid unbounded growth
  } catch { /* best-effort */ }
}

// ─── Telegram "one live card per transaction" ───────────────────
//
// We remember the message we sent for each transaction so a later change can
// delete the stale card and post a fresh one — keeping a single, current card
// (no lingering buttons on a cancelled order). Telegram-only: WhatsApp can't
// delete or edit sent messages.

function txnCardsPath(paths) {
  return path.join(path.dirname(paths.notifications), 'txn_cards.json');
}

function getCardRef(paths, txnId) {
  try {
    const map = readJson(txnCardsPath(paths)) || {};
    return map[String(txnId)] || null;
  } catch { return null; }
}

function setCardRef(paths, txnId, ref) {
  try {
    const fp = txnCardsPath(paths);
    const map = readJson(fp) || {};
    if (ref) map[String(txnId)] = ref; else delete map[String(txnId)];
    // Prune oldest entries so the file can't grow without bound. Numeric
    // transaction-id keys sort ascending, so the first keys are the oldest.
    const keys = Object.keys(map);
    if (keys.length > 500) {
      for (const k of keys.slice(0, keys.length - 500)) delete map[k];
    }
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    writeJson(fp, map);
  } catch { /* best-effort */ }
}

async function deleteTelegramMessage(workspace, chatId, messageId) {
  try {
    const conn = loadConnection(workspace, 'telegram');
    if (!conn?.botToken) return;
    await fetch(`https://api.telegram.org/bot${conn.botToken}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    });
  } catch { /* best-effort — Telegram won't delete messages older than ~48h */ }
}

/**
 * Send the owner a card for a transaction event ('created' | 'updated' |
 * 'cancelled' | 'completed'). Best-effort: never throws. No-op unless
 * `transaction_alerts.enabled`.
 */
export async function notifyTransaction(workspace, paths, txn, event) {
  let config;
  try { config = loadNotificationsConfig(paths); } catch { return; }
  if (!config?.transaction_alerts?.enabled) return;
  if (!txn) return;

  const viewConfig = (() => { try { return readJson(paths.transactionView) || {}; } catch { return {}; } })();
  const card = renderTransactionCard(txn, event, viewConfig);

  // A tap-to-open link to the customer's chat thread, when reachable. Omitted
  // once the transaction is terminal — no point messaging about a done/cancelled
  // order from the card. Telegram gets it as a URL button; WhatsApp (whose API
  // can't mix a URL button with the reply buttons) gets a tappable body line.
  const TERMINAL = new Set(['completed', 'cancelled']);
  const link = TERMINAL.has(txn.status) ? null : buildCustomerLink(workspace, txn);

  // Route override: when the transaction names a route (explicit `notify_route`
  // or the configured `route_field` column), send to that route's per-channel
  // targets instead of the defaults. No route → the default single destination
  // per channel, exactly as before.
  const route = resolveRoute(config, routeNameForTxn(config, txn));
  const tgTargets = route ? route.telegram : (config.telegram?.chat_id ? [config.telegram.chat_id] : []);
  const waTargets = route ? route.whatsapp : (config.whatsapp?.phone ? [config.whatsapp.phone] : []);
  const emTargets = route ? route.email : (config.email?.to ? [config.email.to] : []);

  if (config.telegram?.enabled && tgTargets.length) {
    try {
      // Replace this transaction's previous card(s) so only the current card
      // exists per target — the fresh one reflects the new state (and drops the
      // buttons once terminal). 'created' has no predecessor to remove. A route
      // may fan out to several chats, so refs are kept as a list.
      const prevRef = getCardRef(paths, txn.id)?.telegram;
      const prevList = Array.isArray(prevRef) ? prevRef : (prevRef ? [prevRef] : []);
      if (prevList.length && event !== 'created') {
        for (const p of prevList) await deleteTelegramMessage(workspace, p.chat_id, p.message_id);
      }
      const tgButtons = link
        ? [...card.buttons, { title: link.label, url: link.url }]
        : card.buttons;
      const newRefs = [];
      for (const chat_id of tgTargets) {
        try {
          const res = await sendTelegram(workspace, { chat_id }, {
            text: card.telegramHtml, parse_mode: 'HTML', buttons: tgButtons,
          });
          if (res?.channel_message_id) newRefs.push({ chat_id: res.sent_to, message_id: res.channel_message_id });
        } catch (e) { console.warn(`[txn-alert] telegram failed (${chat_id}): ${e.message}`); }
      }
      if (newRefs.length) setCardRef(paths, txn.id, { telegram: newRefs });
    } catch (e) { console.warn(`[txn-alert] telegram failed: ${e.message}`); }
  }

  if (config.whatsapp?.enabled && waTargets.length) {
    // Link as the last line of the body, just above the reply buttons
    // (Complete/Cancel), which WhatsApp pins to the bottom of the message.
    const waText = link ? `${card.whatsappText}\n\n${link.label}: ${link.url}` : card.whatsappText;
    for (const phone of waTargets) {
      try {
        await sendWhatsapp(workspace, { phone }, { text: waText, buttons: card.buttons });
      } catch (e) {
        // Likely a closed 24h window (or transient) — queue for replay on the
        // owner's next inbound message, which reopens the window.
        enqueuePendingWhatsApp(paths, { text: waText, buttons: card.buttons, to: phone });
      }
    }
  }

  if (config.email?.enabled && emTargets.length) {
    for (const to of emTargets) {
      try {
        await sendEmail({ ...config.email, to }, { title: `Transaction #${txn.id}`, message: card.plainText });
      } catch (e) { console.warn(`[txn-alert] email failed (${to}): ${e.message}`); }
    }
  }
}

/**
 * Replay any queued WhatsApp cards, in order, when the owner's window reopens
 * (called from the WhatsApp connector on an owner inbound message). The window
 * is open at this point, so cards send with their buttons intact. Best-effort;
 * cards that still fail stay queued for next time.
 */
export async function flushPendingWhatsApp(workspace, paths) {
  const fp = pendingWhatsAppPath(paths);
  let list;
  try { list = readJson(fp); } catch { return; }
  if (!Array.isArray(list) || list.length === 0) return;

  let config;
  try { config = loadNotificationsConfig(paths); } catch { return; }
  if (!config?.whatsapp?.enabled || !config?.whatsapp?.phone) return;

  const remaining = [];
  for (const item of list) {
    try {
      // Replay to the original target when the queued card was routed to a
      // specific number; otherwise the default WhatsApp recipient.
      const ownerCfg = item.to ? { phone: item.to } : config.whatsapp;
      await sendWhatsapp(workspace, ownerCfg, { text: item.text, buttons: item.buttons });
    } catch {
      remaining.push(item); // still failing — keep for next time
    }
  }
  try { writeJson(fp, remaining); } catch { /* best-effort */ }
}
