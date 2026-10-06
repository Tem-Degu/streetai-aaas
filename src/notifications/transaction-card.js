// Renders a transaction into a mobile-friendly "card" for owner push
// notifications (Telegram / WhatsApp / Email). Config-driven: it uses the
// workspace's transaction_view labels/formats so each business shows its own
// relevant fields. Returns per-channel strings (so bold renders natively on
// each) plus the action buttons for non-terminal transactions.

const EVENTS = {
  created:   { emoji: '🆕', verb: 'New' },
  updated:   { emoji: '✏️', verb: 'Updated' },
  cancelled: { emoji: '❌', verb: 'Cancelled' },
  completed: { emoji: '✅', verb: 'Completed' },
};

// Keys that hold the customer's name/identity, in precedence order. The header
// renders a single "Customer" line from the first non-empty one, so every key
// here is also skipped as a field line below — otherwise the same value shows
// twice (e.g. "Customer: John" plus "Name: John").
const CUSTOMER_KEYS = [
  'user_name', 'customer_name', 'customer', 'full_name', 'client_name',
  'user', 'client', 'name', 'username',
];

// Fields never shown as a line (either in the header, internal, or noisy).
const SKIP_FIELDS = new Set([
  'service', 'id', 'display_index', 'user_id', 'status',
  'currency', 'created_at', 'updated_at', 'completed_at', 'cancelled_at',
  'archived', 'archived_at', 'session_platform', '_file',
  ...CUSTOMER_KEYS,
]);

const TERMINAL = new Set(['completed', 'cancelled']);

