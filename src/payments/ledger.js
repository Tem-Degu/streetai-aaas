import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { readJson, writeJson } from '../utils/workspace.js';

/**
 * Payment ledger. One JSON file per Stripe Checkout session under
 * .aaas/payments/<payment_id>.json.
 *
 * Lifecycle states (mirroring Stripe's terminology where useful):
 *   pending   — session created, customer hasn't paid yet
 *   paid      — Stripe confirmed payment_status=paid
 *   expired   — session expired before payment
 *   refunded  — fully refunded
 *   cancelled — manually cancelled before payment
 *
 * Ledger entries are the source of truth for the agent. Tools always
 * re-query Stripe before trusting ledger state for live decisions, but the
 * ledger is what the dashboard renders and what cross-turn reasoning reads.
 */

function paymentsDir(paths) {
  return paths.payments;
}

function paymentPath(paths, paymentId) {
  return path.join(paymentsDir(paths), `${paymentId}.json`);
}

export function newPaymentId() {
  return 'pay_' + crypto.randomBytes(6).toString('hex');
}

export function savePayment(paths, payment) {
  fs.mkdirSync(paymentsDir(paths), { recursive: true });
  writeJson(paymentPath(paths, payment.payment_id), payment);
  return payment;
}

export function getPayment(paths, paymentId) {
  if (!paymentId) return null;
  return readJson(paymentPath(paths, paymentId));
}

/**
 * Find a ledger entry by Stripe's checkout session id (cs_*). Used when a
 * webhook arrives carrying the session id but not our own payment_id.
 */
export function findByStripeSession(paths, sessionId) {
  if (!sessionId) return null;
  for (const p of listPayments(paths)) {
    if (p.stripe_session_id === sessionId) return p;
  }
  return null;
}

export function listPayments(paths) {
  const dir = paymentsDir(paths);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const p = readJson(path.join(dir, file));
    if (p?.payment_id) out.push(p);
  }
  return out.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

export function listPending(paths) {
  return listPayments(paths).filter(p => p.status === 'pending');
}

/**
 * Append a webhook event with idempotency on stripe_event_id. Returns
 * `true` if the event was new, `false` if it was a duplicate retry.
 */
export function recordWebhookEvent(paths, paymentId, event) {
  const payment = getPayment(paths, paymentId);
  if (!payment) return false;
  payment.webhook_events = payment.webhook_events || [];
  if (event.stripe_event_id && payment.webhook_events.some(e => e.stripe_event_id === event.stripe_event_id)) {
    return false;
  }
  payment.webhook_events.push({ at: new Date().toISOString(), ...event });
  savePayment(paths, payment);
  return true;
}

/**
 * Hard-delete payments terminated longer than `keepDays`. Pending entries
 * are never purged automatically — they need to be expired by Stripe first.
 */
export function purgeOldPayments(paths, { keepDays = 60 } = {}) {
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  for (const p of listPayments(paths)) {
    if (p.status === 'pending') continue;
    const ended = p.terminated_at || p.created_at;
    if (ended && new Date(ended).getTime() < cutoff) {
      try { fs.unlinkSync(paymentPath(paths, p.payment_id)); } catch { /* ignore */ }
    }
  }
}
