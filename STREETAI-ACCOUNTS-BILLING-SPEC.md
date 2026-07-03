# StreetAI — Phase 1/2 Implementation Spec (Accounts + Wallet Billing)

**Status:** implementation-ready spec. Scope: Phase 1 (accounts) + Phase 2
(prepaid wallet top-up via Stripe Checkout + Customer Portal). Phase 3 (upstream
usage metering) is explicitly **out of scope** here.

**Target:** `streetai/server/` — the gitignored Node/Express relay app
(`index.js` + the `*.js` modules beside it). Deployed separately from the npm
package, proxied by nginx to `127.0.0.1:3500`.

**Reuse mandate:** port the *patterns* proven in truuze's `kookie` Django app —
not the code (that's Django; this is Express). The five patterns we lift:

| # | truuze pattern | source | reused as |
|---|----------------|--------|-----------|
| P1 | Runtime-config credential lookup w/ env fallback | `kookie/stripe_config.py` | `server/config.js` `getConfig(name)` |
| P2 | Ledger-row-per-session, idempotent on `stripe_session_id` | `KookiePurchase` + `credit_user()` | `wallet_ledger` table + `creditWallet()` |
| P3 | Webhook signature verification, 200-on-unmatched | `StripeWebhookView` | `/billing/webhook` raw-body route |
| P4 | Stripe customer-id reuse across sessions | `_existing_customer_id()` | `accounts.stripe_customer_id` column |
| P5 | Balance/perks read on-demand, never synced | `KookieBank` / `is_subscribed()` | `accounts.wallet_balance` live read |

---

## 0. Current state we build on

- `streetai/server/index.js`: Express; `app.use(express.json())` mounted
  globally at line ~38; routes for relay/register, lead, whatsapp webhook,
  installer bundles, telnyx, webcall, chat widget.
- Storage today: **JSON file token stores** — `agents.js` (`agents.json`),
  `bundles.js` (`bundles.json`). Same shape: load-into-memory + `save()` on write.
- **No accounts, no auth, no DB, no payments.** All greenfield.

### ⚠️ The #1 Express footgun (call it out up front)
Stripe webhook signature verification needs the **raw request body**. The server
currently does `app.use(express.json())` globally, which consumes the body and
makes `constructEvent` fail with "No signatures found matching the expected
signature." **The webhook route MUST be registered with
`express.raw({ type: 'application/json' })` and MUST be mounted before — or
path-scoped around — the global JSON parser.** truuze never hit this because
Django hands you `request.body` raw; Express does not. See §6.

---

## 1. Dependencies

```bash
cd streetai/server
npm i better-sqlite3 stripe bcryptjs
```

**Email-only auth** (no Google/social). These are business customers; a single
email+password path keeps signup simple and avoids the OAuth-consent friction
and per-provider account-matching logic.

- `better-sqlite3` — synchronous, file-backed; matches the existing
  load-on-boot/save-on-write style and the plan's stated choice (already used in
  the main AaaS project for workspace SQLite).
- `stripe` — official SDK (truuze used the Python SDK; the Node SDK is the
  parallel choice; AaaS's own `src/payments/stripe.js` is a no-SDK wrapper, but
  for a server with webhooks the SDK's `webhooks.constructEvent` is worth it).
- `bcryptjs` — pure-JS bcrypt (no native build headaches on the relay host).
- nodemailer is **already** a dependency elsewhere — reuse for verification/reset.

---

## 2. Database (`server/db.js`)

Single SQLite file `server/streetai.db` (gitignored, outside web root). One
module owns the connection + schema, mirroring how `bundles.js` owns its store.

```js
// server/db.js
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, 'streetai.db'));
db.pragma('journal_mode = WAL');      // concurrent reads w/ the WS server
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  email              TEXT UNIQUE NOT NULL,
  password_hash      TEXT NOT NULL,        -- email+password only (no social)
  name               TEXT DEFAULT '',      -- business name
  business_name      TEXT DEFAULT '',
  email_verified     INTEGER DEFAULT 0,
  stripe_customer_id TEXT DEFAULT '',      -- P4: reused across all sessions
  wallet_balance     INTEGER DEFAULT 0,    -- P5: cents (USD). integer, never float
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,            -- random 32-byte hex
  account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

-- P2: one row per Stripe Checkout Session. Idempotent crediting keyed here.
CREATE TABLE IF NOT EXISTS wallet_ledger (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id         INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  stripe_session_id  TEXT UNIQUE NOT NULL,
  kind               TEXT NOT NULL DEFAULT 'topup',   -- topup | refund | adjust
  amount_cents       INTEGER NOT NULL,                -- + credit, - debit
  status             TEXT NOT NULL DEFAULT 'pending',  -- pending|completed|expired|failed
  created_at         TEXT NOT NULL,
  completed_at       TEXT
);

-- Link existing relay agents/bundles to an owning account (nullable during
-- migration so pre-account agents keep working).
CREATE TABLE IF NOT EXISTS account_agents (
  account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  slug        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (account_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_ledger_account ON wallet_ledger(account_id);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
`);

