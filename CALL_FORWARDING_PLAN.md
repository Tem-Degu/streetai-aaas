# Call Forwarding / Transfer — Implementation Plan

> **This document has TWO independent plans — don't mix them:**
> - **PART I — AMI blind/bridge transfer** (below): simplest, on today's stack, no persistent connection. Good for "connect the caller to the owner and drop." Does **not** do a spoken brief to the owner or 3-way.
> - **PART II — ARI warm/attended transfer + 3-way** (bottom of file): the "right way" for *agent calls owner → briefs them → connects the caller → exits*, and for keeping the owner on as a third party. **Fully additive: normal calls are untouched; ARI is invoked only during a forward; AudioSocket stays the audio pipe.**
>
> The two share the **same agent-facing contract** (the `forward_call` tool, marker, `onForward`, and the `POST /relay/forward` entry point) — only the **server-side transfer engine** differs. So Part I can ship first and be swapped for Part II later without touching the agent/tool, or we go straight to Part II.

---

# PART I — AMI blind / bridge transfer

**Status:** Planned (not started). Supersedes the sketch in `streetai/README.md` §"Call forwarding / transfer (planned)".
**Scope of this plan:** blind transfer of a **live inbound call** to a **number the agent supplies from its own records** (so one workspace can forward to many different owner numbers — e.g. gingerpal_assistance hosts many user accounts, each with their own `owner_contact.phone`), agent announces first, and on no-answer the caller hears a canned message then the line ends (optionally voicemail). Warm/attended + 3-way are explicitly out of scope (they need the ARI upgrade).

**Multi-tenant note:** the forward target is **not** a single per-agent config value. The agent looks up the right number for *this* caller/owner (in gingerpal_assistance: `owner_contact.phone` for the user this escalation belongs to) and passes it to `forward_call({ to })`. This mirrors `place_call`, which already takes an agent-chosen `to` and is guarded server-side. Fraud stays contained because the number comes from the agent's **own stored owner records** (never the live caller), and the relay still applies `checkOutboundPolicy` (emergency/premium deny-lists, international toggle, per-agent caps) to every forward.

**Guiding constraint (from the owner):** *do not break the working voice pipeline.* Every change below is **additive** — a new tool, a new marker branch, a new callback, a new AMI verb, a new dialplan context, a new query param, a new HTTP endpoint. No existing signature changes behavior for calls that never invoke forwarding.

**Built on proven patterns (not new invention).** The two moving parts each copy something already shipped and working:
- **The request path copies `/relay/originate`** (`place_call`): HTTP POST → auth by `slug`+`relayKey` → `checkOutboundPolicy` → AMI. Forwarding adds a sibling `POST /relay/forward`.
- **The "announce, then act" timing copies `end_call`**: tool returns a marker → `runVoiceTurn` sees it in `toolsUsed` → `onControl(...)` → the pipeline waits out the reply's audio (`playEndAt-now+400ms`) → fires the action. Forwarding reuses this exact sequence, swapping `onHangup()` for `onForward(to)`.
- **The AMI client copies `amiOriginate`**: same `net.connect` → `Login` → action → close shape; we add `Status` (find channel) + `Redirect`/`Setvar`.
No proven *transfer* exists in the tree to copy, but the skeleton above is all proven.

**Verified against the code (2026-09-21 read-through):**
- AMI user `[streetai-relay]` has `read=system,call` + `write=originate,call,system` → **`Status`, `Setvar`, `Redirect` are all permitted** (Redirect/Setvar need `call`; Status needs `system`/`call`). No `manager.conf` change.
- Outbound trunk endpoint is **`[telnyx-out]`** (`pjsip.conf`), matching `OUTBOUND_TRUNK` → Dial `PJSIP/${STREETAI_FWD}@telnyx-out`.
- `billVoiceCall(slug, durationMs)` bills **`kind:'voice'`**, per-minute (≥3s), rounded up. Reused as-is.
- The inbound bridge already has the raw UUID (`uuidFromBytes(payload)`) at the point it builds `/voice-in/<did>?ani=` — and that value **equals the dialplan's `${AUID}`** — so adding `&auid=` is one line and the AMI lookup will match.
- On-prem `voicecall.js` constructs its own `VoicePipeline` **without** `onControl`/`onForward` → the new pipeline branches stay dormant there; that path is unaffected.

---

## 1. How the current system works (verified, for context)

**Outbound (agent-placed):** `place_call` tool → `POST /relay/originate` (`streetai/server/index.js`) → `checkOutboundPolicy` (`outbound.js`) → `newCall()` mints `callId` → `amiOriginate()` (`ami.js`) dials `PJSIP/<num>@<trunk>` with `Application=AudioSocket, Data=<callId>,<bridge>`. **`callId` IS the AudioSocket UUID.** The outbound bridge (:8091) connects to `ws://relay/voice-out/<callId>`.

