import { useState, useEffect, useContext, useRef } from 'react';
import { WorkspaceContext } from './useApi.js';
import { getLastSeen, setLastSeen, SEEN_EVENT } from '../utils/unseenTransactions.js';
import { playChime, bindAudioUnlock } from '../utils/notificationSound.js';
import { withBase } from '../base.js';

const POLL_MS = 15000;

// Mirrors the rewrite in useApi.js (+ hosted base) so the polling fetch hits the
// right path in hub mode without dragging useApi's full surface in.
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

// Polls /api/transactions/count every POLL_MS and returns the unseen count for
// the current workspace. Listens to SEEN_EVENT so the badge clears instantly
// when the Transactions page marks things seen — no need to wait for the
// next poll tick.
export function useUnseenTransactions() {
  const workspace = useContext(WorkspaceContext);
  const [count, setCount] = useState(0);
  const initedRef = useRef(false);
  // Last count we observed, to detect upward changes worth chiming for. Null
  // until the first tick so we never chime on initial page load — only when
  // the count rises while the dashboard is already open.
  const prevCountRef = useRef(null);

  useEffect(() => {
    initedRef.current = false;
    prevCountRef.current = null;
    let cancelled = false;
    let timerId = null;

    // Lets later chimes play: the AudioContext unlocks on the user's first
    // click/keypress anywhere in the dashboard.
    bindAudioUnlock();

    // Update the count and chime if it rose since the previous tick.
    const apply = (newCount) => {
      setCount(newCount);
      const prev = prevCountRef.current;
      if (prev !== null && newCount > prev) playChime();
      prevCountRef.current = newCount;
    };

    const tick = async () => {
      const since = getLastSeen(workspace);
      const base = since
        ? `/api/transactions/count?since=${encodeURIComponent(since)}`
        : '/api/transactions/count';
      try {
        const r = await fetch(resolveUrl(base, workspace));
        if (!r.ok) return;
        const d = await r.json();
        if (cancelled) return;
        if (!since && !initedRef.current) {
          // First visit ever for this workspace — treat all existing txns as
          // seen so the badge doesn't show a huge backlog the first time the
          // dashboard loads.
          initedRef.current = true;
          setLastSeen(workspace, d.latestAt || new Date().toISOString());
          setCount(0);
          prevCountRef.current = 0;
        } else {
          apply(d.count || 0);
        }
      } catch {
        // network blip — leave previous count, next tick will recover
      }
    };

    const onSeen = (e) => {
      if (!e?.detail || e.detail.workspace === workspace) {
        setCount(0);
        prevCountRef.current = 0;
      }
    };

    tick();
    timerId = setInterval(tick, POLL_MS);
    window.addEventListener(SEEN_EVENT, onSeen);

    return () => {
      cancelled = true;
      clearInterval(timerId);
      window.removeEventListener(SEEN_EVENT, onSeen);
    };
  }, [workspace]);

  return count;
}