export default db;
```

**Money is integer cents, everywhere.** truuze used `DecimalField`; JS has no
decimal type, so we store cents as integers and never let a float touch a
balance. (This is exactly what Stripe's `unit_amount` already is.)

### JSON→DB migration (one-shot, dual-read safe)
- `server/migrate-stores.js` — reads `agents.json` + `bundles.json`; for each
  agent with no owner, leaves `account_agents` empty (they stay ownerless and
  functional). **Do not** force-migrate ownerless agents to a placeholder
  account — keep `agents.js`/`bundles.js` as the source of truth for the relay
  itself; the DB only *links* agents to accounts. This avoids a risky big-bang
  cutover (CONTEXT.md gotcha: live deployed tokens, 14-day expiry).
- Net effect: `agents.js` and `bundles.js` are **unchanged**; the account system
  is additive. An agent gets an owner only when a logged-in user claims it.

---

## 3. Config (`server/config.js`) — pattern P1

Mirror `stripe_config.get_stripe_value`: a settings row table with env fallback,
so keys can change without editing `.env` on the box. Minimal version — a
`config` table + env fallback:

```js
// server/config.js
import db from './db.js';
db.exec(`CREATE TABLE IF NOT EXISTS config (name TEXT PRIMARY KEY, value TEXT);`);
const get = db.prepare('SELECT value FROM config WHERE name = ?');

