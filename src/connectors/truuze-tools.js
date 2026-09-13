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

async function sendWatch(workspace, args) {
  const chat_id = args?.chat_id;
  const url = String(args?.url ?? '').trim();
  const title = String(args?.title ?? '').trim();
  const idOrCode = args?.id_or_code ?? args?.escrow_id ?? args?.reference_code;

  if (!chat_id) return fail('chat_id is required');
  if (!url) return fail('url is required — the player URL the in-app player will load');
  if (!/^https?:\/\//i.test(url)) return fail('url must be an http(s) URL');
  if (!title) return fail('title is required');

  let cfg;
  try { cfg = loadTruuzeConfig(workspace); }
  catch (err) { return fail(err.message); }

  // If this watch is gated behind a paid service, verify the escrow is paid
  // with the server before handing over the content. Omit id_or_code for free
  // or preview content. Mirrors the "verify state before acting" rule the
  // other tools follow so a confused agent can't leak paid content unpaid.
  if (idOrCode) {
    let snapshot;
    try { ({ snapshot } = await resolveEscrow(cfg, idOrCode)); }
    catch (err) { return fail(err.message); }
    const status = snapshot?.status;
    const paidStatuses = ['active', 'delivered', 'completed', 'resolved'];
    if (!status || !paidStatuses.includes(status)) {
      return fail(
        `Cannot deliver watch — the linked service is not paid (status "${status || 'unknown'}"). Wait until the user has accepted and paid.`,
        { service: summarizeSnapshot(snapshot), next_step: nextStepFor(status) },
      );
    }
  }

  const body = { chat: chat_id, url, title };
  // "audio" makes the card play the track inline (a song, etc.); default video.
  const kind = String(args?.kind ?? 'video').trim().toLowerCase();
  body.kind = kind === 'audio' ? 'audio' : 'video';
  if (args?.poster) body.poster = String(args.poster);
  if (args?.is_live !== undefined) body.is_live = args.is_live;
  // Absolute ISO timestamps take precedence; the *_in_seconds convenience
  // params are resolved to an absolute time relative to now (handy for demos so
  // the value never goes stale).
  if (args?.starts_at) body.starts_at = String(args.starts_at);
  else if (Number.isFinite(Number(args?.starts_in_seconds))) {
    body.starts_at = new Date(Date.now() + Number(args.starts_in_seconds) * 1000).toISOString();
  }
  if (args?.ends_at) body.ends_at = String(args.ends_at);
  else if (Number.isFinite(Number(args?.ends_in_seconds))) {
    body.ends_at = new Date(Date.now() + Number(args.ends_in_seconds) * 1000).toISOString();
  }

  const res = await truuzeFetch(cfg, '/chat/watch/create/', { method: 'POST', body });
  if (!res.ok) {
    return fail(`send_watch rejected (HTTP ${res.status})`, { server: res.data });
  }
  const d = res.data || {};
  return ok({
    delivered: true,
    message_id: d.id,
    title,
    next_step:
      'The user now sees a watch card in the chat and can tap it to play the video in-app. '
      + 'If this was a paid service, call complete_service afterwards so payment is released.',
  });
}

// ─── Tool definitions (LLM-facing schemas) ──────────────

// ─── Message assistant (standing delegation) ───────────
//
// Offered only when the workspace enables `messageAssistant` (see
// `requiresCapability` in src/engine/tools/index.js). The server enforces every
// rule; these handlers turn its refusals into plain instructions so the model
// stops instead of retrying.

function summarizeDelegation(d) {
  if (!d || typeof d !== 'object') return null;
  return {
    id: d.id,
    status: d.status,
    outcome: d.outcome,
    is_live: d.is_live,
    chat_id: d.chat_id,
    user_id: d.user?.id,
    username: d.user?.username,
    granted_at: d.granted_at,
    max_consecutive_replies: d.max_consecutive_replies,
  };
}

function detailOf(res, fallback) {
  const d = res?.data;
  if (d && typeof d === 'object') return d.detail || d.error || fallback;
  if (typeof d === 'string' && d && d.length < 300) return d;
  return fallback;
}

async function requestDelegation(workspace, args, eventCtx) {
  // A delegated turn is someone else's customer, not the person to ask.
  if (eventCtx?.delegation_owner_id) {
    return fail('You are answering a delegated message. Ask for delegation in your own conversation with the person, not here.');
  }

  // Asking from the conversation you are in is the normal case: the person's
  // app shows the approval popup right there. user_id is only for asking
  // someone you have no conversation with.
  const chatId = args?.chat_id ?? eventCtx?.chat_id ?? null;
  const rawUserId = args?.user_id;
  const userId = rawUserId != null && rawUserId !== '' ? Number(rawUserId) : null;
  if (chatId == null && !(Number.isFinite(userId) && userId > 0)) {
    return fail('chat_id is required — your conversation with the person you are asking (or user_id if you have none)');
  }

  let cfg;
  try { cfg = loadTruuzeConfig(workspace); }
  catch (err) { return fail(err.message); }

  let res;
  try {
    res = await truuzeFetch(cfg, '/account/agent/delegation/request/', {
      method: 'POST',
      body: chatId != null ? { chat_id: chatId } : { user_id: userId },
    });
  } catch (err) {
    return fail(`Could not reach Truuze: ${err.message}`);
  }

  if (res.ok) {
    return ok({
      delegation: summarizeDelegation(res.data),
      next_step: 'Nothing is granted yet. They get a popup in your conversation and can also decide under Menu > Message Assistants. You will be told the answer as a [Truuze] event; you can also check with list_delegations.',
    });
  }
  return fail(detailOf(res, `Could not request a delegation (HTTP ${res.status})`), { status: res.status });
}

async function replyForUser(workspace, args, eventCtx) {
  const chatId = args?.chat_id;
  const text = String(args?.text ?? '').trim();
  if (!chatId) return fail('chat_id is required');
  if (!text) return fail('text is required');

  // Only while answering a delegated message, and only in that conversation.
  // The server enforces the grant, but this keeps a customer in some other
  // chat from steering the agent into writing somewhere else.
  if (!eventCtx?.delegation_owner_id) {
    return fail('reply_for_user only works while you are answering a delegated message.');
  }
  if (eventCtx.chat_id != null && String(eventCtx.chat_id) !== String(chatId)) {
    return fail('You can only reply in the conversation you are currently answering.', { chat_id: eventCtx.chat_id });
  }

  let cfg;
  try { cfg = loadTruuzeConfig(workspace); }
  catch (err) { return fail(err.message); }

  let res;
  try {
    res = await truuzeFetch(cfg, '/chat/agent/reply-on-behalf/', {
      method: 'POST',
      body: { chat_id: chatId, text },
    });
  } catch (err) {
    return fail(`Could not reach Truuze: ${err.message}`);
  }

  if (res.ok) return ok({ sent: true, message_id: res.data?.id ?? null });
  if (res.status === 403 || res.status === 409) {
    return fail(detailOf(res, 'Reply refused'), {
      stop: true,
      next_step: 'Do not retry and do not reword it. The person has paused or ended this, is handling the conversation themselves, a limit is reached, or it is the other person\'s turn to speak.',
    });
  }
  return fail(detailOf(res, `Reply failed (HTTP ${res.status})`), { status: res.status });
}

async function listDelegations(workspace) {
  let cfg;
  try { cfg = loadTruuzeConfig(workspace); }
  catch (err) { return fail(err.message); }

  let res;
  try { res = await truuzeFetch(cfg, '/account/agent/delegations/'); }
  catch (err) { return fail(`Could not reach Truuze: ${err.message}`); }

  if (!res.ok) return fail(detailOf(res, `Could not list delegations (HTTP ${res.status})`), { status: res.status });
  const items = Array.isArray(res.data) ? res.data : [];
  return ok({ count: items.length, delegations: items.map(summarizeDelegation) });
}

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
  {
    name: 'send_watch',
    description: 'Deliver an in-app "watch" card into a chat so the user can watch a video or live stream INSIDE Truuze — no external link, no redirect. The card shows a poster + play button; tapping it opens an in-app player pointed at `url`. Use this to hand over streaming access. For paid content, pass id_or_code so the tool verifies the service is paid before delivering, and set `url` to the per-buyer signed player link from your own entitlement/streaming backend (never a raw source stream). Omit id_or_code only for free or preview content.',
    parameters: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'The chat where the watch card should appear.' },
        url: { type: 'string', description: 'The player URL the in-app player loads — an embeddable https page (your signed per-buyer player link for paid content). Must be framing-friendly (playable in an iframe/WebView).' },
        title: { type: 'string', description: 'Title shown on the card (e.g. "Portugal vs Spain").' },
        kind: { type: 'string', enum: ['audio', 'video'], description: 'What the url is. "audio" for a song/track — the card plays it inline with the poster as cover art and a progress bar, no fullscreen. "video" (default) for video or a live stream — opens the in-app player.' },
        poster: { type: 'string', description: 'Optional thumbnail image URL shown on the card. For audio this is the cover art shown while it plays.' },
        is_live: { type: 'boolean', description: 'Optional. true shows a LIVE badge on the card.' },
        starts_at: { type: 'string', description: 'Optional ISO 8601 datetime. If in the future, the card shows a live countdown until it starts (play locked until then).' },
        ends_at: { type: 'string', description: 'Optional ISO 8601 datetime. If already passed, the card shows "Ended" (play locked).' },
        starts_in_seconds: { type: 'number', description: 'Optional convenience. Seconds from now until the stream starts; resolved to an absolute starts_at. Ignored if starts_at is given.' },
        ends_in_seconds: { type: 'number', description: 'Optional convenience. Seconds from now until the stream ends; resolved to an absolute ends_at. Ignored if ends_at is given.' },
        id_or_code: { type: 'string', description: 'Optional. The numeric escrow_id or 6-letter reference_code of the paid service this watch is for. When set, delivery is refused unless the service is paid. Omit for free/preview content.' },
      },
      required: ['chat_id', 'url', 'title'],
    },
  },
  {
    name: 'request_delegation',
    requiresCapability: 'messageAssistant',
    description: 'Ask a person for standing permission to answer the messages other people send them, as their assistant. Use it when they ask you to handle their messages, from your conversation with them. Nothing is granted by this call: they get an approval popup in that conversation and can also decide under Menu > Message Assistants. You are told the answer as a [Truuze] event. A person has one assistant at a time, so approving you ends any other. They must already be listening to you.',
    parameters: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Optional. Your conversation with the person. Defaults to the conversation you are in.' },
        user_id: { type: 'number', description: 'Optional. Only if you have no conversation with them: their numeric Truuze id.' },
      },
    },
  },
  {
    name: 'reply_for_user',
    requiresCapability: 'messageAssistant',
    description: 'Send a reply in a conversation you are answering on someone\'s behalf. Only works during a delegated message turn, in that conversation. Normally you do not need it: your plain-text reply is sent for you. Use it to send more than one message (at most 3 before the other person replies). If it comes back with stop: true, stop. It is the person\'s decision, not an error to retry.',
    parameters: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'The conversation you are answering (chat_id from the delegated message).' },
        text: { type: 'string', description: 'The message text. Plain text only.' },
      },
      required: ['chat_id', 'text'],
    },
  },
  {
    name: 'list_delegations',
    requiresCapability: 'messageAssistant',
    description: 'List the people whose messages you may answer, with the status of each (pending, active, paused). Use it to check whether a request you made was granted.',
    parameters: { type: 'object', properties: {} },
  },
];

const handlers = {
  create_service: createService,
  check_service: checkService,
  complete_service: completeService,
  cancel_service: cancelService,
  respond_to_dispute: respondToDispute,
  list_my_services: listMyServices,
  send_watch: sendWatch,
  request_delegation: requestDelegation,
  reply_for_user: replyForUser,
  list_delegations: listDelegations,
};

export default { definitions, handlers };
