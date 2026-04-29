/**
 * Truuze platform skill renderer.
 *
 * The connector ships a static skill template (`truuze.skill.template.md`) that
 * documents how to operate on Truuze — escrow tools, messaging, social, kookies,
 * memory. The template has a few placeholders for variables that are specific
 * to a given owner/agent installation, filled in here:
 *
 *   - `{{agent_name}}`, `{{owner_username}}`, `{{base_url}}` — known from the
 *     connection config (no extraction needed).
 *   - `{{service_summary}}`, `{{service_offerings}}`, `{{voice_and_style}}`,
 *     `{{policies}}` — extracted from the owner's uploaded SKILL.md
 *     (`skills/aaas/SKILL.md`) via a single bounded LLM call.
 *
 * Result is written to `skills/{platform}/SKILL.md`. Extraction is cached at
 * `.aaas/cache/truuze-skill.json` keyed by a hash of the source skill, so
 * reconnects skip the LLM call and just re-render. This keeps the LLM work
 * one-shot at upload time, not per-restart.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { readText, writePlatformSkill } from '../utils/workspace.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(__dirname, 'truuze.skill.template.md');

const PLACEHOLDER_FALLBACK = {
  service_summary: '_The owner has not yet described this service. Ask them what they want you to offer before quoting any user._',
  service_offerings: '_No services defined yet. Wait for the owner to provide service tiers and pricing before creating any escrows._',
  voice_and_style: '_No voice guidance provided. Default to friendly, concise, and professional._',
  policies: '_No specific policies provided. Default to honest, refund on clearly missed scope, no refund on completed work delivered to spec._',
};

/**
 * Build and write the Truuze platform SKILL.md for this workspace.
 *
 * @param {object} opts
 * @param {string} opts.workspace - Workspace root path
 * @param {object} opts.engine - AgentEngine (for provider + agentName)
 * @param {object} opts.connection - Truuze connection config (baseUrl, ownerUsername)
 * @param {object} [opts.options] - { force: boolean } to ignore the cache
 * @returns {Promise<{ path: string, extracted: boolean, cacheHit: boolean }>}
 */
export async function buildPlatformSkill({ workspace, engine, connection, options = {} }) {
  if (!workspace) throw new Error('buildPlatformSkill: workspace required');
  const force = !!options.force;

  const template = loadTemplate();
  const userSkill = readUserSkill(workspace);

  const cachePath = getCachePath(workspace);
  const sourceHash = hashSource(userSkill);
  const cache = readCache(cachePath);

  let extracted;
  let cacheHit = false;

  if (!force && cache && cache.source_hash === sourceHash && cache.extracted) {
    extracted = cache.extracted;
    cacheHit = true;
  } else {
    extracted = await extractServiceData(engine?.provider, userSkill).catch(err => {
      console.log('[truuze-skill] extraction failed, using fallbacks:', err.message);
      return null;
    });
    if (extracted) {
      writeCache(cachePath, { source_hash: sourceHash, extracted, rendered_at: new Date().toISOString() });
    }
  }

  const vars = {
    agent_name: engine?.agentName || 'Agent',
    owner_username: connection?.ownerUsername || 'unknown',
    base_url: connection?.baseUrl || '',
    max_active_escrows: '3',
    service_summary: pickField(extracted, 'service_summary'),
    service_offerings: pickField(extracted, 'service_offerings'),
    voice_and_style: pickField(extracted, 'voice_and_style'),
    policies: pickField(extracted, 'policies'),
  };

  const rendered = render(template, vars);
  writePlatformSkill(workspace, 'truuze', rendered);

  return {
    path: path.join(workspace, 'skills', 'truuze', 'SKILL.md'),
    extracted: !!extracted,
    cacheHit,
  };
}

function loadTemplate() {
  return fs.readFileSync(TEMPLATE_PATH, 'utf-8');
}

