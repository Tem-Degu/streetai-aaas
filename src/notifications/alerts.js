import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { readJson, writeJson } from '../utils/workspace.js';

/**
 * Alert ledger. Tracks every notification we've sent to the owner so that
 * incoming replies (Telegram reply-threading, WhatsApp context.message_id,
 * or just a casual message right after an alert) can be routed back to the
 * customer session that triggered the alert.
 *
 * Storage: one JSON file per alert under .aaas/notifications/sent/<id>.json
 *
 * Lifecycle:
 *   pending      → no reply received yet
 *   acknowledged → at least one reply received, agent acted on it
 *   expired      → past TTL with no/stale activity (cleaned up on read)
 */

const DEFAULT_TTL_HOURS = 24;
const DEFAULT_RECENT_WINDOW_MIN = 30;

function alertsDir(paths) {
  return path.join(paths.root, '.aaas', 'notifications', 'sent');
}

function alertPath(paths, alertId) {
  return path.join(alertsDir(paths), `${alertId}.json`);
}

export function newAlertId() {
  return 'alt_' + crypto.randomBytes(6).toString('hex');
}

/**
 * Persist a new alert. Caller fills in channels[] (each entry recorded by
 * the senders with channel_message_id when available) and context.
 */
export function saveAlert(paths, alert) {
  fs.mkdirSync(alertsDir(paths), { recursive: true });
  writeJson(alertPath(paths, alert.alert_id), alert);
  return alert;
}

export function getAlert(paths, alertId) {
  if (!alertId) return null;
  return readJson(alertPath(paths, alertId));
}

/**
 * Look up an alert by the channel-specific message ID. Used by the
 * Telegram connector when the owner replies with reply_to_message_id, and
 * by the WhatsApp connector with context.message_id.
 */
export function findAlertByChannelMessage(paths, channel, channelMessageId) {
  if (!channelMessageId) return null;
  const target = String(channelMessageId);
  for (const alert of listAlerts(paths)) {
    const match = (alert.channels || []).find(c =>
      c.channel === channel && String(c.channel_message_id) === target
    );
    if (match) return alert;
  }
  return null;
}

/**
 * Recent open alerts that the owner *might* be casually replying to.
 * Filters to alerts sent on `channel` to `recipient` within
 * `windowMinutes`. Alerts in `expired` state never match.
 */
export function getRecentOpenAlerts(paths, { channel, recipient, windowMinutes = DEFAULT_RECENT_WINDOW_MIN } = {}) {
  const now = Date.now();
  const windowMs = windowMinutes * 60 * 1000;
  return listAlerts(paths)
    .filter(a => a.status !== 'expired')
    .filter(a => {
      if (!channel) return true;
      return (a.channels || []).some(c =>
        c.channel === channel && c.ok && (!recipient || String(c.sent_to) === String(recipient))
      );
    })
    .filter(a => {
      const sentAt = a.sent_at ? new Date(a.sent_at).getTime() : 0;
      return now - sentAt <= windowMs;
    })
    .sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at));
}

/**
 * Record an owner response on an alert and bump it to acknowledged. Stays
 * in the ledger so subsequent replies on the same alert still route.
 */
export function recordResponse(paths, alertId, response) {
  const alert = getAlert(paths, alertId);
  if (!alert) return null;
  alert.responses = alert.responses || [];
  alert.responses.push({ at: new Date().toISOString(), ...response });
  if (alert.status === 'pending') alert.status = 'acknowledged';
  saveAlert(paths, alert);
  return alert;
}

/**
 * Read all alerts. Side-effect: silently expires (not deletes) records
 * past their TTL so they no longer match recent-window lookups.
 */
export function listAlerts(paths) {
  const dir = alertsDir(paths);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const now = Date.now();
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const a = readJson(path.join(dir, file));
    if (!a?.alert_id) continue;
    if (a.status !== 'expired' && a.expires_at && now > new Date(a.expires_at).getTime()) {
      a.status = 'expired';
      try { writeJson(path.join(dir, file), a); } catch { /* read-only fs, fine */ }
    }
    out.push(a);
  }
  return out;
}

/**
 * Hard-delete alerts that have been expired for longer than `keepDays`.
 * Called occasionally; we don't need a scheduler for v1.
 */
export function purgeOldAlerts(paths, { keepDays = 7 } = {}) {
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  for (const a of listAlerts(paths)) {
    if (a.status !== 'expired') continue;
    const sentAt = a.sent_at ? new Date(a.sent_at).getTime() : 0;
    if (sentAt && sentAt < cutoff) {
      try { fs.unlinkSync(alertPath(paths, a.alert_id)); } catch { /* ignore */ }
    }
  }
}

export function defaultTtlMs() {
  return DEFAULT_TTL_HOURS * 60 * 60 * 1000;
}
