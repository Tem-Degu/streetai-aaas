import { readJson } from '../../utils/workspace.js';

/**
 * Call an external API extension registered in the workspace.
 */
export async function callExtension(paths, { name, method = 'GET', path: apiPath = '', data }) {
  const registry = readJson(paths.extensions);
  const extensions = registry?.extensions || (Array.isArray(registry) ? registry : []);

  const ext = extensions.find(e =>
    e.name.toLowerCase() === name.toLowerCase() ||
    e.name.toLowerCase().includes(name.toLowerCase())
  );

  if (!ext) {
    const available = extensions.map(e => e.name).join(', ');
    return JSON.stringify({ error: `Extension "${name}" not found. Available: ${available || 'none'}` });
  }

  if (ext.type !== 'api' || !ext.endpoint) {
    return JSON.stringify({
      error: `Extension "${ext.name}" is type "${ext.type}" and cannot be called via HTTP.`,
      extension: { name: ext.name, type: ext.type, address: ext.address },
    });
  }

  let url = ext.endpoint.replace(/\/$/, '') + (apiPath ? '/' + apiPath.replace(/^\//, '') : '');

  try {
    const fetchOpts = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };

    if (data && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      fetchOpts.body = JSON.stringify(data);
    }

    // Add auth if configured
    if (ext.auth?.apiKey) {
      const authType = ext.auth.type || 'bearer';

      if (authType === 'header') {
        // Custom header (e.g., X-API-Key: xxx)
        const headerName = ext.auth.header || 'X-API-Key';
        fetchOpts.headers[headerName] = ext.auth.apiKey;
      } else if (authType === 'query') {
        // Query parameter (e.g., ?key=xxx)
        const paramName = ext.auth.header || 'key';
        const sep = url.includes('?') ? '&' : '?';
        url = `${url}${sep}${paramName}=${encodeURIComponent(ext.auth.apiKey)}`;
      } else if (authType === 'basic') {
        // Basic auth (apiKey is "username:password")
        const encoded = Buffer.from(ext.auth.apiKey).toString('base64');
        fetchOpts.headers['Authorization'] = `Basic ${encoded}`;
      } else {
        // Default: Bearer token
        fetchOpts.headers['Authorization'] = `Bearer ${ext.auth.apiKey}`;
      }
    }

    // Add custom headers if configured
    if (ext.headers && typeof ext.headers === 'object') {
      for (const [key, value] of Object.entries(ext.headers)) {
        fetchOpts.headers[key] = value;
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    fetchOpts.signal = controller.signal;

    const res = await fetch(url, fetchOpts);
    clearTimeout(timeout);

    const contentType = res.headers.get('content-type') || '';
    let body;
    if (contentType.includes('json')) {
      body = await res.json();
    } else {
      body = await res.text();
    }

    return JSON.stringify({ status: res.status, ok: res.ok, data: body });
  } catch (err) {
    if (err.name === 'AbortError') {
      return JSON.stringify({ error: `Extension "${ext.name}" timed out (15s).` });
    }
    return JSON.stringify({ error: `Extension "${ext.name}" call failed: ${err.message}` });
  }
}
