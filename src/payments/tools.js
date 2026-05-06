import { getWorkspacePaths } from '../utils/workspace.js';
import {
  newPaymentId, savePayment, getPayment, listPayments, listPending, recordWebhookEvent,
} from './ledger.js';
import {
  loadStripeConfig, createCheckoutSession, retrieveSession, expireSession, createRefund,
  deriveStatus, fromMinor, isLiveKey, StripeNotConfiguredError,
} from './stripe.js';

/**
 * Payment tools (Stripe).
 *
 * Same shape as truuze-tools.js: default export `{ definitions, handlers }`,
 * loaded by ToolRegistry when the workspace has a stripe connection
 * (.aaas/connections/stripe.json) — see CONNECTOR_TOOL_MODULES in
 * src/connectors/index.js.
 *
 * Handler signature: (workspace, args, eventContext?) → JSON string.
 *
 * Design notes:
 *   - All status reads re-query Stripe; the ledger is updated as a side
 *     effect. The agent never trusts cached state for paid/refunded calls.
 *   - The agent never determines paid status from conversation. Tools do.
 *   - refund_payment requires admin/owner context to prevent customer
 *     manipulation — the agent CAN call notify_owner first and, after the
 *     owner replies (which runs the next turn in admin mode), execute the
 *     refund.
 */

const ok = (payload) => JSON.stringify({ ok: true, ...payload });
const fail = (message, extra = {}) => JSON.stringify({ ok: false, error: message, ...extra });

function pathsFor(workspace) {
  return getWorkspacePaths(workspace);
}

function summarize(p) {
  if (!p) return null;
  return {
    payment_id: p.payment_id,
    status: p.status,
    amount: p.amount,
    currency: p.currency,
    description: p.description,
    transaction_id: p.transaction_id || null,
    customer_ref: p.customer_ref || null,
    url: p.url,
    created_at: p.created_at,
    paid_at: p.paid_at || null,
    refunded_at: p.refunded_at || null,
    expires_at: p.expires_at || null,
  };
}

/**
 * Pull the parts of a Stripe session we want to mirror into the ledger.
 * Defensive against missing fields — Stripe omits payment_intent until paid.
 */
function snapshotFromSession(session) {
  return {
    stripe_session_id: session.id,
    stripe_payment_intent: session.payment_intent || null,
    stripe_payment_status: session.payment_status,
    stripe_status: session.status,
    amount_total_minor: session.amount_total,
    last_synced_at: new Date().toISOString(),
  };
}

/**
 * Refresh a single ledger entry from Stripe. Mutates+saves and returns the
 * updated entry. Best-effort — on Stripe error, returns the existing entry
 * unchanged with `sync_error` set so the caller can surface it.
 */
async function syncFromStripe(paths, payment, cfg) {
  if (!payment.stripe_session_id) return payment;
  try {
    const session = await retrieveSession(cfg, payment.stripe_session_id);
    Object.assign(payment, snapshotFromSession(session));
    const newStatus = deriveStatus(session);
    if (payment.status !== newStatus) {
      payment.status = newStatus;
      if (newStatus === 'paid' && !payment.paid_at) {
        payment.paid_at = new Date().toISOString();
      }
      if (newStatus === 'expired' && !payment.terminated_at) {
        payment.terminated_at = new Date().toISOString();
      }
    }
    delete payment.sync_error;
  } catch (err) {
    payment.sync_error = err.message;
  }
  savePayment(paths, payment);
  return payment;
}

// ─── Handlers ────────────────────────────────────────────