function readUserSkill(workspace) {
  const p = path.join(workspace, 'skills', 'aaas', 'SKILL.md');
  return readText(p) || '';
}

function getCachePath(workspace) {
  return path.join(workspace, '.aaas', 'cache', 'truuze-skill.json');
}

function readCache(cachePath) {
  if (!fs.existsSync(cachePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  } catch {
    return null;
  }
}

function writeCache(cachePath, data) {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(data, null, 2));
}

function hashSource(text) {
  return crypto.createHash('sha256').update(text || '').digest('hex');
}

function pickField(extracted, key) {
  const val = extracted?.[key];
  if (typeof val === 'string' && val.trim().length > 0) return val.trim();
  return PLACEHOLDER_FALLBACK[key];
}

function render(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      return String(vars[key]);
    }
    return match;
  });
}

/**
 * One bounded LLM call. Returns `{ service_summary, service_offerings,
 * voice_and_style, policies }` or null on failure. Each field is plain
 * markdown — bullets, short paragraphs, simple tables. No code fences.
 */
async function extractServiceData(provider, userSkill) {
  if (!provider) return null;
  if (!userSkill || userSkill.trim().length < 20) return null;

  const prompt = `You are extracting service-config fields from an AI agent's SKILL.md so they can be slotted into a platform-specific skill template. Read the SKILL.md below and return a SINGLE JSON object with exactly four string fields, each containing markdown.

Fields:
1. "service_summary" — one short paragraph (1–3 sentences) describing what this agent does, written in second person ("You are…", "You provide…").
2. "service_offerings" — markdown describing the services offered. Use a table or bullet list. Include service name, what's delivered, and price (in kookies if known) for each. If pricing isn't specified, say so.
3. "voice_and_style" — markdown describing how the agent should communicate (tone, formality, personality). Bullets or a short paragraph.
4. "policies" — markdown describing policies (refunds, scope limits, what's out of scope, response time, anything similar). Bullets preferred.

Rules:
- Return ONLY the JSON object — no explanation, no code fences, no preface.
- If a field has no information in the source, use a single short sentence that begins with an underscore (e.g., "_No specific policies provided._"), but try to extract something even if implicit.
- Do not invent prices, services, or guarantees not in the source.
- Markdown values must be raw markdown strings (use \\n for newlines inside JSON strings).

SKILL.md:
${userSkill.slice(0, 12000)}`;

  const result = await provider.chat([
    { role: 'user', content: prompt },
  ], { maxTokens: 2000, temperature: 0 });

  const text = (result?.content || '').trim();
  return parseExtractionJson(text);
}

function parseExtractionJson(text) {
  if (!text) return null;
  let cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  // Tolerate a leading/trailing prose explanation by grabbing the first {...} block
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  cleaned = cleaned.slice(first, last + 1);
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    return null;
  }
  return null;
}

/**
 * Parse a Truuze provisioning SKILL.md and pull useful fields out of its
 * frontmatter. Truuze ships agents an SKILL.md whose YAML frontmatter has a
 * `metadata: { ... }` JSON blob with the API base URL, the provisioning token,
 * and the owner identity. Returns null if the file isn't a Truuze skill or has
 * no parseable metadata block.
 *
 * @param {string} content - Raw SKILL.md text
 * @returns {{apiBase: string|null, provisioningToken: string|null, ownerUsername: string|null, ownerId: string|number|null} | null}
 */
export function parseTruuzeSkill(content) {
  if (!content) return null;
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;

  const frontmatter = fmMatch[1];
  const metaMatch = frontmatter.match(/metadata:\s*(\{[\s\S]*?\})\s*$/m);
  if (!metaMatch) return null;

  try {
    const metadata = JSON.parse(metaMatch[1]);
    return {
      apiBase: metadata.api_base || null,
      provisioningToken: metadata.provisioning_token || null,
      ownerUsername: metadata.owner_username || null,
      ownerId: metadata.owner_id || null,
    };
  } catch {
    return null;
  }
}
