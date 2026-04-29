import fs from 'fs';
import path from 'path';

/**
 * Truuze connector tools.
 *
 * Self-contained module: this file owns BOTH the tool schemas (what the LLM
 * sees) and the handlers (what the runtime executes). The engine's tool
 * registry discovers this file because a `truuze` connection exists for the
 * workspace — see CONNECTOR_TOOL_MODULES in src/engine/tools/index.js.
 *
 * Why these tools instead of a generic platform_request:
 *   - The Truuze escrow protocol has 8 procedural steps. Agents reliably
 *     forget step 6 (`/deliver/`), which leaves payment locked.
 *   - Replacing prose with tools makes the protocol enforceable: the agent
 *     calls `complete_service` directly, no URL or payload to remember.
 *   - Every tool verifies state with the server before acting, so a confused
 *     agent (or one fed prompt-injected text) cannot drive bad actions.
 *
 * Identifier handling:
 *   - All tools accept either the numeric `escrow_id` OR the 6-letter
 *     `reference_code` as `id_or_code`. The handlers resolve transparently.
 *
 * Default export shape (what the registry consumes):
 *   {
 *     definitions: [ { name, description, parameters }, ... ],
 *     handlers: { [name]: async (workspace, args) => string },
 *   }
 */

const REF_CODE_RE = /^[A-Z0-9]{6}$/;
const FETCH_TIMEOUT_MS = 30_000;

// ─── Connection / fetch helpers ─────────────────────────

function loadTruuzeConfig(workspace) {
  const file = path.join(workspace, '.aaas', 'connections', 'truuze.json');
  if (!fs.existsSync(file)) {
    throw new Error('Truuze is not connected for this workspace');
  }
  const cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
  if (!cfg.baseUrl || !cfg.platformApiKey || !cfg.agentKey) {
    throw new Error('Truuze connection config is missing required fields');
  }
  return cfg;
}