async function createPaymentRequest(workspace, args, eventContext) {
  const paths = pathsFor(workspace);
  let cfg;
  try { cfg = loadStripeConfig(workspace); }
  catch (err) {
    if (err instanceof StripeNotConfiguredError) return fail('Stripe is not configured. Ask the owner to connect Stripe in the dashboard before taking payments.');
    return fail(err.message);
  }

  const amount = Number(args?.amount);
  if (!Number.isFinite(amount) || amount <= 0) return fail('amount is required and must be positive');

  const currency = (args?.currency || cfg.currency || 'usd').toLowerCase();
  if (cfg.min_amount > 0 && amount < cfg.min_amount) {
    return fail(`amount ${amount} is below the configured minimum of ${cfg.min_amount} ${currency.toUpperCase()}`);
  }
  if (cfg.max_amount > 0 && amount > cfg.max_amount) {
    return fail(`amount ${amount} is above the configured maximum of ${cfg.max_amount} ${currency.toUpperCase()}`);
  }

  const description = String(args?.description || 'Service payment').slice(0, 500);
  const transaction_id = args?.transaction_id ? String(args.transaction_id) : null;

  // customer_ref ties the ledger entry to the conversation so a future
  // webhook (or the agent itself) can route confirmation back to the right
  // customer. Falls back to platform:userId if the agent didn't pass one.
  const customer_ref = args?.customer_ref
    ? String(args.customer_ref)
    : (eventContext?.platform && eventContext?.userId ? `${eventContext.platform}:${eventContext.userId}` : null);

  const payment_id = newPaymentId();
  const expires_at = Date.now() + cfg.expires_in_minutes * 60 * 1000;

  let session;
  try {
    session = await createCheckoutSession(cfg, {
      amount, currency, description, customer_ref, transaction_id, expires_at,
      metadata: { payment_id },
      idempotencyKey: payment_id, // stable per-creation call
    });
  } catch (err) {
    return fail(`Stripe rejected the request: ${err.message}`, { stripe_error: err.stripe_error });
  }

  const entry = {
    payment_id,
    status: 'pending',
    mode: cfg.mode,
    amount,
    currency,
    description,
    transaction_id,
    customer_ref,
    session_platform: eventContext?.platform || null,
    session_user_id: eventContext?.userId || null,
    session_user_name: eventContext?.userName || null,
    url: session.url,
    expires_at: new Date(expires_at).toISOString(),
    created_at: new Date().toISOString(),
    ...snapshotFromSession(session),
    webhook_events: [],
  };
  savePayment(paths, entry);

  return ok({
    payment: summarize(entry),
    next_step: 'Send the URL to the customer and ASK them to let you know once they have completed payment. Do NOT mark anything paid yourself — when the customer says they paid, call get_payment_status to verify with Stripe before confirming.',
  });
}

async function getPaymentStatus(workspace, args) {
  const paths = pathsFor(workspace);
  const payment_id = args?.payment_id;
  if (!payment_id) return fail('payment_id is required');

  const entry = getPayment(paths, payment_id);
  if (!entry) return fail(`Unknown payment_id: ${payment_id}`);

  if (['pending'].includes(entry.status)) {
    let cfg;
    try { cfg = loadStripeConfig(workspace); }
    catch (err) { return fail(err.message); }
    await syncFromStripe(paths, entry, cfg);
  }

  const next_step = entry.status === 'paid'
    ? 'Payment confirmed. Proceed with delivery and update or complete the transaction as appropriate.'
    : entry.status === 'pending'
      ? 'Payment is still pending. The customer has not completed checkout yet — politely ask them to finish at the link, or wait. Do NOT confirm payment.'
      : entry.status === 'expired'
        ? 'Payment session expired. Ask the customer if they still want to proceed; if yes, call create_payment_request again to issue a new link.'
        : entry.status === 'refunded'
          ? 'Payment has been refunded. Update the transaction accordingly.'
          : 'Terminal state.';

  return ok({ payment: summarize(entry), next_step });
}

async function listPendingPayments(workspace) {
  const paths = pathsFor(workspace);
  let cfg;
  try { cfg = loadStripeConfig(workspace); }
  catch (err) { return fail(err.message); }

  const pending = listPending(paths);
  const refreshed = [];
  for (const p of pending) {
    await syncFromStripe(paths, p, cfg);
    refreshed.push(summarize(p));
  }
  const stillPending = refreshed.filter(p => p.status === 'pending');
  return ok({ count: stillPending.length, payments: stillPending, refreshed_count: refreshed.length });
}

