import { useState, useEffect, useContext } from 'react';
import { WorkspaceContext } from './useApi.js';
import { withBase } from '../base.js';

const POLL_MS = 20000;

// Mirror useApi's hub-mode rewrite (+ hosted base) without dragging its full surface in.
function resolveUrl(url, workspace) {
  let out = url;
  if (
    workspace &&
    url.startsWith('/api/') &&
    !url.startsWith('/api/hub/') &&
    !url.startsWith('/api/mode') &&
    !url.startsWith('/api/ws/')
  ) {
    out = url.replace('/api/', `/api/ws/${workspace}/`);
  }
  return url.startsWith('/api/') ? withBase(out) : out;
}

/**
 * Polls /deploy/status and reduces it to a single agent-health state:
 *   'online'       — at least one connector connected (or a daemon is running)
 *   'reconnecting' — a connector is mid-retry (still trying to recover)
 *   'error'        — a connector failed and gave up (beyond repair)
 *   'stopped'      — nothing running
 *   'unknown'      — not yet polled / status unavailable
 *
 * Returns { state, errored: [{platform, error}], platforms }.
 */
export function useAgentHealth() {
  const workspace = useContext(WorkspaceContext);
  const [health, setHealth] = useState({ state: 'unknown', errored: [], platforms: [] });

  useEffect(() => {
    let cancelled = false;
    let timer = null;
    const isUp = (s) => s === 'connected' || s === 'daemon' || s === 'cli' || s === 'cli-managed';

    const tick = async () => {
      try {
        const r = await fetch(resolveUrl('/api/deploy/status', workspace));
        if (!r.ok || cancelled) return;
        const d = await r.json();
        const platforms = d.platforms || [];
        const errored = platforms.filter(p => p.status === 'error');

        let state;
        if (errored.length) state = 'error';
        else if (platforms.some(p => p.status === 'reconnecting')) state = 'reconnecting';
        else if (d.daemonRunning || platforms.some(p => isUp(p.status))) state = 'online';
        else state = 'stopped';

        if (!cancelled) {
          setHealth({
            state,
            errored: errored.map(p => ({ platform: p.platform, error: p.error })),
            platforms,
          });
        }
      } catch {
        // network blip — keep the last known state, next tick recovers
      }
    };

    tick();
    timer = setInterval(tick, POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [workspace]);

  return health;
}