**Inbound (customer calls a DID):** dialplan `[streetai]` (`sbc/asterisk-stack/asterisk/extensions.conf`) packs `DID+ANI` into a 32-hex AudioSocket UUID (`AUID`) → `AudioSocket(${AUID},127.0.0.1:8092)` → router bridge (:8092) decodes DID+ANI → `ws://relay/voice-in/<DID>?ani=<ANI>` → `handleVoiceClient()` **mints a fresh `callId = 'call_'+rand`** (server-side; **Asterisk never sees it**).

**Media + control:** the relay multiplexes over the agent's existing socket. Agent → relay control messages already in use: `voice:media`, `voice:clear`, `voice:end` (handled in `relay.js`). Relay → agent: `voice:start`, `voice:media`, `voice:stop`.

**Agent tool → hangup path:** `end_call` returns marker `{ending:true}` → `runVoiceTurn` (`connectors/telnyx.js`) detects it in `result.toolsUsed` → calls `onControl({hangup:true})` → `voice-pipeline.js` sets `_pendingHangup` → after the reply's TTS finishes it waits `playEndAt - now + 400ms` → `onHangup()` → connector `send('voice:end')` + teardown. **`onControl` is currently passed only for `direction==='outbound'`.**

**Lean voice:** `voice-profile.js` `LEAN_VOICE_CALL_TOOLS = ['end_call']`; `engine/index.js` filters the tool list to that set on `channel==='voice'` calls. **A new call tool must be added to this array or it won't be available mid-call.**

**Billing:** `handleVoiceClient` bills the `/voice` line per-minute via `billVoiceCall(slug, duration)` on socket close (`voice-billing.js`).

---

## 2. The crux: mapping a live `callId` → Asterisk channel

To transfer, we must break the caller out of the AudioSocket app and bridge them to a freshly-dialed leg — which requires the caller's **Asterisk channel name**. Today:
- The **bridge** only ever receives the AudioSocket **UUID** (T_UUID frame) — never the channel name.
- **Inbound** `callId` is minted server-side and unknown to Asterisk.
- So the **only value that can link the relay's call to an Asterisk channel is the AudioSocket UUID**, and the lookup must be done via **AMI by a channel variable**.

**Solution (additive):** tag every call's channel with a variable equal to its AudioSocket UUID, and make the relay know that UUID for the live call.

| | AudioSocket UUID | Channel tag | Relay learns UUID via |
|---|---|---|---|
| Inbound | `AUID` (packed DID+ANI, computed in dialplan) | `Set(STREETAI_AUID=${AUID})` before `AudioSocket(...)` | new `&auid=<uuid>` query param the bridge adds to `/voice-in` |
| Outbound | `callId` | `Variable: STREETAI_AUID=<callId>` added to the AMI Originate | already known (`callId==AUID`, in the `outbound.js` registry) |

> **Uniqueness caveat (accepted for MVP):** the inbound `AUID` is `DID+ANI`, so two *concurrent* calls from the same number to the same DID would share a tag. That collision is rare; document it. The clean fix (unique per-call id / channel object in hand) is the **ARI upgrade** already flagged for routing-at-scale — migrate forwarding onto ARI then.

---

## 3. End-to-end forward flow (blind, inbound)

1. Mid-call the agent decides to hand off → looks up the target number for *this* owner from its own records → calls **`forward_call({ to })`**. Its spoken reply that turn IS the announcement ("Let me connect you to a person, one moment…").
2. Tool returns marker `{forwarding:true, to}`. `runVoiceTurn` finds it in `toolsUsed` (which carries `{name, arguments}`, verified) → `onControl({ forward: { to } })`.
3. Pipeline sets `_pendingForward = { to }`; after the reply's TTS finishes (reuse the `end_call` wait: `playEndAt-now+400ms`) → `onForward(to)`.
4. Connector `onForward(to)` → **`POST {relayBase}/relay/forward { slug, relayKey, callId, to }`** — exactly how `place_call` calls `/relay/originate` (the connector owns the live `callId` and relay creds; `to` is the agent-supplied number threaded from the tool call).
5. Relay server `POST /relay/forward` (sibling of `/relay/originate`): auth `slug`+`relayKey` → resolve `callId → auid` (stored at call start) → `checkOutboundPolicy(to, …)` (deny-lists/intl/caps apply to every forward) → AMI: **find channel where `STREETAI_AUID==auid`** (via `Status` with `Variables: STREETAI_AUID`), `Setvar` `STREETAI_FWD=<normalized to>` **and** `STREETAI_SLUG=<slug>` on it, then **`Redirect`** it to the `[streetai-forward]` context → on success `recordOutbound({slug,to})`. Returns `{ok:true}` / `{error}` like `/relay/originate`.
6. The agent's `/voice` leg tears down (its socket closes → normal `cleanup` → `billVoiceCall` bills the agent-leg minutes). The caller is now in `[streetai-forward]`.
7. `[streetai-forward]`: `Dial(PJSIP/${STREETAI_FWD}@<trunk>, 30)`.
   - **On answer** → caller ↔ owner talk (trunk leg — this is the forwarded-call cost). When either hangs up, the dialplan continues, `${ANSWEREDTIME}` now holds the billable talk seconds → **report it for billing** (see §5), then `Hangup()`.
   - **On no-answer/busy/failure** (`${DIALSTATUS}` ≠ `ANSWER`, so `${ANSWEREDTIME}=0`) → `Playback(streetai-unavailable)` (canned message) → `Hangup()` *(v1)*, or `VoiceMail(...)` then `Hangup()` *(v1.1)*.