async function refundPayment(workspace, args, eventContext) {
  const paths = pathsFor(workspace);
  const payment_id = args?.payment_id;
  if (!payment_id) return fail('payment_id is required');

  const isOwnerContext = eventContext?.mode === 'admin' || eventContext?.is_owner === true;
  if (!isOwnerContext) {
    return fail('Refunds require owner approval. Use notify_owner to escalate, then process the refund on the owner-reply turn.', {
      next_step: 'Call notify_owner with the payment_id, amount, and the customer\'s reason. Do not promise the refund to the customer until the owner approves.',
    });
  }

  const entry = getPayment(paths, payment_id);
  if (!entry) return fail(`Unknown payment_id: ${payment_id}`);
  if (entry.status === 'refunded') return fail('This payment has already been refunded.', { payment: summarize(entry) });
  if (entry.status !== 'paid') return fail(`Cannot refund — payment is in status "${entry.status}"`, { payment: summarize(entry) });
  if (!entry.stripe_payment_intent) return fail('No payment_intent on file for this payment — cannot refund. Sync first.');

  let cfg;
  try { cfg = loadStripeConfig(workspace); }
  catch (err) { return fail(err.message); }

  let refund;
  try {
    refund = await createRefund(cfg, {
      payment_intent: entry.stripe_payment_intent,
      amount: args?.amount,
      currency: entry.currency,
      reason: args?.reason,
      idempotencyKey: `refund:${payment_id}:${args?.amount ?? 'full'}`,
    });
  } catch (err) {
    return fail(`Stripe refund failed: ${err.message}`, { stripe_error: err.stripe_error });
  }

  entry.status = 'refunded';
  entry.refunded_at = new Date().toISOString();
  entry.terminated_at = entry.refunded_at;
  entry.refund = {
    id: refund.id,
    amount: fromMinor(refund.amount, entry.currency),
    reason: refund.reason,
  };
  savePayment(paths, entry);

  return ok({ payment: summarize(entry), refund: entry.refund });
}

async function cancelPaymentRequest(workspace, args) {
  const paths = pathsFor(workspace);
  const payment_id = args?.payment_id;
  if (!payment_id) return fail('payment_id is required');

  const entry = getPayment(paths, payment_id);
  if (!entry) return fail(`Unknown payment_id: ${payment_id}`);
  if (entry.status !== 'pending') {
    return fail(`Cannot cancel — payment is in status "${entry.status}". Only pending sessions can be cancelled.`, { payment: summarize(entry) });
  }

  let cfg;
  try { cfg = loadStripeConfig(workspace); }
  catch (err) { return fail(err.message); }

  try {
    await expireSession(cfg, entry.stripe_session_id);
  } catch (err) {
    return fail(`Stripe expire failed: ${err.message}`, { stripe_error: err.stripe_error });
  }

  entry.status = 'cancelled';
  entry.terminated_at = new Date().toISOString();
  savePayment(paths, entry);
  return ok({ payment: summarize(entry) });
}

async function listAllPayments(workspace, args) {
  const paths = pathsFor(workspace);
  const limit = Math.min(Number(args?.limit) || 25, 200);
  const status = args?.status;
  let entries = listPayments(paths);
  if (status) entries = entries.filter(e => e.status === status);
  return ok({ count: entries.length, payments: entries.slice(0, limit).map(summarize) });
}

// ─── Definitions ─────────────────────────────────────────

