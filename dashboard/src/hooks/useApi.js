import { useState, useEffect, useCallback, useContext, createContext } from 'react';

// Context for workspace-scoped API calls in hub mode
export const WorkspaceContext = createContext(null);

function resolveUrl(url, workspace) {
  // In hub mode with a workspace selected, rewrite /api/... to /api/ws/:name/...
  // But don't rewrite /api/hub/... or /api/mode
  if (workspace && url.startsWith('/api/') && !url.startsWith('/api/hub/') && !url.startsWith('/api/mode') && !url.startsWith('/api/ws/')) {
    return url.replace('/api/', `/api/ws/${workspace}/`);
  }
  return url;
}

export function useFetch(url) {
  const workspace = useContext(WorkspaceContext);
  const resolved = resolveUrl(url, workspace);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refetch = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(resolved)
      .then(r => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json();
      })
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [resolved]);

  useEffect(() => { refetch(); }, [refetch]);

  return { data, loading, error, refetch };
}

export function useResolveUrl() {
  const workspace = useContext(WorkspaceContext);
  return useCallback((url) => resolveUrl(url, workspace), [workspace]);
}

export function useApi() {
  const workspace = useContext(WorkspaceContext);

  const request = useCallback(async (url, method, body) => {
    const res = await fetch(resolveUrl(url, workspace), {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error || `${res.status} ${res.statusText}`);
    }
    return res.json();
  }, [workspace]);

  const get = useCallback(async (url) => {
    const res = await fetch(resolveUrl(url, workspace));
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  }, [workspace]);
  const put = useCallback((url, body) => request(url, 'PUT', body), [request]);
  const patch = useCallback((url, body) => request(url, 'PATCH', body), [request]);
  const post = useCallback((url, body) => request(url, 'POST', body), [request]);
  const del = useCallback((url) => request(url, 'DELETE'), [request]);

  return { get, put, patch, post, del };
}
