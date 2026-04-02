import fs from 'fs';
import path from 'path';

/**
 * Makes HTTP requests to connected platform APIs on behalf of the agent.
 * Automatically injects the correct auth headers based on the platform connection config.
 * Only allows requests to connected platforms (scoped by base URL).
 *
 * For media fields (image_*, audio_*, video_*, file_*), the value can be:
 * - A URL (https://...) — downloaded and attached as a file
 * - A workspace-relative path (data/products/iphone.jpg) — read from workspace
 */
export async function platformRequest(workspace, args) {
  const { url, method = 'GET', body, headers: extraHeaders = {} } = args;

  console.log('[platform_request]', method, url, body ? JSON.stringify(Object.keys(body)) : 'no body');

  if (!url) return JSON.stringify({ error: 'url is required' });

  // Find which connected platform this URL belongs to
  const platform = resolvePlatform(workspace, url);
  if (!platform) {
    return JSON.stringify({
      error: 'This URL does not match any connected platform. You can only make requests to platforms your agent is connected to.',
    });
  }

  // Build headers with platform auth
  const headers = {
    'Content-Type': 'application/json',
    ...buildAuthHeaders(platform.config),
    ...extraHeaders,
  };

  let fetchBody = undefined;
  if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
    // Check if body has fields that look like Truuze content format (text_0_1, image_0_1, etc.)
    const contentKeys = Object.keys(body).filter(k => /^(text|image|audio|video|file)_\d+_\d+$/.test(k));
    if (contentKeys.length > 0) {
      // Use FormData for Truuze content creation
      const formData = new FormData();

      for (const [key, value] of Object.entries(body)) {
        if (value === null || value === undefined) continue;

        // Check if this is a media field (not text)
        const mediaMatch = key.match(/^(image|audio|video|file)_\d+_\d+$/);
        if (mediaMatch && typeof value === 'string') {
          // Value is a URL or file path — resolve to a file blob
          try {
            console.log('[platform_request] resolving file:', key, value);
            const fileBlob = await resolveFileValue(workspace, value);
            console.log('[platform_request] resolved:', key, fileBlob.filename, 'size:', fileBlob.blob.size, 'type:', fileBlob.blob.type);
            formData.append(key, fileBlob.blob, fileBlob.filename);
          } catch (err) {
            console.error('[platform_request] file error:', key, err.message);
            return JSON.stringify({ error: `Failed to resolve file for ${key}: ${err.message}` });
          }
        } else {
          formData.append(key, String(value));
        }
      }

      fetchBody = formData;
      // Remove Content-Type so fetch sets it with boundary
      delete headers['Content-Type'];
    } else {
      fetchBody = JSON.stringify(body);
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000); // 60s for file uploads

  try {
    const resp = await fetch(url, {
      method: method.toUpperCase(),
      headers,
      body: fetchBody,
      signal: controller.signal,
    });

    const contentType = resp.headers.get('content-type') || '';
    let data;
    if (contentType.includes('application/json')) {
      data = await resp.json();
    } else {
      data = await resp.text();
    }

    console.log('[platform_request] response:', resp.status, resp.ok ? 'OK' : 'FAIL', typeof data === 'object' ? JSON.stringify(data).slice(0, 200) : String(data).slice(0, 200));

    // Truncate large responses
    const result = { status: resp.status, ok: resp.ok, data };
    const resultStr = JSON.stringify(result);
    if (resultStr.length > 8000) {
      return JSON.stringify({
        status: resp.status,
        ok: resp.ok,
        data: typeof data === 'string' ? data.slice(0, 4000) + '...(truncated)' : data,
        _note: 'Response truncated to fit context',
      });
    }
    return resultStr;
  } catch (err) {
    if (err.name === 'AbortError') {
      return JSON.stringify({ error: 'Request timed out (60s)' });
    }
    console.error('[platform_request] fetch error:', err.message);
    return JSON.stringify({ error: err.message });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Resolve a file value (URL or workspace path) to a Blob with filename.
 */
async function resolveFileValue(workspace, value) {
  if (value.startsWith('http://') || value.startsWith('https://')) {
    // Download from URL
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const resp = await fetch(value, { signal: controller.signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${value}`);

      const buffer = await resp.arrayBuffer();
      const contentType = resp.headers.get('content-type') || 'application/octet-stream';
      const filename = extractFilename(value, contentType);
      const blob = new Blob([buffer], { type: contentType });

      return { blob, filename };
    } finally {
      clearTimeout(timeout);
    }
  }

  // Treat as workspace-relative path
  let filePath = path.resolve(workspace, value);

  // Security: ensure path is within workspace
  if (!filePath.startsWith(path.resolve(workspace))) {
    throw new Error('File path must be within the workspace directory');
  }

  // If not found, try with data/ prefix (data files often store relative paths
  // like "images/photo.jpg" but the actual file is at "data/images/photo.jpg")
  if (!fs.existsSync(filePath)) {
    const dataPath = path.resolve(workspace, 'data', value);
    if (dataPath.startsWith(path.resolve(workspace)) && fs.existsSync(dataPath)) {
      filePath = dataPath;
    } else {
      throw new Error(`File not found: ${value}`);
    }
  }

  const buffer = fs.readFileSync(filePath);
  const contentType = guessMimeType(filePath);
  const filename = path.basename(filePath);
  const blob = new Blob([buffer], { type: contentType });

  return { blob, filename };
}

/**
 * Extract a filename from a URL, falling back to a generated name.
 */
function extractFilename(url, contentType) {
  try {
    const pathname = new URL(url).pathname;
    const basename = pathname.split('/').pop();
    if (basename && basename.includes('.')) return basename;
  } catch { /* fall through */ }

  // Generate from content type
  const ext = MIME_TO_EXT[contentType] || 'bin';
  return `file_${Date.now()}.${ext}`;
}

/**
 * Guess MIME type from file extension.
 */
function guessMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase().slice(1);
  return EXT_TO_MIME[ext] || 'application/octet-stream';
}

const EXT_TO_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', avi: 'video/x-msvideo',
  pdf: 'application/pdf', doc: 'application/msword', zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv', txt: 'text/plain', json: 'application/json',
};

const MIME_TO_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg',
  'video/mp4': 'mp4', 'video/webm': 'webm',
  'application/pdf': 'pdf', 'text/plain': 'txt',
};

/**
 * Find which connected platform a URL belongs to.
 */
function resolvePlatform(workspace, url) {
  const connectionsDir = path.join(workspace, '.aaas', 'connections');
  if (!fs.existsSync(connectionsDir)) return null;

  const files = fs.readdirSync(connectionsDir).filter(f => f.endsWith('.json'));
  for (const f of files) {
    const config = JSON.parse(fs.readFileSync(path.join(connectionsDir, f), 'utf-8'));
    const baseUrl = config.baseUrl;
    if (baseUrl && url.startsWith(baseUrl)) {
      return { platform: f.replace('.json', ''), config };
    }
  }
  return null;
}

/**
 * Build auth headers for a platform connection.
 */
function buildAuthHeaders(config) {
  const headers = {};
  if (config.platformApiKey) headers['X-Api-Key'] = config.platformApiKey;
  if (config.agentKey) headers['X-Agent-Key'] = config.agentKey;
  if (config.bearerToken) headers['Authorization'] = `Bearer ${config.bearerToken}`;
  return headers;
}
