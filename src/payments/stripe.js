import { loadConnection } from '../auth/connections.js';

/**
 * Thin Stripe API wrapper. Uses the workspace's stripe.json connection for
 * auth (the owner's secret key) and speaks the form-encoded REST API
 * directly so we don't take a hard dependency on the stripe-node SDK.
 *
 * All amounts at this layer are MAJOR units (e.g. 12.50 USD), the wrapper
 * converts to minor units (1250 cents) before talking to Stripe.
 */

const STRIPE_BASE = 'https://api.stripe.com/v1';
const FETCH_TIMEOUT_MS = 30_000;

// Currencies whose smallest unit equals 1 (no decimal). Source: Stripe docs.
const ZERO_DECIMAL = new Set(['bif','clp','djf','gnf','jpy','kmf','krw','mga','pyg','rwf','ugx','vnd','vuv','xaf','xof','xpf']);

export class StripeNotConfiguredError extends Error {
  constructor() { super('Stripe is not connected for this workspace'); this.code = 'STRIPE_NOT_CONFIGURED'; }
}

export function loadStripeConfig(workspace) {
  const cfg = loadConnection(workspace, 'stripe');
  if (!cfg || !cfg.secret_key) throw new StripeNotConfiguredError();
  return {
    secret_key: cfg.secret_key,
    mode: cfg.mode === 'live' ? 'live' : 'test',
    currency: (cfg.currency || 'usd').toLowerCase(),
    min_amount: Number(cfg.min_amount) || 0,
    max_amount: Number(cfg.max_amount) || 0,
    success_url: cfg.success_url || 'https://stripe.com',
    cancel_url: cfg.cancel_url || 'https://stripe.com',
    expires_in_minutes: Number(cfg.expires_in_minutes) || 1440, // 24h
  };
}

export function isLiveKey(secretKey) {
  return typeof secretKey === 'string' && secretKey.startsWith('sk_live_');
}

export function toMinor(amount, currency) {
  const cur = (currency || 'usd').toLowerCase();
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid amount: ${amount}`);
  if (ZERO_DECIMAL.has(cur)) return Math.round(n);
  return Math.round(n * 100);
}

export function fromMinor(minor, currency) {
  const cur = (currency || 'usd').toLowerCase();
  const n = Number(minor);
  if (!Number.isFinite(n)) return 0;
  if (ZERO_DECIMAL.has(cur)) return n;
  return n / 100;
}

/**
 * Encode a nested object the way Stripe expects (e.g. line_items[0][price_data][unit_amount]=...).
 * Skips null/undefined values entirely so the API doesn't see literal "null" strings.
 */
export function encodeForm(obj, prefix = '', out = []) {
  if (obj === null || obj === undefined) return out;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => encodeForm(v, prefix ? `${prefix}[${i}]` : String(i), out));
  } else if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      encodeForm(v, prefix ? `${prefix}[${k}]` : k, out);
    }
  } else {
    out.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(obj))}`);
  }
  return out;
}

async function stripeFetch(cfg, apiPath, { method = 'GET', body, idempotencyKey } = {}) {
  const url = `${STRIPE_BASE}${apiPath}`;
  const headers = {
    'Authorization': `Bearer ${cfg.secret_key}`,
  };
  let payload;
  if (body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = encodeForm(body).join('&');
  }
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { method, headers, body: payload, signal: controller.signal });
    let data = null;
    try { data = await resp.json(); } catch { /* ignore */ }
    if (!resp.ok) {
      const msg = data?.error?.message || `Stripe API ${resp.status}`;
      const err = new Error(msg);
      err.status = resp.status;
      err.stripe_error = data?.error || null;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create a Checkout Session for a one-shot payment. Returns the raw Stripe
 * session object (id, url, amount_total, currency, payment_status, ...).
 */
export async function createCheckoutSession(cfg, {
  amount, currency, description, customer_ref, transaction_id,
  success_url, cancel_url, expires_at, metadata, idempotencyKey,
}) {
  const cur = (currency || cfg.currency || 'usd').toLowerCase();
  const unit_amount = toMinor(amount, cur);

  const body = {
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: cur,
        unit_amount,
        product_data: { name: description || 'Service payment' },
      },
      quantity: 1,
    }],
    success_url: success_url || cfg.success_url,
    cancel_url: cancel_url || cfg.cancel_url,
    metadata: {
      ...(metadata || {}),
      ...(transaction_id ? { transaction_id } : {}),
      ...(customer_ref ? { customer_ref } : {}),
    },
  };
  if (customer_ref) body.client_reference_id = String(customer_ref).slice(0, 200);
  if (expires_at) body.expires_at = Math.floor(expires_at / 1000);

  return stripeFetch(cfg, '/checkout/sessions', { method: 'POST', body, idempotencyKey });
}

export async function retrieveSession(cfg, sessionId) {
  return stripeFetch(cfg, `/checkout/sessions/${encodeURIComponent(sessionId)}`);
}

export async function expireSession(cfg, sessionId) {
  return stripeFetch(cfg, `/checkout/sessions/${encodeURIComponent(sessionId)}/expire`, { method: 'POST' });
}

/**
 * Refund a payment_intent (or partial). Stripe expects the PI id (pi_*),
 * which is on the session as `payment_intent` once the session is paid.
 */
export async function createRefund(cfg, { payment_intent, amount, currency, reason, idempotencyKey }) {
  const body = { payment_intent };
  if (amount != null) body.amount = toMinor(amount, currency || cfg.currency);
  if (reason) body.reason = reason;
  return stripeFetch(cfg, '/refunds', { method: 'POST', body, idempotencyKey });
}

/**
 * Map Stripe's session shape into the ledger's status vocabulary.
 *  - status='complete' && payment_status='paid' → paid
 *  - status='expired'  → expired
 *  - status='open' && payment_status='unpaid' → pending
 * Anything else stays pending until next poll.
 */
export function deriveStatus(session) {
  if (!session) return 'pending';
  if (session.status === 'expired') return 'expired';
  if (session.status === 'complete' && session.payment_status === 'paid') return 'paid';
  return 'pending';
}