export function getConfig(name) {
  const row = get.get(name);
  const v = row?.value?.trim();
  return v || process.env[name] || null;   // DB-first, env fallback (P1)
}
```

Keys consumed: `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`,
`STRIPE_WEBHOOK_SECRET`, `STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL`,
`STRIPE_PORTAL_RETURN_URL`, `SESSION_SECRET`, `GOOGLE_CLIENT_ID`. Defaults to env;
admin can later override via a `config` row (no admin UI in this phase — set with
a one-liner or leave to env).

---

## 4. Auth (`server/auth.js`) — Phase 1

Email+password (bcrypt) + optional Google, httpOnly cookie sessions. Stateless
verification not needed — we store sessions in SQLite (cheap, revocable).

### Session model
- On login: generate `crypto.randomBytes(32).toString('hex')`, insert into
  `sessions` with a 30-day `expires_at`, set cookie:
  `Set-Cookie: sai_session=<token>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`.
- Middleware `requireAuth(req,res,next)` reads the cookie, looks up the session
  (and joins the account), rejects expired, attaches `req.account`.
- `optionalAuth` variant for pages that render differently when logged in.

```js
// sketch
export function requireAuth(req, res, next) {
  const token = parseCookie(req.headers.cookie)['sai_session'];
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  const row = db.prepare(`
    SELECT a.* FROM sessions s JOIN accounts a ON a.id = s.account_id
    WHERE s.token = ? AND s.expires_at > ?`).get(token, new Date().toISOString());
  if (!row) return res.status(401).json({ error: 'Session expired' });
  req.account = row;
  next();
}
```

### Endpoints (all JSON, mounted under the global `express.json()`)
| Method | Path | Body | Notes |
|--------|------|------|-------|
| POST | `/auth/signup` | `{email,password,business_name}` | bcrypt hash, send verification email, create session |
| POST | `/auth/login` | `{email,password}` | verify hash, create session |
| POST | `/auth/logout` | — | delete session row, clear cookie |
| GET  | `/auth/me` | — | `requireAuth` → `{id,email,name,email_verified,wallet_balance}` |
| POST | `/auth/verify-email` | `{token}` | flips `email_verified=1` |
| POST | `/auth/request-reset` | `{email}` | email a reset token (always 200, no user enumeration) |
| POST | `/auth/reset` | `{token,password}` | set new hash |

**Reset/verify tokens:** reuse the `bundles.js` token pattern — random hex with a
short TTL, stored in a small `auth_tokens` table (`token, account_id, kind,
expires_at`). Same load/lookup/expire shape already proven in the codebase.

**Rate limiting:** reuse the existing in-memory `Map` limiter pattern from
`index.js` (`checkRegLimit`/`checkLeadLimit`) for `/auth/login` and
`/auth/signup` (e.g. 10/hour/IP). No new dependency.

### Account dashboard (UI)
The site is static HTML. Add a minimal logged-in area:
- `streetai/account/index.html` — login/signup + a logged-in panel showing wallet
  balance, top-up buttons, "Manage billing" (portal), and the list of agents the
  account owns (`account_agents`).
- Plain `fetch()` against the `/auth/*` and `/billing/*` endpoints; redirect via
  `window.location.href` for Checkout/Portal (exactly truuze's
  `SubscriptionPage.tsx` pattern, lines 60-74).
- nginx: add `location = /account { try_files /account/index.html =404; }`
  alongside the existing `/aaas` and `/lead` blocks (CONTEXT.md §26).

---

## 5. Wallet top-up via Stripe Checkout (`server/billing.js`) — Phase 2

Direct port of `purchase_views.py`. Prepaid wallet (the plan's recommended
model, lines 60-62): customer tops up a balance; usage deducts from it later
(Phase 3). This phase only *fills* the wallet.

### Top-up amounts
Fixed packages, server-validated (truuze's `_get_packages_usd` + "package not in
list → 400"). Store in `config` as a CSV (`STREETAI_TOPUP_USD = "20,50,100,250"`)
or hardcode initially. **Never trust a client-sent amount** beyond matching it
against the allow-list — same guard as `PurchaseCheckoutView`.

### `POST /billing/topup/checkout` (requireAuth)
Port of `PurchaseCheckoutView.post`:
1. Validate `usd` ∈ allow-list → else 400.
2. `stripe = new Stripe(getConfig('STRIPE_SECRET_KEY'))`.
3. Reuse/create customer (P4): if `account.stripe_customer_id` empty, pass
   `customer_email`; Stripe auto-creates and the webhook backfills the id.
4. Create Checkout Session `mode: 'payment'` with inline `price_data`
   (no pre-created Stripe Products needed — truuze does the same, `unit_amount`
   in cents), `client_reference_id: account.id`, and `metadata` carrying
   `account_id` + `usd`.
5. **Insert the pending ledger row** (`wallet_ledger`, `status='pending'`,
   `stripe_session_id = session.id`, `amount_cents = usd*100`) — P2. The row
   exists *before* we return, so the webhook always finds it.
6. Return `{ checkout_url: session.url }`; frontend redirects.

```js
const session = await stripe.checkout.sessions.create({
  mode: 'payment',
  payment_method_types: ['card'],
  line_items: [{
    price_data: {
      currency: 'usd',
      product_data: { name: `$${usd} StreetAI wallet top-up` },
      unit_amount: usd * 100,
    },
    quantity: 1,
  }],
  success_url: getConfig('STRIPE_SUCCESS_URL'),   // .../account?topup=success
  cancel_url:  getConfig('STRIPE_CANCEL_URL'),
  client_reference_id: String(account.id),
  customer: account.stripe_customer_id || undefined,
  customer_email: account.stripe_customer_id ? undefined : account.email,
  metadata: { account_id: String(account.id), usd: String(usd) },
});
db.prepare(`INSERT INTO wallet_ledger
  (account_id, stripe_session_id, kind, amount_cents, status, created_at)
  VALUES (?,?, 'topup', ?, 'pending', ?)`)
  .run(account.id, session.id, usd * 100, new Date().toISOString());
```

### `POST /billing/portal` (requireAuth)
Port of `SubscriptionPortalView`: requires a non-empty `stripe_customer_id`
(else 400 "No billing account yet"); create `stripe.billingPortal.sessions
.create({ customer, return_url })`; return `{ portal_url }`. Gives the customer
Stripe-hosted card management + invoice history with zero UI to build (plan line
55-56).

### `GET /billing/wallet` (requireAuth) — pattern P5
Read `account.wallet_balance` live (+ recent `wallet_ledger` rows for history).
No sync job — the balance column is the source of truth, updated only by
`creditWallet()`. Mirrors `is_subscribed()`/`KookieBank` reading live state.

---

## 6. Webhook (`server/billing.js`) — pattern P2 + P3

### Mounting (the footgun fix)
Register the webhook **with a raw body parser, before/around the global JSON
parser**. Concretely, in `index.js` put this line *above* `app.use(express.json())`:

```js
import { handleStripeWebhook } from './billing.js';
app.post('/billing/webhook',
  express.raw({ type: 'application/json' }),
  handleStripeWebhook);

app.use(express.json());   // global parser stays AFTER the webhook
```

### Handler — port of `StripeWebhookView.post` + `credit_user()`
```js
export function handleStripeWebhook(req, res) {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,                              // raw Buffer — REQUIRED
      sig,
      getConfig('STRIPE_WEBHOOK_SECRET'),    // P3
    );
  } catch {
    return res.status(400).json({ error: 'Invalid signature' });
  }

  if (event.type === 'checkout.session.completed') {
    creditWallet(event.data.object.id);      // idempotent (P2)
  } else if (event.type === 'checkout.session.expired') {
    db.prepare(`UPDATE wallet_ledger SET status='expired'
                WHERE stripe_session_id=? AND status='pending'`)
      .run(event.data.object.id);
  }
  res.json({ received: true });              // 200 even on unmatched (P3)
}
```

`creditWallet` is the `credit_user()` analog — idempotent, transactional:
```js
const creditWallet = db.transaction((sessionId) => {
  const row = db.prepare(`SELECT * FROM wallet_ledger
    WHERE stripe_session_id=?`).get(sessionId);
  if (!row || row.status === 'completed') return;   // idempotency for retries
  db.prepare(`UPDATE accounts SET wallet_balance = wallet_balance + ?,
              updated_at=? WHERE id=?`)
    .run(row.amount_cents, new Date().toISOString(), row.account_id);
  db.prepare(`UPDATE wallet_ledger SET status='completed', completed_at=?
              WHERE id=?`).run(new Date().toISOString(), row.id);
  // P4 backfill: capture the Stripe customer id for portal reuse
  const sess = /* event.data.object */;
  if (sess.customer) db.prepare(`UPDATE accounts SET stripe_customer_id=?
       WHERE id=? AND (stripe_customer_id='' OR stripe_customer_id IS NULL)`)
       .run(sess.customer, row.account_id);
});
```
> better-sqlite3 `db.transaction()` wraps the whole credit atomically — the
> equivalent of truuze's `with transaction.atomic(): select_for_update()`.
> Because the process is single-node and the transaction is synchronous, there's
> no row-lock race to worry about (unlike the multi-worker Django case).

To get the customer id you need the session object, so pass `event.data.object`
into `creditWallet` rather than just the id.

### Webhook setup (ops)
- One Stripe webhook endpoint → `https://streetai.org/billing/webhook`, events:
  `checkout.session.completed`, `checkout.session.expired`. (Add
  `charge.refunded` later if/when refunds are built.)