const definitions = [
  {
    name: 'create_payment_request',
    description: 'Create a Stripe payment request for the customer. Returns a hosted Checkout URL — send this URL to the customer and ASK them to let you know once they have completed payment. NEVER mark a payment received yourself; always verify with get_payment_status when the customer claims they paid. Amount is in major units (e.g. 12.50 means $12.50 USD). Pass transaction_id if this payment is tied to a service transaction.',
    parameters: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'Amount in major units (e.g. 12.50 for $12.50). Must be positive.' },
        currency: { type: 'string', description: 'ISO currency code (usd, eur, gbp, ...). Defaults to the workspace default.' },
        description: { type: 'string', description: 'Short description shown to the customer on the checkout page (e.g. "Logo design service").' },
        transaction_id: { type: 'string', description: 'Optional transaction ID this payment belongs to. Recommended when a transaction exists.' },
        customer_ref: { type: 'string', description: 'Optional customer reference. If omitted, the runtime fills it with the current platform:user_id.' },
      },
      required: ['amount', 'description'],
    },
  },
  {
    name: 'get_payment_status',
    description: 'Check the live status of a payment by its payment_id. ALWAYS call this when the customer says they paid — never trust their word alone. The tool re-queries Stripe and updates the ledger. Returns status: pending | paid | expired | refunded | cancelled. Only confirm payment to the customer when this returns "paid".',
    parameters: {
      type: 'object',
      properties: {
        payment_id: { type: 'string', description: 'The payment_id returned by create_payment_request.' },
      },
      required: ['payment_id'],
    },
  },
  {
    name: 'list_pending_payments',
    description: 'List all currently pending payments. Refreshes each one from Stripe before returning. Use this when the owner asks "any new payments?" or when reconciling after an outage.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'refund_payment',
    description: 'Refund a paid payment, fully or partially. REQUIRES OWNER APPROVAL — only callable in admin mode (when the owner is talking to you, including via notify_owner reply). If a customer asks for a refund, use notify_owner to ask the owner first. Provide payment_id and optional amount (omit for full refund) and reason.',
    parameters: {
      type: 'object',
      properties: {
        payment_id: { type: 'string', description: 'The payment_id to refund.' },
        amount: { type: 'number', description: 'Optional partial-refund amount in major units. Omit for full refund.' },
        reason: { type: 'string', enum: ['duplicate', 'fraudulent', 'requested_by_customer'], description: 'Optional Stripe-recognized reason code.' },
      },
      required: ['payment_id'],
    },
  },
  {
    name: 'cancel_payment_request',
    description: 'Void a still-unpaid payment request so the customer can no longer pay it. Use when a customer changes their mind before paying, or when a quote is no longer valid. Cannot be used after payment.',
    parameters: {
      type: 'object',
      properties: {
        payment_id: { type: 'string', description: 'The payment_id to cancel.' },
      },
      required: ['payment_id'],
    },
  },
  {
    name: 'list_payments',
    description: 'List recent payments from the ledger (does not refresh from Stripe). Filter by status if you only want one state. Use for summaries; use get_payment_status / list_pending_payments for live data.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Optional filter: pending, paid, expired, refunded, cancelled.' },
        limit: { type: 'number', description: 'Max entries (default 25, max 200).' },
      },
    },
  },
];

const handlers = {
  create_payment_request: createPaymentRequest,
  get_payment_status: getPaymentStatus,
  list_pending_payments: listPendingPayments,
  refund_payment: refundPayment,
  cancel_payment_request: cancelPaymentRequest,
  list_payments: listAllPayments,
};

export default { definitions, handlers };

// Export a small helper for the dashboard / future webhook receiver to
// apply a paid-status update + idempotent webhook event to the ledger.
export async function applyWebhookPaymentUpdate(paths, { payment_id, stripe_session_id, stripe_event_id, status, payment_intent, payload }) {
  let entry = payment_id ? getPayment(paths, payment_id) : null;
  if (!entry && stripe_session_id) {
    const { findByStripeSession } = await import('./ledger.js');
    entry = findByStripeSession(paths, stripe_session_id);
  }
  if (!entry) return null;
  const isNewEvent = recordWebhookEvent(paths, entry.payment_id, { stripe_event_id, type: payload?.type || null, status });
  if (!isNewEvent) return entry;
  if (status && entry.status !== status) {
    entry.status = status;
    if (status === 'paid' && !entry.paid_at) entry.paid_at = new Date().toISOString();
    if (status === 'refunded' && !entry.refunded_at) entry.refunded_at = new Date().toISOString();
    if (['expired','cancelled','refunded'].includes(status) && !entry.terminated_at) entry.terminated_at = new Date().toISOString();
    if (payment_intent && !entry.stripe_payment_intent) entry.stripe_payment_intent = payment_intent;
    savePayment(paths, entry);
  }
  return entry;
}

export { isLiveKey };