function prettifyKey(k) {
  return String(k).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function htmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// True for a non-empty array whose entries are all objects (e.g. order items,
// sub_transactions). These render as a multi-line bulleted block, not one line.
function isObjectList(value) {
  return Array.isArray(value) && value.length > 0 && value.every(v => v && typeof v === 'object');
}

// Tight measurement units render glued to the number ("1kg", "500g", "2L");
// word-like units ("box", "dozen", "plate") read better with a space ("2 box").
const TIGHT_UNITS = new Set(['kg', 'g', 'mg', 'l', 'ml', 'cl', 'lb', 'oz', 'cc', 'm', 'cm', 'mm']);

// Build the quantity prefix for an item line.
//  - quantity + unit     → use the unit as written ("1kg", "2 box"), no "×"
//  - bare numeric count  → multiplier style ("2×")
//  - quantity that already carries its own unit ("1kg", "2 plates") → as-is
//  - no quantity         → empty (a lone unit is meaningless, drop it)
function itemPrefix(qty, unit) {
  const hasQty = qty !== null && qty !== undefined && String(qty).trim() !== '';
  if (!hasQty) return ''; // without a number, a unit on its own says nothing
  if (unit) {
    const u = String(unit).trim();
    const glue = TIGHT_UNITS.has(u.toLowerCase()) ? '' : ' ';
    return `${qty}${glue}${u}`;
  }
  // Only a plain number gets the "×" multiplier. A quantity string that already
  // includes its unit ("1kg") is shown verbatim so we don't produce "1kg×".
  return /^\d+(\.\d+)?$/.test(String(qty).trim()) ? `${qty}×` : String(qty).trim();
}

// Pull a per-item special note / modifiers off an item object. Covers a free-
// text note field and modifier/option lists (e.g. "no onions", "extra cheese").
function itemNote(it) {
  const parts = [];
  const direct = it.note || it.notes || it.special || it.special_instructions
    || it.instructions || it.comment;
  if (direct && typeof direct !== 'object') parts.push(String(direct).trim());

  const mods = it.modifiers || it.options || it.extras || it.addons || it.add_ons;
  if (Array.isArray(mods) && mods.length) {
    parts.push(mods.map(m => (m && typeof m === 'object')
      ? (m.name || m.label || m.value || JSON.stringify(m))
      : String(m)).join(', '));
  } else if (typeof mods === 'string' && mods.trim()) {
    parts.push(mods.trim());
  }
  return parts.filter(Boolean).join(', ');
}

// Turn an array of item objects into one display string each ("1kg Tomato",
// "2× Pizza — no onions"). Honors an optional `unit` field and per-item notes.
function formatItemLines(value) {
  return value.map(it => {
    const qty = it.quantity ?? it.qty;
    const unit = it.unit || it.units || it.measure || '';
    const name = it.name || it.item || JSON.stringify(it);
    const prefix = itemPrefix(qty, unit);
    const base = prefix ? `${prefix} ${name}` : `${name}`;
    const note = itemNote(it);
    return note ? `${base} — ${note}` : base;
  });
}

function formatValue(key, value, viewConfig, currency) {
  if (value === null || value === undefined || value === '') return null;
  const fmt = viewConfig?.formats?.[key];

  if (fmt === 'currency' || key === 'cost') {
    const n = Number(value);
    return Number.isFinite(n) ? `${currency || ''} ${n.toFixed(2)}`.trim() : String(value);
  }
  if (fmt === 'date' || fmt === 'datetime' || /_at$|date/.test(key)) {
    const d = new Date(value);
    return isNaN(d) ? String(value) : d.toLocaleDateString();
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    // Array of objects → "2× Name, ..." (single-line fallback; the card
    // renderer special-cases these into a bulleted block before calling here).
    if (isObjectList(value)) return formatItemLines(value).join(', ');
    return value.join(', ');
  }
  if (typeof value === 'object') return null; // skip nested blobs
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

/** Ordered field keys to show as lines, from the view config (minus header/internal). */
function cardFields(viewConfig) {
  const fromDetail = viewConfig?.detail_sections?.[0]?.fields;
  const list = Array.isArray(fromDetail) && fromDetail.length
    ? fromDetail
    : (Array.isArray(viewConfig?.table_columns) ? viewConfig.table_columns : []);
  return list.filter(k => !SKIP_FIELDS.has(k));
}

/**
 * @returns {{ telegramHtml, whatsappText, plainText, buttons }}
 *  buttons: [{ id, title }] for non-terminal transactions, else [].
 */
export function renderTransactionCard(txn, event, viewConfig) {
  const ev = EVENTS[event] || EVENTS.created;
  const id = txn.id ?? txn.display_index ?? '';
  const currency = txn.currency && txn.currency !== '$' ? txn.currency : (txn.currency || '');
  const service = txn.service || 'transaction';

  // Header
  const headerPlain = `${ev.emoji} ${ev.verb} ${service} · #${id}`;

  // Body lines
  const lines = []; // { label, value }
  let customer;
  const uidStr = txn.user_id != null ? String(txn.user_id).trim() : '';
  for (const k of CUSTOMER_KEYS) {
    const v = txn[k];
    if (v == null || typeof v === 'object') continue;
    const s = String(v).trim();
    // Skip empties and any value that is just the opaque session id (e.g. a
    // web `user_id` that `user_name` defaulted to) — fall through to a real
    // name like customer_name so the card still shows who ordered.
    if (s === '' || s === uidStr) continue;
    customer = s;
    break;
  }
  if (customer) lines.push({ label: 'Customer', value: customer });
  const customerNorm = customer ? customer.toLowerCase() : null;

  for (const key of cardFields(viewConfig)) {
    if (!(key in txn)) continue;
    const label = viewConfig?.labels?.[key] || prettifyKey(key);
    // Array-of-objects fields (order items, sub_transactions, …) render as a
    // bulleted block — one entry per line — instead of a cramped comma list.
    if (isObjectList(txn[key])) {
      lines.push({ label, items: formatItemLines(txn[key]) });
      continue;
    }
    const val = formatValue(key, txn[key], viewConfig, currency);
    if (val != null && String(val).trim() !== '') {
      // Value-based dedup: never repeat the customer name under another label
      // (e.g. a "Name" field holding the same value as the Customer header),
      // regardless of which key it came from.
      if (customerNorm && String(val).trim().toLowerCase() === customerNorm) continue;
      lines.push({ label, value: val });
    }
  }
  // Always surface an order-level special note, even when the view config
  // didn't list it — fulfillment instructions ("ring the bell", "no cutlery")
  // are order-critical and must not be silently dropped.
  const NOTE_KEYS = ['special_instructions', 'special_note', 'order_note', 'instructions', 'note', 'notes', 'remarks'];
  const shownKeys = new Set(cardFields(viewConfig));
  for (const nk of NOTE_KEYS) {
    if (nk in txn && !shownKeys.has(nk)) {
      const v = txn[nk];
      if (v != null && typeof v !== 'object' && String(v).trim() !== '') {
        lines.push({ label: viewConfig?.labels?.[nk] || 'Note', value: String(v).trim() });
        break; // first present note field only — avoid duplicates
      }
    }
  }

  if (event === 'cancelled' && txn.cancellation_reason) {
    lines.push({ label: 'Reason', value: String(txn.cancellation_reason) });
  }
  const when = txn.updated_at || txn.created_at;
  if (when) {
    const d = new Date(when);
    if (!isNaN(d)) lines.push({ label: 'When', value: d.toLocaleString() });
  }

  // Per-channel rendering. A line is either a `value` line or an `items`
  // block (label header followed by one bulleted entry per line).
  const renderLine = ({ label, value, items }, fmt) => {
    if (items) {
      const head = fmt.bold(`${label}:`);
      return [head, ...items.map(it => `  • ${fmt.esc(it)}`)].join('\n');
    }
    return `${fmt.bold(`${label}:`)} ${fmt.esc(value)}`;
  };
  const wa = { bold: s => `*${s}*`, esc: s => String(s) };
  const tg = { bold: s => `<b>${htmlEscape(s)}</b>`, esc: s => htmlEscape(s) };
  const pt = { bold: s => s, esc: s => String(s) };

  const whatsappText = [`${headerPlain}`, '', ...lines.map(l => renderLine(l, wa))].join('\n');
  const telegramHtml = [`${htmlEscape(headerPlain)}`, '', ...lines.map(l => renderLine(l, tg))].join('\n');
  const plainText = [`${headerPlain}`, '', ...lines.map(l => renderLine(l, pt))].join('\n');

  // Buttons (only for non-terminal transactions)
  const buttons = TERMINAL.has(txn.status)
    ? []
    : [
        { id: `txn:complete:${id}`, title: '✅ Complete' },
        { id: `txn:cancel:${id}`, title: '❌ Cancel' },
      ];

  return { telegramHtml, whatsappText, plainText, buttons };
}