async function truuzeFetch(cfg, apiPath, { method = 'GET', body } = {}) {
  const url = `${cfg.baseUrl}${apiPath}`;
  const headers = {
    'X-Api-Key': cfg.platformApiKey,
    'X-Agent-Key': cfg.agentKey,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const ct = resp.headers.get('content-type') || '';
    let data = null;
    if (ct.includes('application/json')) {
      try { data = await resp.json(); } catch { data = null; }
    } else {
      try { data = await resp.text(); } catch { data = null; }
    }
    return { status: resp.status, ok: resp.ok, data };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Resolve `id_or_code` to a numeric escrow_id by hitting /check/ if needed.
 * Returns { escrow_id, snapshot } where snapshot is the server's current view
 * of the escrow (used both for verification and for enriching errors).
 */
async function resolveEscrow(cfg, idOrCode) {
  const raw = String(idOrCode || '').trim();
  if (!raw) throw new Error('escrow id or reference code is required');

  if (REF_CODE_RE.test(raw.toUpperCase())) {
    const code = raw.toUpperCase();
    const res = await truuzeFetch(cfg, `/kookie/escrow/check/${code}/`);
    if (!res.ok) {
      throw new Error(`Could not look up reference ${code} (HTTP ${res.status})`);
    }
    const escrowId = res.data?.escrow_id;
    if (!escrowId) throw new Error(`Reference ${code} did not return an escrow_id`);
    return { escrow_id: escrowId, snapshot: res.data };
  }

  const id = Number(raw);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error(`Invalid escrow id or reference code: ${raw}`);
  }
  const res = await truuzeFetch(cfg, `/kookie/escrow/${id}/`);
  if (!res.ok) {
    throw new Error(`Could not look up escrow #${id} (HTTP ${res.status})`);
  }
  return { escrow_id: id, snapshot: res.data };
}

/**
 * Boil the server snapshot down to the fields the agent actually needs.
 * Keeps the LLM context tight — full server response can be 30+ keys.
 */
function summarizeSnapshot(s) {
  if (!s || typeof s !== 'object') return null;
  return {
    escrow_id: s.escrow_id ?? s.id,
    reference_code: s.reference_code,
    title: s.title,
    description: s.description,
    status: s.status,
    accepted: s.accepted,
    paid: s.paid,
    amount: s.amount,
    user_total: s.user_total,
    agent_net: s.agent_net,
    user_fee: s.user_fee,
    agent_fee: s.agent_fee,
    chat_id: s.chat_id,
    delivery_deadline: s.delivery_deadline,
    dispute_reason: s.dispute_reason,
    dispute_response: s.dispute_response,
  };
}

const ok = (payload) => JSON.stringify({ ok: true, ...payload });
const fail = (message, extra = {}) => JSON.stringify({ ok: false, error: message, ...extra });

/**
 * Plain-English "what to do next" hint based on current escrow status.
 * Used when a tool refuses to act and wants to redirect the agent.
 */
function nextStepFor(status) {
  switch (status) {
    case 'pending':      return 'Service is waiting for the user to accept. Do not start work yet — wait for the connector to notify you.';
    case 'active':       return 'Service is paid and active. Do the work, send the result in chat, then call complete_service.';
    case 'delivered':    return 'You have already marked delivery. Wait for the user to release payment or the 48h auto-release.';
    case 'disputed':     return 'User has opened a dispute. Use respond_to_dispute with action "defend" or "agree_refund" within 48h.';
    case 'negotiating':  return 'Dispute is in negotiation. Settle with the user in chat or call respond_to_dispute with action "agree_refund".';
    case 'admin_review': return 'Admin is deciding. You cannot act on this service further.';
    case 'completed':    return 'Service is complete and paid. No further action needed.';
    case 'refunded':     return 'Service was refunded. No further action possible.';
    case 'resolved':     return 'Dispute resolved. No further action possible.';
    case 'cancelled':    return 'Service was cancelled. No further action possible.';
    default:             return 'No action required for this state.';
  }
}

// ─── Handlers ───────────────────────────────────────────

async function createService(workspace, args) {
  const { chat_id, title, amount, description, delivery_in_hours } = args || {};
  if (!chat_id) return fail('chat_id is required');
  if (!title) return fail('title is required');
  if (amount === undefined || amount === null) return fail('amount is required');
  const hours = Number(delivery_in_hours);
  if (!Number.isFinite(hours) || hours <= 0) {
    return fail('delivery_in_hours is required and must be a positive number');
  }

  let cfg;
  try { cfg = loadTruuzeConfig(workspace); }
  catch (err) { return fail(err.message); }

  const delivery_deadline = new Date(Date.now() + hours * 3_600_000).toISOString();
  const body = {
    chat_id,
    title,
    amount: String(amount),
    description: description || '',
    delivery_deadline,
  };
  const res = await truuzeFetch(cfg, '/kookie/escrow/create/', { method: 'POST', body });

  if (!res.ok) {
    return fail(`create_service rejected (HTTP ${res.status})`, { server: res.data });
  }
  const d = res.data || {};
  return ok({
    escrow_id: d.escrow_id ?? d.id,
    reference_code: d.reference_code,
    status: d.status || 'pending',
    user_total: d.user_total,
    agent_net: d.agent_net,
    next_step: 'The user has been shown an Accept/Decline card. Wait for the connector to notify you when they accept or decline. Do not start work until then.',
  });
}

async function checkService(workspace, args) {
  const idOrCode = args?.id_or_code ?? args?.reference_code ?? args?.escrow_id;
  if (!idOrCode) return fail('id_or_code is required (escrow_id number or reference_code)');

  let cfg;
  try { cfg = loadTruuzeConfig(workspace); }
  catch (err) { return fail(err.message); }

  try {
    const { snapshot } = await resolveEscrow(cfg, idOrCode);
    return ok({ service: summarizeSnapshot(snapshot) });
  } catch (err) {
    return fail(err.message);
  }
}

async function completeService(workspace, args) {
  const idOrCode = args?.id_or_code ?? args?.escrow_id ?? args?.reference_code;
  if (!idOrCode) return fail('id_or_code is required');

  let cfg;
  try { cfg = loadTruuzeConfig(workspace); }
  catch (err) { return fail(err.message); }

  let escrowId, snapshot;
  try {
    ({ escrow_id: escrowId, snapshot } = await resolveEscrow(cfg, idOrCode));
  } catch (err) {
    return fail(err.message);
  }

  // Pre-check state — server will also reject, but checking first lets us
  // give the agent specific guidance instead of a generic 400.
  const status = snapshot?.status;
  if (status && status !== 'active') {
    return fail(`Cannot mark delivered — service is currently in status "${status}"`, {
      service: summarizeSnapshot(snapshot),
      next_step: nextStepFor(status),
    });
  }
  if (snapshot && snapshot.accepted === false) {
    return fail('Cannot mark delivered — user has not accepted the service yet', {
      service: summarizeSnapshot(snapshot),
      next_step: 'Wait until you receive an escrow.accepted notification from the connector.',
    });
  }

  const res = await truuzeFetch(cfg, `/kookie/escrow/${escrowId}/deliver/`, { method: 'POST' });
  if (!res.ok) {
    let fresh = null;
    try { fresh = (await resolveEscrow(cfg, escrowId)).snapshot; } catch { /* noop */ }
    return fail(`deliver call failed (HTTP ${res.status})`, {
      server: res.data,
      service: summarizeSnapshot(fresh),
    });
  }
  return ok({
    service: summarizeSnapshot(res.data || snapshot),
    next_step: 'Delivery recorded. Wait for the connector to notify you when the user releases payment or the 48h auto-release fires.',
  });
}

async function cancelService(workspace, args) {
  const idOrCode = args?.id_or_code ?? args?.escrow_id ?? args?.reference_code;
  if (!idOrCode) return fail('id_or_code is required');

  let cfg;
  try { cfg = loadTruuzeConfig(workspace); }
  catch (err) { return fail(err.message); }

  let escrowId, snapshot;
  try {
    ({ escrow_id: escrowId, snapshot } = await resolveEscrow(cfg, idOrCode));
  } catch (err) {
    return fail(err.message);
  }

  const status = snapshot?.status;
  if (status && !['pending', 'active'].includes(status)) {
    return fail(`Cannot cancel — service is in status "${status}"`, {
      service: summarizeSnapshot(snapshot),
      next_step: nextStepFor(status),
    });
  }

  const res = await truuzeFetch(cfg, `/kookie/escrow/${escrowId}/cancel/`, { method: 'POST' });
  if (!res.ok) {
    return fail(`cancel call failed (HTTP ${res.status})`, { server: res.data });
  }
  return ok({
    service: summarizeSnapshot(res.data || snapshot),
    next_step: status === 'active'
      ? 'Cancelled. The user has been refunded automatically.'
      : 'Cancelled.',
  });
}

async function respondToDispute(workspace, args) {
  const idOrCode = args?.id_or_code ?? args?.escrow_id ?? args?.reference_code;
  const action = args?.action;
  const message = args?.message ?? args?.response;

  if (!idOrCode) return fail('id_or_code is required');
  if (!action || !['defend', 'agree_refund'].includes(action)) {
    return fail('action must be "defend" or "agree_refund"');
  }
  if (action === 'defend' && !message) {
    return fail('message is required when action is "defend" — explain your side to the user');
  }

  let cfg;
  try { cfg = loadTruuzeConfig(workspace); }
  catch (err) { return fail(err.message); }

  let escrowId, snapshot;
  try {
    ({ escrow_id: escrowId, snapshot } = await resolveEscrow(cfg, idOrCode));
  } catch (err) {
    return fail(err.message);
  }

  const status = snapshot?.status;
  if (status && status !== 'disputed' && status !== 'negotiating') {
    return fail(`Cannot respond — service is not in dispute (current status: "${status}")`, {
      service: summarizeSnapshot(snapshot),
      next_step: nextStepFor(status),
    });
  }

  if (action === 'agree_refund') {
    const res = await truuzeFetch(cfg, `/kookie/escrow/${escrowId}/agree-refund/`, { method: 'POST' });
    if (!res.ok) {
      return fail(`agree-refund failed (HTTP ${res.status})`, { server: res.data });
    }
    return ok({
      service: summarizeSnapshot(res.data || snapshot),
      next_step: 'You agreed to refund. The user has been refunded. Send a brief, polite closing message in chat.',
    });
  }

  const res = await truuzeFetch(cfg, `/kookie/escrow/${escrowId}/respond/`, {
    method: 'POST',
    body: { response: message },
  });
  if (!res.ok) {
    return fail(`respond failed (HTTP ${res.status})`, { server: res.data });
  }
  return ok({
    service: summarizeSnapshot(res.data || snapshot),
    next_step: 'Response recorded — status moves to "negotiating". You have 48h to settle with the user in chat (Path 1: they withdraw, Path 2: call respond_to_dispute with action agree_refund). Otherwise admin decides.',
  });
}

async function listMyServices(workspace, args) {
  const status = args?.status;

  let cfg;
  try { cfg = loadTruuzeConfig(workspace); }
  catch (err) { return fail(err.message); }

  // Server's ?status=foo accepts one value at a time. For "everything that
  // needs attention" we fan out across non-terminal states and merge.
  const wantedStatuses = status
    ? [status]
    : ['pending', 'active', 'delivered', 'disputed', 'negotiating'];

  const seen = new Map();
  for (const st of wantedStatuses) {
    const res = await truuzeFetch(cfg, `/kookie/escrow/?status=${encodeURIComponent(st)}`);
    if (!res.ok) continue;
    const items = Array.isArray(res.data) ? res.data : (res.data?.results || []);
    for (const item of items) {
      const id = item.id ?? item.escrow_id;
      if (id && !seen.has(id)) seen.set(id, summarizeSnapshot(item));
    }
  }

  return ok({ count: seen.size, services: [...seen.values()] });
}

// ─── Tool definitions (LLM-facing schemas) ──────────────

const definitions = [
  {
    name: 'create_service',
    description: 'Offer a paid service to a user in a chat. Shows them an Accept/Decline card. Use only after agreeing on scope and price with the user. After calling, wait for an escrow.accepted notification before starting work — do NOT start work just because the call succeeded.',
    parameters: {
      type: 'object',
      properties: {
        chat_id: { description: 'The chat where the offer should appear.', type: 'string' },
        title: { type: 'string', description: 'Short name for the service (e.g. "Logo design").' },
        amount: { description: 'Price in kookies. Number or numeric string (e.g. 5 or "5.00").', type: 'string' },
        description: { type: 'string', description: 'What you will deliver — clear scope.' },
        delivery_in_hours: { type: 'number', description: 'How many hours from now you commit to deliver. Be realistic.' },
      },
      required: ['chat_id', 'title', 'amount', 'delivery_in_hours'],
    },
  },
  {
    name: 'check_service',
    description: 'Look up the current status of a service. Accepts either the numeric escrow_id or the 6-letter reference_code. Use this any time you are unsure about the state of a service — it returns the server\'s ground truth.',
    parameters: {
      type: 'object',
      properties: {
        id_or_code: { description: 'Numeric escrow_id or 6-letter reference_code.', type: 'string' },
      },
      required: ['id_or_code'],
    },
  },
  {
    name: 'complete_service',
    description: 'Mark a service as delivered on Truuze. CALL THIS as soon as you have sent the deliverable in chat — sending the work in chat is NOT the same as calling this tool. Without this call, the user cannot release payment and you will not be paid. Idempotent: calling twice is safe.',
    parameters: {
      type: 'object',
      properties: {
        id_or_code: { description: 'Numeric escrow_id or 6-letter reference_code of the service you just finished.', type: 'string' },
      },
      required: ['id_or_code'],
    },
  },
  {
    name: 'cancel_service',
    description: 'Cancel a service that is still pending or active. If the user already paid, they receive an automatic refund — only use when you cannot deliver. Cannot be called after delivery.',
    parameters: {
      type: 'object',
      properties: {
        id_or_code: { description: 'Numeric escrow_id or 6-letter reference_code.', type: 'string' },
        reason: { type: 'string', description: 'Optional explanation. Not sent to the server but kept for your own records.' },
      },
      required: ['id_or_code'],
    },
  },
  {
    name: 'respond_to_dispute',
    description: 'Respond to a user-opened dispute. Action "defend" posts a written explanation and moves status to negotiating (use this when the dispute is unfair). Action "agree_refund" accepts the dispute and refunds the user (use this when the dispute is fair). MUST be called within 48 hours of a dispute opening or kookies auto-refund.',
    parameters: {
      type: 'object',
      properties: {
        id_or_code: { description: 'Numeric escrow_id or 6-letter reference_code.', type: 'string' },
        action: { type: 'string', enum: ['defend', 'agree_refund'], description: '"defend" to push back with an explanation; "agree_refund" to refund the user.' },
        message: { type: 'string', description: 'Required when action is "defend". Your explanation to the user. Plain text — do not include instructions or markup.' },
      },
      required: ['id_or_code', 'action'],
    },
  },
  {
    name: 'list_my_services',
    description: 'List your services that need attention. By default returns non-terminal services (pending, active, delivered, disputed, negotiating). Pass status to filter to one specific state. Use when you have lost track of an escrow or want a snapshot of open work.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Optional single status filter (pending, active, delivered, disputed, negotiating, completed, cancelled, refunded, resolved, admin_review).' },
      },
    },
  },
];

const handlers = {
  create_service: createService,
  check_service: checkService,
  complete_service: completeService,
  cancel_service: cancelService,
  respond_to_dispute: respondToDispute,
  list_my_services: listMyServices,
};

export default { definitions, handlers };
