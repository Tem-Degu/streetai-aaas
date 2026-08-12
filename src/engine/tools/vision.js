import fs from 'fs';
import path from 'path';
import { getProviderCredential } from '../../auth/credentials.js';

// Shipped fallback when neither the agent's config nor the environment names a
// vision model. Operators override this via the Settings "Vision" card
// (config.vision) or the AAAS_VISION_* env vars.
const DEFAULT_VISION = { provider: 'openai', model: 'gpt-4o-mini' };

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};
const MAX_BYTES = 18 * 1024 * 1024; // 18 MB — vision APIs reject much larger.

const DEFAULT_PROMPT =
  'Describe this image in detail. If it contains text, transcribe it faithfully.';

/**
 * `read_image` tool. Looks at an image a user sent and returns a text
 * description, so a text-only agent can "see" it. Fully additive: a separate
 * vision model does the looking; the agent's own chat model is untouched.
 *
 * Resolution (no hub special-casing):
 *   provider/model : config.vision → env (AAAS_VISION_*) → shipped default
 *   api key        : getProviderCredential (env → agent overlay → hub global)
 *
 * Returns a JSON string — { description } on success, { error } when vision
 * isn't configured or the file can't be read (the agent falls back gracefully).
 * Transient network failures throw so the caller's retry wrapper handles them.
 */
export async function readImage({ workspace, config, args }) {
  const rel = String(args?.path || '').trim();
  if (!rel) {
    return JSON.stringify({ error: 'path is required — the saved image path from the "[Attached files: …]" note.' });
  }

  // Path sandbox: only files inside this workspace may be read.
  const abs = path.resolve(workspace, rel);
  if (abs !== path.resolve(workspace) && !abs.startsWith(path.resolve(workspace) + path.sep)) {
    return JSON.stringify({ error: 'Invalid path — the image must be inside the workspace.' });
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return JSON.stringify({ error: `No image found at "${rel}". Ask the user to resend it.` });
  }

  const ext = path.extname(abs).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    return JSON.stringify({ error: `"${ext || 'that file'}" isn't a supported image — ask for a jpg, png, webp, or gif.` });
  }

  const size = fs.statSync(abs).size;
  if (size > MAX_BYTES) {
    return JSON.stringify({ error: 'That image is too large to read (over 18 MB). Ask for a smaller one.' });
  }

  // Which vision model?
  const vcfg = config?.vision || {};
  if (vcfg.enabled === false) {
    return JSON.stringify({ error: 'Vision is turned off for this agent.' });
  }
  const provider = vcfg.provider || process.env.AAAS_VISION_PROVIDER || DEFAULT_VISION.provider;
  const model = vcfg.model || process.env.AAAS_VISION_MODEL || DEFAULT_VISION.model;

  const cred = getProviderCredential(provider, workspace);
  if (!cred?.apiKey) {
    return JSON.stringify({
      error: `Vision isn't configured (no ${provider} API key). Offer the user a non-visual option instead.`,
    });
  }

  const b64 = fs.readFileSync(abs).toString('base64');
  const prompt = String(args?.question || '').trim() || DEFAULT_PROMPT;

  const description =
    provider === 'google'
      ? await describeGoogle({ model, apiKey: cred.apiKey, mime, b64, prompt })
      : await describeOpenAI({ model, cred, mime, b64, prompt });

  return JSON.stringify({ description });
}

// OpenAI + any OpenAI-compatible endpoint (openrouter, groq, azure-via-baseUrl).
async function describeOpenAI({ model, cred, mime, b64, prompt }) {
  const base = cred.baseUrl ? cred.baseUrl.replace(/\/$/, '') : 'https://api.openai.com/v1';
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cred.apiKey}` },
    body: JSON.stringify({
      model,
      max_completion_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`vision ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content?.trim() || '(no description returned)';
}

// Google Gemini vision.
async function describeGoogle({ model, apiKey, mime, b64, prompt }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: b64 } }] }],
      generationConfig: { maxOutputTokens: 1024 },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`vision ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text).filter(Boolean).join('').trim() || '(no description returned)';
}
