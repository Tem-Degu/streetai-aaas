// ─────────────────────────────────────────────────────────────────────────────
// Lean voice-call context
//
// On a live phone call the agent's only job is to TALK: hold a short, natural
// spoken conversation, gather what it came for, and hang up. It does not *act*
// on a call — no transactions, no delegated replies, no billing. Any action
// happens afterward, in the post-call text turn, which still receives the full
// SKILL and every tool (see connectors/relay.js `_firePostCall`).
//
// So when an agent opts in with `config.voice.leanPrompt`, a voice turn is
// stripped to a tiny, fast, hard-to-garble prompt: the basics + persona + the
// call's own history, and a single tool (`end_call`) to hang up. This is the
// ONE place that decides what "a lean call turn" means — base-prompt.js, the
// context assembler (engine/index.js), and the tool registry all defer to it,
// so the behavior can't drift across files. Any agent opts in the same way, and
// new call profiles can be added here without touching the call sites.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * True when this turn should use the lean phone-call prompt: a voice turn on an
 * agent that opted in via `config.voice.leanPrompt`. Everything else — chat,
 * admin, and voice turns on agents that didn't opt in — is unaffected.
 * @param {{ channel?: string, config?: object }} o
 */
export function isLeanVoiceCall({ channel, config } = {}) {
  return channel === 'voice' && config?.voice?.leanPrompt === true;
}

/**
 * The tools a lean call may use. `end_call` hangs up. `forward_call` hands the
 * live caller to a person (warm transfer — see CALL_FORWARDING_PLAN.md Part II);
 * `connect_now` is used only on the short "brief" leg the agent places to the
 * owner during a transfer, to signal "bridge the caller in now." All three are
 * inert unless the relevant call state exists, so adding them here never changes
 * a normal call — the model simply has them available when relevant. The context
 * assembler filters the turn's tool set down to this list so a small model can't
 * wander into a tool it shouldn't touch mid-call.
 */
export const LEAN_VOICE_CALL_TOOLS = ['end_call', 'forward_call', 'connect_now'];