**Announce-before-drop** is satisfied by step 1–3 (the agent speaks, audio finishes, *then* the redirect fires — same ordering guarantee as `end_call`). **No-answer** is handled entirely in the dialplan (step 7) because, in a blind transfer, the agent is already gone — the AI cannot narrate the failure (that would need ARI). This matches the accepted design.

---

## 4. Exact changes (all additive)

### Base image — `src/` (rides a version tag + redeploy)
1. **`engine/tools/index.js`** — add `forward_call` tool def + handler. Def takes a **required `to`** (phone number, `+country` format) and describes it as "hand the current caller to a person you have on file (e.g. the owner) — supply their number." Handler gates on `config.voice.outbound?.enabled`; returns `{ ok:true, forwarding:true, to, note:'Say your handoff line now; I connect them after it plays.' }`, else a friendly "forwarding/outbound isn't enabled" error. The number is the **agent's own** (looked up from its records), not the live caller's — the SKILL guides that.
2. **`connectors/telnyx.js` `runVoiceTurn`** — after the existing `end_call` check, add: find `forward_call` in `toolsUsed` and read its `.arguments.to`; if present → `onControl({ forward: { to } })`. (The Telnyx path passes no `onControl` → unchanged.)
3. **`engine/voice-pipeline.js`** —
   - constructor: accept `onForward` (optional).
   - `onControl`: **always pass it** (not just outbound), but keep `c.hangup` guarded to `direction==='outbound'` (unchanged); add `if (c.forward) this._pendingForward = c.forward; // { to }`.
   - after the TTS block (mirror the `_pendingHangup` block): if `_pendingForward && myTurn===turnId && this.onForward` → wait `playEndAt-now+400ms` → `onForward(this._pendingForward.to)`.
4. **`engine/voice-profile.js`** — add `'forward_call'` to `LEAN_VOICE_CALL_TOOLS`.
5. **`connectors/relay.js` `_handleVoiceStart`** — build the pipeline with `onForward: (to) => forwardCall(callId, to)`, where `forwardCall` POSTs `{ slug, relayKey, callId, to }` to `{relayBase}/relay/forward` (same credential/URL plumbing `placeCall` already uses). Connector owns `callId`; `to` comes from the tool call.
6. **Config schema** — no new required field. `forward_call` is gated by the existing `config.voice.outbound.enabled` toggle (same switch that governs `place_call`), since a forward is an agent-placed outbound leg. *(Optional convenience for single-number agents: allow `to` to default from a config value when omitted — not needed for the multi-tenant case.)*

> `engine/index.js` needs **no change** — the lean filter already reads `LEAN_VOICE_CALL_TOOLS`.

**Workspace (per-agent) — how the agent knows the number**
   - `gingerpal_assistance/skills/aaas/SKILL.md`: add guidance that to hand a caller to their owner, the agent first gets the owner's number via `get_owner_brief`/`find_owner_context` (it returns `owner_contact.phone`) and calls `forward_call({ to: that number })`. Never forward to a number the *caller* supplies. Deploys via `aaas publish` — no base change.

### Relay server — `streetai/server/` (rides base tag + **relay restart**)
7. **`ami.js`** — add (new functions; `amiOriginate` untouched, same connection shape):
   - `amiFindChannel(varName, value)` → `Login` → `Status` with `Variables: <varName>` → read the `Status`/`StatusComplete` events, return the `Channel` whose `Variable: <varName>` equals `value` (else null).
   - `amiRedirect({ channel, context, exten='s', priority=1, setVars })` → optional `Setvar` per var → `Redirect`.