- nginx: `location = /billing/webhook { proxy_pass http://127.0.0.1:3500;
  proxy_set_header Host $host; }` — and crucially **do not** let nginx buffer/alter
  the body; default proxy is fine since we read raw in Express.
- Set `STRIPE_*` in the relay's systemd env (same place `ADMIN_KEY` lives per
  CONTEXT.md §27), or insert `config` rows.

---

## 7. Wiring into `index.js`

Order matters. Near the top, after `loadAgents()/loadBundles()`:
```js
import './db.js';                       // opens DB + ensures schema
import { handleStripeWebhook } from './billing.js';
import { mountAuthRoutes } from './auth.js';
import { mountBillingRoutes } from './billing.js';

// 1. raw webhook BEFORE json parser
app.post('/billing/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);
// 2. global json parser (existing line)
app.use(express.json());
// 3. the rest
mountAuthRoutes(app);        // /auth/*
mountBillingRoutes(app);     // /billing/topup/checkout, /billing/portal, /billing/wallet
```

Everything else in `index.js` is untouched.

---

## 8. Security checklist (plan's "Security" risk, line 101)

- Passwords: bcrypt cost 12; never log raw passwords.
- Sessions: httpOnly + Secure + SameSite=Lax cookies; 30-day TTL; deleted on logout.
- Webhook: signature-verified (P3); raw body only.
- No user enumeration on `/auth/request-reset` (always 200).
- Rate-limit `/auth/*` and `/billing/topup/checkout` (reuse the Map limiter).
- `streetai.db` lives outside the static root (it's in `server/`, served? — **no**:
  `express.static` serves `path.join(__dirname, '..')`, i.e. the site dir, not
  `server/`. Confirm the DB file is never under a static-served path. It isn't.)
- Stripe is the card vault — we store only `stripe_customer_id` + ledger rows
  (plan line 70). No PAN ever touches our DB.
- CORS: the `/auth/*` and `/billing/*` routes must **not** get the wildcard
  `Access-Control-Allow-Origin: *` that `/a`,`/u`,`/webcall` have — cookies +
  wildcard CORS don't mix. They're same-origin (served from streetai.org), so
  leave them off the `cors` middleware entirely.

---

## 9. What this phase deliberately does NOT do

- **No usage metering / deduction** (Phase 3). The wallet only fills; nothing
  spends from it yet. `amount_cents` debits and a `usage_events` table come later.
- **No upstream reselling** (StreetAI paying Telnyx/LLM). Phase 3.
- **No subscriptions** — wallet-only for v1 (truuze's `subscription_views.py`
  remains the reference if a Premium tier is added later; the Customer Portal we
  build here already supports subscriptions if enabled).
- **No refund UI** — refunds via the Stripe dashboard initially; a
  `refund_payment`-style admin endpoint can mirror truuze's owner-gated refund
  later.
- **No multi-currency** — USD only (plan "out of scope", line 107).

---

## 10. Build order (smallest shippable steps)

1. `db.js` + `config.js` — schema boots, no behavior change. **Ship.**
2. `auth.js` + `/account` page — signup/login/me/logout. **Ship** (accounts work,
   no money).
3. Link agents: "claim this agent" flow writing `account_agents`. **Ship.**
4. `billing.js` topup checkout + **raw webhook** + `creditWallet`. Test with
   Stripe CLI (`stripe listen --forward-to localhost:3500/billing/webhook`,
   `stripe trigger checkout.session.completed`). **Ship** in test mode.
5. `/billing/portal` + wallet display on the account page. **Ship.**
6. Flip Stripe to live keys via `config`/env; register the live webhook. **Done.**

Each step is independently deployable and reversible; nothing touches the relay,
WhatsApp, voice, or installer paths.

---

## 11. Pattern-fidelity cross-reference

For the next session: every design choice here traces to a truuze file you can
re-read for the detailed edge cases.

| This spec | Re-read in truuze |
|-----------|-------------------|
| pending-row-before-redirect, idempotent credit | `kookie/purchase_views.py` `PurchaseCheckoutView` + `kookie/models.py` `KookiePurchase.credit_user()` |
| webhook verify + 200-on-unmatched + expired handling | `kookie/purchase_views.py` `StripeWebhookView` |
| customer-id reuse | `kookie/subscription_views.py` `_existing_customer_id` |
| portal session | `kookie/subscription_views.py` `SubscriptionPortalView` |
| live balance read, no sync | `accounts/subscription.py` `is_subscribed` + `kookie/models.py` `KookieBank` |
| config w/ env fallback | `kookie/stripe_config.py` `get_stripe_value` |
| frontend redirect to checkout/portal | `truuze-web/src/pages/settings/SubscriptionPage.tsx` (`window.location.href`) |
