// Runtime base path for the dashboard.
//
// Normally the dashboard is served at the site root, so this is '' and nothing
// changes. When StreetAI hosts the agent and proxies its dashboard in-account
// under /agent/<slug>/, the proxy injects `window.__AGENT_BASE__ = "/agent/<slug>/"`,
// and the app prefixes its API calls + router basename with it so everything
// resolves under that subpath. Defaulting to '' keeps the normal build untouched.
export const AGENT_BASE = (typeof window !== 'undefined' && window.__AGENT_BASE__)
  ? String(window.__AGENT_BASE__).replace(/\/+$/, '')
  : '';

/** Prefix an absolute app path ('/api/...') with the runtime base. */
export function withBase(p) {
  return AGENT_BASE + p;
}