8. **`index.js`** —
   - `handleVoiceClient` / `registerVoiceClient`: capture `auid` (from the new `/voice-in …&auid=` param; for outbound `auid=callId`) and store it so `callId→auid` is resolvable (extend the `voiceClients` entry + a small exported getter, or a `Map`).
   - **New `POST /relay/forward`** — a near-copy of `/relay/originate`: validate `slug`+`relayKey`, resolve `callId→auid`, `checkOutboundPolicy(to,…)`, `amiFindChannel('STREETAI_AUID', auid)` → `amiRedirect({ channel, context:'streetai-forward', setVars:{ STREETAI_FWD: policy.normalized, STREETAI_SLUG: slug } })`, then `recordOutbound({slug,to})`. On failure return the reason; the caller simply stays with the agent (nothing redirected).
   - **New `POST /relay/forward-billed`** (localhost-only; called by the dialplan) — `{ slug, auid, secs }` → `billVoiceCall(slug, secs*1000)` — **the same `kind:'voice'` charge as any call** (a forward is just an outbound minute). Idempotency: key on `auid` so a retry can't double-bill.

### SBC — `streetai/sbc/asterisk-stack/` (needs **asterisk-stack rebuild/restart on the host**)
9. **`asterisk/extensions.conf`** —
   - In `[streetai]`, add `same => n,Set(STREETAI_AUID=${AUID})` immediately **before** the `AudioSocket(...)` line. (Pure no-op for normal calls.)
   - Add a new context (the `Dial` returns when the leg ends; `${ANSWEREDTIME}` then holds billable talk seconds, `${DIALSTATUS}` the outcome — we report the seconds to the relay and only play the fallback if it never answered):
     ```
     [streetai-forward]
     exten => s,1,NoOp(Forwarding ${STREETAI_AUID} to ${STREETAI_FWD} for ${STREETAI_SLUG})
      same => n,Dial(PJSIP/${STREETAI_FWD}@telnyx-out,30)
      same => n,Set(SECS=${ANSWEREDTIME})            ; 0 if never answered
      same => n,Set(CURLOPT(conntimeout)=2)
      same => n,Set(~x=${CURL(http://127.0.0.1:3500/relay/forward-billed,slug=${STREETAI_SLUG}&auid=${STREETAI_AUID}&secs=${SECS})})
      same => n,GotoIf($["${DIALSTATUS}" = "ANSWER"]?done)
      same => n,Playback(streetai-unavailable)       ; canned "they're not available" prompt
      same => n(done),Hangup()
     ```
     (v1.1: before `Hangup`, on the not-answered branch, `VoiceMail(...)` to capture a message.)
     - Requires `res_curl`/`func_curl` loaded in Asterisk (the `CURL()` function). If not available, use `System(curl -s ...)` (needs `curl` in the container) — note the dependency in the SBC setup.
   - Mirror the `Set(STREETAI_AUID=…)` add into `extensions.conf.router`/`.agent` backups so a config swap doesn't lose it.
10. **`bridge/audiosocket-bridge.js`** — inbound: append `&auid=<uuid>` to the `/voice-in/<did>?ani=<ani>` URL (the bridge already has the raw UUID). Additive query param.
11. **`amiOriginate` call in `index.js` `/relay/originate`** — pass `variables: { STREETAI_AUID: callId }` (extend `amiOriginate` to emit `Variable:` lines) so outbound channels are tagged too. (Needed only when we later allow forwarding an outbound call; harmless now.)
12. **Prompt asset** — record/generate `streetai-unavailable.(gsm|wav)` and place it in Asterisk's sounds dir (or `Playback` a TTS-rendered file). One-time.

---

## 5. Billing (the forwarded leg is charged — must be tracked)

The forwarded leg is a real outbound trunk call on the agent's number, so **it costs money and must be metered** — the previous assumption ("meter just stops") was wrong. Two distinct spans:

1. **Agent-leg minutes** (caller ↔ AI, up to the redirect): billed as today by `billVoiceCall(slug, duration)` when the `/voice` socket closes at redirect. **No change.**
2. **Forwarded-leg minutes** (caller ↔ owner over the trunk, after redirect): the agent's `/voice` socket is gone, so the relay can't time this leg itself. **The dialplan reports it:** after `Dial()` returns, `${ANSWEREDTIME}` is the billable talk seconds; `[streetai-forward]` `CURL()`s `POST /relay/forward-billed { slug, auid, secs }`, and the relay charges that slug via `billVoiceCall` — **the same `kind:'voice'` per-minute charge as a normal call** (a forward is just another outbound call minute). No-answer → `secs=0` → no charge.

**Why this mechanism** (not a persistent AMI listener or CDR reader): the seconds are already computed by Asterisk at the end of the `Dial`, and the dialplan is the one place that reliably sees the leg's full lifetime after we've handed off. One `CURL` per forward, idempotent on `auid`.

