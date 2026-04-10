import fs from 'fs';
import path from 'path';

/**
 * Extract file references from agent response text.
 * Returns { cleanText, files } where files is an array of { path, url, type, alt }.
 *
 * Detects:
 * - Markdown images: ![alt](path_or_url)
 * - Markdown file links: [name](path.ext)  (only known file extensions)
 * - Bare workspace paths: data/images/photo.jpg
 */
export function extractFiles(workspace, text) {
  if (!text) return { cleanText: text, files: [] };

  const files = [];
  let cleanText = text;

  // 1. Markdown images: ![alt](path_or_url)
  const mdImageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  cleanText = cleanText.replace(mdImageRegex, (match, alt, src) => {
    const file = resolveRef(workspace, src);
    if (file) {
      file.alt = alt || path.basename(src);
      files.push(file);
      return ''; // remove from text
    }
    return match; // leave unresolvable refs
  });

  // 2. Markdown links to known file types: [name](path.ext)
  const mdLinkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  cleanText = cleanText.replace(mdLinkRegex, (match, label, href) => {
    if (hasFileExtension(href)) {
      const file = resolveRef(workspace, href);
      if (file) {
        file.alt = label;
        files.push(file);
        return ''; // remove from text
      }
    }
    return match;
  });

  // 3. Bare workspace paths on their own line
  const barePathRegex = /^[ \t]*(data\/[^\s]+\.[a-zA-Z0-9]{2,5})[ \t]*$/gm;
  cleanText = cleanText.replace(barePathRegex, (match, ref) => {
    const file = resolveRef(workspace, ref);
    if (file) {
      file.alt = path.basename(ref);
      files.push(file);
      return '';
    }
    return match;
  });

  // Clean up extra blank lines left by removals
  cleanText = cleanText.replace(/\n{3,}/g, '\n\n').trim();

  return { cleanText, files };
}

/**
 * Normalize a workspace reference by stripping wrapper prefixes, query strings,
 * fragments, and URL encoding. Agents may emit paths in several shapes:
 *   - data/foo.png                            (workspace-relative)
 *   - /api/workspace/data/foo.png             (dashboard URL form)
 *   - /api/ws/<name>/workspace/data/foo.png   (hub-mode URL form)
 *   - /data/foo.png                           (leading-slash variant)
 *   - data/foo.png?v=2#hash                   (with query/fragment)
 *   - data/my%20file.png                      (URL-encoded)
 * Returns a clean workspace-relative path string.
 */
function normalizeRef(ref) {
  // Strip query string and hash fragment
  let r = ref.split('?')[0].split('#')[0];

  // URL-decode (best effort)
  try { r = decodeURIComponent(r); } catch { /* keep as-is */ }

  // Strip known wrapper prefixes
  r = r.replace(/^\/api\/ws\/[^/]+\/workspace\//, '');
  r = r.replace(/^\/api\/workspace\//, '');

  // Strip any remaining leading slash so path.resolve treats it as relative
  r = r.replace(/^\/+/, '');

  return r;
}

/**
 * Resolve a reference (URL or workspace path) to a file descriptor.
 * Returns { absPath, url, type, mimeType, filename } or null.
 */
function resolveRef(workspace, ref) {
  if (ref.startsWith('http://') || ref.startsWith('https://')) {
    const ext = extFromUrl(ref);
    return {
      url: ref,
      absPath: null,
      type: mediaType(ext),
      mimeType: EXT_TO_MIME[ext] || 'application/octet-stream',
      filename: filenameFromUrl(ref),
    };
  }

  const cleanRef = normalizeRef(ref);
  if (!cleanRef) return null;

  // Workspace-relative path
  let absPath = path.resolve(workspace, cleanRef);
  if (!absPath.startsWith(path.resolve(workspace))) return null;

  if (!fs.existsSync(absPath)) {
    // Try under data/
    const dataPath = path.resolve(workspace, 'data', cleanRef);
    if (dataPath.startsWith(path.resolve(workspace)) && fs.existsSync(dataPath)) {
      absPath = dataPath;
    } else {
      return null;
    }
  }

  const ext = path.extname(absPath).toLowerCase().slice(1);
  return {
    absPath,
    url: null,
    type: mediaType(ext),
    mimeType: EXT_TO_MIME[ext] || 'application/octet-stream',
    filename: path.basename(absPath),
  };
}

/**
 * Read a file into a Buffer. Downloads URLs, reads local files.
 */
export async function readFileBuffer(file) {
  if (file.url) {
    const resp = await fetch(file.url, { signal: AbortSignal.timeout(30_000) });
    if (!resp.ok) throw new Error(`Failed to download ${file.url}: ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
  }
  return fs.readFileSync(file.absPath);
}

function mediaType(ext) {
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return 'document';
}

function hasFileExtension(str) {
  const ext = str.split('.').pop()?.toLowerCase();
  return ext && ALL_EXTS.has(ext);
}

function extFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    return pathname.split('.').pop()?.toLowerCase() || '';
  } catch {
    return '';
  }
}

function filenameFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const name = pathname.split('/').pop();
    if (name && name.includes('.')) return name;
  } catch { /* ignore */ }
  return `file_${Date.now()}`;
}

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'aac']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'avi']);
const DOC_EXTS = new Set(['pdf', 'doc', 'docx', 'xlsx', 'csv', 'txt', 'json', 'zip']);
const ALL_EXTS = new Set([...IMAGE_EXTS, ...AUDIO_EXTS, ...VIDEO_EXTS, ...DOC_EXTS]);

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