**Who is charged:** the relay bills the **agent's slug** (the account that owns the trunk/number), exactly like `place_call`/voice minutes. For a multi-tenant workspace that wants to attribute the cost to the specific end-user it forwarded for, that split is a **workspace-level** accounting concern — the agent knows which user's number it dialed and can log it; the relay-level charge stays per-slug.

**Guardrail interaction:** because a forward is an outbound leg, it also counts against the agent's outbound **caps/cooldown** via `recordOutbound()` — call it on a successful redirect so forwards can't be used to dodge the daily limit.

---

## 5a. Dependency: how the agent knows *which* number to forward to (workspace, gingerpal)

The base feature just needs a `to`. But for a **multi-tenant** agent (one gingerpal_assistance serving many owners), the agent must resolve *this caller → the right owner → that owner's `owner_contact.phone`*. **Verified gap:** today `resolveOwnerFromEvent` (escalation.js) resolves an owner from a phone event by matching **the caller's** number against `owner_contact.phone` — so it identifies a call **from an owner**, not **which owner a customer is trying to reach**. On a customer call, it returns "not a set-up owner." So there is currently **no** call→owner mapping for the forwarding case.

Resolving this is a **workspace design decision** (not a blocker for the base feature). Options:
- **Per-owner inbound DID (recommended):** each owner has their own phone number pointing at the agent; the agent maps the **dialed DID → owner**. Needs a **small additive base change**: pass the dialed DID to the agent (the server knows it in `/voice-in/<did>`; today only the *caller's* ANI reaches the agent). Then a workspace tool resolves owner-by-DID and the SKILL calls `forward_call({ to: that owner's phone })`.
- **Ask-and-look-up:** the agent asks who/what business the caller wants and looks the owner up by name; no base change, weaker UX.
- **Single-owner agents:** if an agent instance serves one owner, forward straight to that owner's number — trivial, works today.

Until one of these is chosen for gingerpal, forwarding is fully functional for **single-owner** agents and for **owner-initiated** calls; multi-tenant customer→owner routing is pending this decision.

## 6. Why this can't break the working pipeline

- **Every touchpoint is additive:** new tool, new `onControl` branch, new pipeline callback, new AMI verbs (`amiOriginate` untouched), new dialplan context, new query param, new HTTP endpoints (`/relay/forward`, `/relay/forward-billed`). Existing `place_call`/`end_call`/`/relay/originate`/media/hangup paths are byte-for-byte unchanged.
- **Relay connector gains `onControl` for inbound** (previously outbound-only), but the `hangup` branch stays gated to `direction==='outbound'`; only `forward` is newly active on inbound. A call that never invokes `forward_call` sees no behavioral change (marker never fires).
- **On-prem `voicecall.js` is untouched** — it builds its own `VoicePipeline` without `onControl`/`onForward`, so the new branches are dormant there (verified).
- **`forward_call` is inert unless enabled:** with `config.voice.outbound.enabled` off the tool returns "not enabled" and does nothing; and even when on, nothing happens unless the model calls it.
- **Dialplan edits are no-ops** for normal calls: `Set(STREETAI_AUID=…)` just sets a variable; `[streetai-forward]` is only reached via an explicit `Redirect`.
- **AMI is unchanged for existing use** — `amiOriginate` keeps its signature; `amiFindChannel`/`amiRedirect` are new functions; permissions already allow them (verified).

---

## 7. Deploy order & testing

**Deploy (three independent surfaces):**
1. Base image (`src/*`) → version tag → GitHub Action → `aaas update-image --redeploy`.
2. Relay server (`streetai/server/*`) → **restart the relay** (it wasn't restarted for the last change — this one requires it, since `index.js`/`ami.js`/`relay.js` change).
3. SBC (`extensions.conf`, `audiosocket-bridge.js`, sound file) → **rebuild/restart the asterisk-stack containers on the host** (`docker compose up --build -d`).
4. Ensure the test agent has **outbound calling enabled** (`config.voice.outbound.enabled`), and publish the workspace SKILL guidance so the agent forwards to a number from its own records (e.g. `owner_contact.phone`). No dedicated forward-number config needed.

**Test on the box (read/observe only until the redeploy):**
- Unit: `checkOutboundPolicy` on the forward number; `amiFindChannel('STREETAI_AUID', auid)` against a live inbound channel (verify it returns the right `PJSIP/...` name — this is the single riskiest new piece, test it first).
- Integration: inbound call → agent → `forward_call` → confirm the agent's "connecting you" line plays fully, **then** the caller rings the owner.
- No-answer: let the owner leg time out → caller hears `streetai-unavailable` → line ends (or voicemail in v1.1).
- Regression: a normal inbound call and a normal outbound `place_call`/`end_call` behave exactly as before (no forward tag/branch fires).

---

## 8. Effort & sequencing

- **Base-image tool + pipeline plumbing** (items 1–6): ~0.5–1 day.
- **Relay `voice:forward` + AMI find-by-var/redirect** (items 7–8): ~1 day (the AMI channel lookup is the fiddliest part).
- **SBC dialplan + bridge param + prompt** (items 9–12): ~0.5 day + host redeploy.
- **Integration + telephony testing on the box:** ~0.5–1 day (telephony is always fiddly).

**Total: ~3–4 focused days** for blind-transfer-to-owner with a canned no-answer message. Voicemail fallback (v1.1) is ~+0.5 day. The "caller returns to the AI on no-answer" experience is **not** in this plan — it requires the **ARI upgrade** (1–2+ weeks), which would also unlock warm/attended transfer and 3-way.

---

## 9. Open decisions (defaults chosen; change if desired)
- **Forward target source:** agent-supplied `to` via `forward_call({ to })`, looked up from the agent's own records (gingerpal_assistance: `owner_contact.phone` for the relevant user). Multi-tenant by design. Server guardrails + caps still apply. **This is the chosen model** (per your note).
- **No-answer fallback:** v1 = canned message + hang up. v1.1 = voicemail to the owner. **Recommend v1.1.**
- **Forwarded-leg billing:** dialplan reports `${ANSWEREDTIME}` to `/relay/forward-billed`; relay bills the slug via `billVoiceCall` as **`kind:'voice'`** — identical to any other outbound call minute (decided). No separate line item.
- **Cost attribution in multi-tenant workspaces:** relay bills the agent slug; per-end-user split (if wanted) is logged workspace-side by the agent. Confirm that's acceptable, or we add a `userRef` passthrough on `/relay/forward-billed` for per-user metering later.
- **Outbound forwarding:** covered by the same tagging (item 11) but not a v1 use case; leave the tool inbound-focused first.

---
---

# PART II — ARI Warm/Attended Transfer + 3-way (the "right way")

**Status:** **Implemented 2026-09-21** (code in tree; not yet deployed/telephony-tested). Files changed/added:
- Base image: `src/engine/voice-profile.js` (`forward_call`/`connect_now` in `LEAN_VOICE_CALL_TOOLS`), `src/engine/tools/index.js` (`forward_call`/`connect_now` tool defs + marker handlers), `src/connectors/telnyx.js` (`onControl` forward/connect), `src/engine/voice-pipeline.js` (`onForward`/`onConnect` + post-audio fire), `src/connectors/relay.js` (`onForward`/`onConnect` → `_postRelay`).
- Relay server: `streetai/server/ari.js` (NEW — ARI client + `warmTransfer`/`warmConnect`), `streetai/server/ami.js` (`amiFindChannel`, `amiRedirect`, `amiOriginate` `variables`), `streetai/server/index.js` (`/relay/forward`, `/relay/connect`, `callId→auid`, `startAri()`).
- SBC: `extensions.conf` (`Set(STREETAI_AUID)` + `[streetai-stasis]` + `[streetai-resume]`), `bridge/audiosocket-bridge.js` (`&auid=`), NEW `http.conf` + `ari.conf`, `asterisk/Dockerfile` (COPY both).
- **Return-to-AI on no-answer is included:** on timeout/dial-failure the held caller is redirected to `[streetai-resume]` (back into the AI's AudioSocket, same session by caller number), and the relay flags it (`takeResume` → `voice:start.resume` → connector `resumeNote` → the pipeline opens with an apology instead of a greeting). So a missed transfer never drops the caller; the AI is explicitly told the person couldn't be reached.
- **Verified:** all files syntax-check; AMI find/redirect/originate-with-vars tested against a fake AMI server (7/7). **NOT yet verified:** live ARI/Stasis behavior, the hold→brief→bridge choreography, concurrent brief leg — these need the on-box steps in B9.
- **Required env on the relay host** (set alongside the existing `AMI_*`/`OUTBOUND_*`): `ARI_USER=streetai-relay`, `ARI_PASSWORD=<matches ari.conf password>`, `ARI_URL=http://127.0.0.1:8088` (default). `ari.conf`'s `password` **must be changed from `CHANGE_ME_ARI_SECRET`** and kept in sync. Without these, `isAriEnabled()` is false → `/relay/forward` returns 503 and normal calls are unaffected.

This is the **preferred engine** for the required behavior: *the agent calls the owner, briefs them about the caller, connects the caller, and exits* — and it also supports keeping the owner on as a **third party**. It replaces Part I's server-side transfer engine; the agent-facing contract is identical.

**Hard requirement honored from the owner:** *do not touch the working voice pipeline.* This design is **strictly additive**:
- **Normal calls never enter ARI.** They keep running exactly as today: dialplan `[streetai]` → `AudioSocket()` → bridge → relay. Zero change to that path.
- **ARI is invoked only when a forward happens** — at that moment the relay pulls *just that one call's* channel into a Stasis app. A call that never forwards never sees ARI.
- **AudioSocket stays the AI's audio pipe** end to end. ARI is used **only for call control** (hold, originate, bridge, drop) — we do **NOT** use ARI "external media", so the codec/latency work we hardened is untouched. This is the single most important risk-avoidance decision in Part II.

## B0. Prerequisites (config-only; checked against the build)
The image is stock Ubuntu 22.04 **Asterisk 18** with `modules.conf autoload=yes`, so `res_ari*`, `res_stasis*`, `res_http_websocket` ship and autoload — **no source rebuild**. We only enable them:
- **`http.conf`** — enable Asterisk's HTTP server bound to localhost (ARI rides on it). ~5 lines.
- **`ari.conf`** — one ARI user + password (localhost only), like `manager.conf` for AMI. ~8 lines.
- **`docker-compose.yml`** — the relay already runs alongside Asterisk on the host, so it reaches ARI on `127.0.0.1:8088` with no new public port. Keep the ARI port localhost-only (never public), same posture as AMI 5038.
- Verify at deploy: `asterisk -rx "module show like res_ari"` and `... res_stasis` show loaded.

## B1. Shared front half — IDENTICAL to Part I (base image, no divergence)
Reuse verbatim from Part I section 4 items 1-6:
- `forward_call({ to })` tool + marker `{forwarding:true, to}`
- `runVoiceTurn` sets `onControl({ forward:{ to } })`
- pipeline `_pendingForward` then, after the announce audio finishes, `onForward(to)`
- connector `onForward(to)` does `POST /relay/forward { slug, relayKey, callId, to }`
- `forward_call` added to `LEAN_VOICE_CALL_TOOLS`

**The ONLY thing that differs from Part I is what `POST /relay/forward` does on the server.** So if Part I ships first, moving to Part II changes server code only — the agent, tool, pipeline, and workspace SKILL are unchanged.

## B2. Asterisk dialplan (additive — existing contexts untouched)
- `[streetai]` inbound context: **unchanged** (still `Set(STREETAI_AUID=...)` + `AudioSocket(...)` as in Part I item 9). Normal calls still go straight to AudioSocket.
- Add ONE tiny context used *only* as the on-ramp into Stasis when we redirect a call there:
  ```
  [streetai-stasis]
  exten => s,1,Stasis(streetai-transfer,${STREETAI_AUID},${STREETAI_FWD},${STREETAI_SLUG})
   same => n,Hangup()
  ```
  Nothing reaches this context except an explicit AMI/ARI `Redirect` during a forward.

## B3. New relay module `streetai/server/ari.js` (net-new; nothing imports it unless forwarding)
- Opens a **persistent ARI WebSocket** to `ws://127.0.0.1:8088/ari/events?app=streetai-transfer` plus a small REST helper for `/ari/*` calls, with reconnect/backoff. Registered at relay startup.
- **Isolation guarantee:** this app only ever receives events for channels we deliberately push into Stasis. If the ARI socket is down, *forwards* fail gracefully (caller simply stays with the AI); **normal calls are unaffected** because they never use ARI.
- Exposes `warmTransfer({ callerChannel, to, slug, context })` used by `/relay/forward`.

## B4. `POST /relay/forward` — ARI engine (replaces Part I's AMI-redirect body)
Auth + `callId->auid` + `checkOutboundPolicy(to)` are identical to Part I. Then, instead of a blind AMI redirect:
1. **Find the caller channel** (AMI `Status` by `STREETAI_AUID==auid`, as Part I) and **redirect it into Stasis**: AMI `Redirect` to `[streetai-stasis]` with `STREETAI_FWD`/`STREETAI_SLUG` set. The caller leaves AudioSocket (its AI leg ends and is billed as today); ARI now owns the caller channel.
2. **Hold the caller:** ARI creates a `holding` bridge, adds the caller, starts **Music-on-Hold** (`POST /bridges/{id}/moh`). The caller hears hold music while the AI briefs the owner.
3. **Brief the owner (live AI leg — reuses the proven escalation path):** originate the owner exactly like the escalation flow already does (`/relay/originate` -> outbound AudioSocket -> the agent's voice pipeline) **with the caller's request injected as context** (the same pending-call context mechanism escalation.js already uses). The owner-leg AI speaks the brief ("Hi, I have <caller> on the line about <X> — connecting you now"), and can even answer a quick question from the owner.
4. **Connect:** when the brief is done the owner-leg AI calls a lightweight signal (`connect_now`, or reuse `end_call` as the "bridge now" trigger on a brief leg). The relay then **adds the owner channel to the caller's bridge** (ARI `POST /bridges/{id}/addChannel`), stops MOH, and **drops both AI legs** (their AudioSocket sockets close). Caller <-> owner now talk directly; the AI has exited. *(For a **3-way**, simply leave the AI leg in the bridge instead of dropping it — ARI makes this a one-line difference.)*
5. **No-answer / owner declines:** the caller is still held in the ARI bridge, so we have real choices (unlike blind): **return them to the AI** — originate a fresh AI AudioSocket leg into the bridge (the caller's session resumes; inbound sessions are keyed by caller number) and tell it "the owner did not pick up" — or play a message and hang up. This is the clean solution to the no-answer problem that motivated warm transfer.
6. Return `{ok:true}` / `{error}` like `/relay/originate`.

## B5. Billing (same `kind:'voice'`, cleaner than Part I)
- **Caller<->AI leg** (before forward): billed as today when its AudioSocket socket closes at the redirect.
- **Owner brief leg** (AI<->owner via AudioSocket): billed by the existing `/voice-out` close path — it *is* a normal outbound call.
- **Caller<->owner bridged span:** because ARI holds both channels, the relay knows exactly when the bridge starts and ends (ARI `BridgeEnter`/`ChannelLeftBridge`/`StasisEnd` events) -> time it and `billVoiceCall(slug, ms)` as **`kind:'voice'`**. No dialplan `CURL` needed (that was a Part I workaround); ARI gives us the timing directly. Idempotent per channel.

## B6. Why this is safe for the existing pipeline (the additive guarantees)
- **Normal calls never touch ARI or the new dialplan context** — only an explicit redirect during a forward sends a channel in. If ARI is disabled/broken, everything except forwarding works exactly as now.
- **AudioSocket is unchanged** — the AI's audio (caller conversation *and* owner brief) still flows over the same proven pipe. ARI does control only; **no external-media re-plumbing**, so the codec/latency/gibberish work is not at risk.
- **`amiOriginate` and existing endpoints are unchanged**; `ari.js` is a new module; `/relay/forward` is a new endpoint.
- **AMI permissions already suffice** for the one AMI action we still use (`Redirect` needs `call`, which the relay user has). ARI has its own auth via `ari.conf`.

## B7. Risks specific to ARI (honest, and how we contain them)
- **New persistent connection to babysit.** The ARI event WS must stay up + reconnect; on relay restart, in-flight Stasis channels can be orphaned -> add a reconnect-time sweep that hangs up / continues any stale `streetai-transfer` channels. (Normal calls are unaffected by this — they are not in Stasis.)
- **Two-leg choreography has races** (hold -> brief -> bridge -> drop). ARI's channels-in-hand model makes this far more tractable than AMI, but it still needs careful state handling + timeouts (owner never answers, caller hangs up mid-brief, AI leg dies).
- **Concurrent AI sessions:** the brief uses a *second* live voice session for the same agent (caller leg + owner leg). Confirm the engine handles two concurrent voice calls cleanly (separate `callId`/pipeline — it should; escalation already places a second call, though not simultaneously with an active inbound leg). **Verify on a test agent.**
- **Module presence:** confirm `res_ari`/`res_stasis`/`res_http_websocket` load (they should, autoload).

## B8. Effort (rough)
- Asterisk config (`http.conf`, `ari.conf`, one dialplan context, compose): **~50 lines**, one-time.
- `ari.js` (connection + REST + lifecycle + warmTransfer choreography + cleanup): **~500-800 lines** (a working spike ~300).
- `/relay/forward` ARI variant + `connect_now` signal + billing hooks + wiring: **~150-250 lines**.
- **~2 weeks incl. telephony testing.** Riskiest pieces to prove first: (a) redirect-into-Stasis keeps the caller alive and holdable; (b) the second concurrent AI (brief) leg; (c) add-to-bridge + drop timing.

## B9. Recommended sequencing to protect the working system
1. **Enable ARI (config only) and prove a no-op Stasis** on a **test agent**: redirect a live call into `[streetai-stasis]`, hold with MOH, then return it to AudioSocket — verify the caller's audio survives the round trip. This validates the whole additive premise before writing transfer logic.
2. Build `warmTransfer` incrementally: hold -> brief (reuse escalation originate) -> bridge -> drop.
3. Add no-answer return-to-AI and 3-way (leave-AI-in-bridge) as the last, small increments.
4. Keep Part I's blind path available as a fallback if a given deployment cannot run ARI.
