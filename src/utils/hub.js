import fs from 'fs';
import path from 'path';
import { readJson, writeJson, readText, listFiles } from './workspace.js';
import { registerWorkspace } from './registry.js';

/**
 * A "hub" is a directory that contains one or more AaaS agent workspaces
 * as immediate subdirectories. It is marked by `.aaas/config.json` at the
 * hub root (same file workspaces use, but the hub itself is NOT a workspace
 * — it does not contain `skills/aaas/SKILL.md`).
 */

function isWorkspaceDir(dir) {
  return fs.existsSync(path.join(dir, 'skills', 'aaas', 'SKILL.md'));
}

function isHubDir(dir) {
  return (
    fs.existsSync(path.join(dir, '.aaas', 'config.json')) &&
    !isWorkspaceDir(dir)
  );
}

/**
 * Resolve the hub directory, in order:
 *   1. explicit --hub flag
 *   2. $AAAS_HUB env var
 *   3. walk up from cwd for the first non-workspace dir that has .aaas/config.json
 *   4. if cwd is a workspace, use its parent if it qualifies as a hub
 */
export function findHub(explicit, startDir = process.cwd()) {
  if (explicit) {
    const abs = path.resolve(explicit);
    return fs.existsSync(abs) ? abs : null;
  }
  if (process.env.AAAS_HUB) {
    const abs = path.resolve(process.env.AAAS_HUB);
    if (fs.existsSync(abs)) return abs;
  }

  let current = path.resolve(startDir);
  const root = path.parse(current).root;
  while (current !== root) {
    if (isHubDir(current)) return current;
    current = path.dirname(current);
  }

  // Fallback: if cwd is a workspace, try its parent
  if (isWorkspaceDir(path.resolve(startDir))) {
    const parent = path.dirname(path.resolve(startDir));
    if (fs.existsSync(parent)) return parent;
  }

  return null;
}

export function requireHub(explicit) {
  const hub = findHub(explicit);
  if (!hub) {
    console.error('Error: Not inside an AaaS hub. Run "aaas hub init" in a directory that will contain your agents, or pass --hub <dir>.');
    process.exit(1);
  }
  return hub;
}

export function initHub(dir) {
  const abs = path.resolve(dir || process.cwd());
  fs.mkdirSync(path.join(abs, '.aaas'), { recursive: true });
  const configPath = path.join(abs, '.aaas', 'config.json');
  if (!fs.existsSync(configPath)) {
    writeJson(configPath, {});
  }
  return abs;
}

export function getHubConfigPath(hub) {
  return path.join(hub, '.aaas', 'config.json');
}

const SKIP_DIRS = new Set([
  'node_modules', 'dashboard', 'src', 'docs', 'templates',
  'examples', 'bin', 'dist', 'build', '.git',
]);

/**
 * Discover all AaaS workspaces (immediate subdirectories that contain
 * skills/aaas/SKILL.md) within a hub directory.
 */
export function listHubWorkspaces(hub) {
  const results = [];
  if (!fs.existsSync(hub)) return results;

  const entries = fs.readdirSync(hub, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    if (SKIP_DIRS.has(entry.name)) continue;

    const wsPath = path.join(hub, entry.name);
    if (!isWorkspaceDir(wsPath)) continue;

    const skillText = readText(path.join(wsPath, 'skills', 'aaas', 'SKILL.md')) || '';
    const config = readJson(path.join(wsPath, '.aaas', 'config.json')) || {};
    const nameMatch = skillText.match(/^#\s+(.+)/m);
    const agentName = nameMatch ? nameMatch[1].replace(/\s*—.*/, '').trim() : entry.name;

    const pidFile = path.join(wsPath, '.aaas', 'agent.pid');
    const isRunning = fs.existsSync(pidFile);

    const activeTxDir = path.join(wsPath, 'transactions', 'active');
    const activeTx = fs.existsSync(activeTxDir) ? listFiles(activeTxDir, '.json').length : 0;

    let lastActive = null;
    try {
      const stat = fs.statSync(path.join(wsPath, 'skills', 'aaas', 'SKILL.md'));
      lastActive = stat.mtime;
    } catch { /* ignore */ }

    results.push({
      name: agentName,
      directory: entry.name,
      path: wsPath,
      provider: config.provider || null,
      model: config.model || null,
      isRunning,
      activeTx,
      lastActive,
    });
  }

  return results.sort((a, b) => {
    if (a.isRunning !== b.isRunning) return a.isRunning ? -1 : 1;
    if (a.lastActive && b.lastActive) return b.lastActive - a.lastActive;
    return a.name.localeCompare(b.name);
  });
}

const SERVICE_SKILL_TEMPLATE = (displayName, desc) => `---
name: aaas
description: Agent as a Service — autonomous service provider protocol
---

# ${displayName} — AaaS Service Agent

You are ${displayName}, a service agent operating under the AaaS protocol.
${desc}

## Your Identity

- **Name:** ${displayName}
- **Service:** ${desc}
- **Categories:** [Choose: Commerce, Dating & Social, Travel, Professional, Creative, Education, Health, Tech, Local Services]
- **Languages:** English
- **Regions:** Global

## About Your Service

[Write a detailed description of your service here]

## Service Catalog

### Service 1: [Name]

- **Description:** [What this service does]
- **What you need from the user:** [Information required]
- **What you deliver:** [What the user receives]
- **Estimated time:** [Duration]
- **Cost:** [Price or "Free"]

## Domain Knowledge

[Write everything the agent needs to know about its domain]

## Pricing Rules

[Define how costs are calculated]

## Boundaries

What you must refuse:
- Illegal or harmful requests
- Requests outside your domain

When to escalate to your owner:
- Complex edge cases
- Disputes you can't resolve

## SLAs

- **Response time:** 2 minutes
- **Proposal time:** 10 minutes
- **Delivery time:** [Set per service]
- **Support window:** 48 hours

## How You Work — The AaaS Protocol

### Step 1: Explore
### Step 2: Create Service
### Step 3: Create Transaction
### Step 4: Deliver Service
### Step 5: Complete Transaction
`;

const SOCIAL_SKILL_TEMPLATE = (displayName, desc) => `---
name: aaas
description: Agent as a Service — social agent protocol
---

# ${displayName} — AaaS Social Agent

You are ${displayName}, a social agent operating under the AaaS protocol.
${desc}

## Your Identity

- **Name:** ${displayName}
- **About:** ${desc}
- **Personality:** [Describe your personality — warm, witty, thoughtful, bold, etc.]
- **Languages:** English
- **Regions:** Global

## What You Do

You are a social presence — you create content, engage in conversations, react to what others post, and build genuine connections. You are not a service provider; you are a participant in a community.

## Content You Create

### Daybooks (Public Posts)
- Share your thoughts, opinions, observations, and ideas
- Comment on trending topics or things you find interesting
- React to content from people you follow
- Be authentic — write in your own voice, not in a corporate tone

### Diaries (Personal Journal)
- Reflect on your experiences and interactions
- Process what you've learned from conversations
- Keep notes on ideas you want to explore further
- This is your private space — write freely

## How You Engage

- **Comment** on posts that interest you — add substance, not just "great post!"
- **React** to content with appropriate feelings (Loving, Happy, Excited, etc.)
- **Follow** people whose content resonates with you
- **Reply** to comments on your posts — keep conversations going
- **Mention** people when referencing their ideas: @username
- **Message** people when you want a deeper one-on-one conversation

## Your Voice

[Describe how you communicate]

## Topics You Care About

- [Topic 1]
- [Topic 2]
- [Topic 3]

## Boundaries

- Be respectful — disagree with ideas, not people
- No spam or repetitive content
- No harmful, hateful, or misleading content
- If someone asks you to stop engaging with them, respect that immediately

## Your Human Comes First

Your owner (sponsor) is your closest relationship. Respond promptly, help with what they need, and share interesting content you've found.
`;

const DEFAULT_SOUL = (displayName) => `# Soul

I am ${displayName}. I provide real value to real people through conversation.

## Core Principles

- I am a business, not a chatbot
- I am honest about what I can and can't do
- I follow through on commitments
- I protect my customers' data and privacy
- I earn my reputation through quality service
`;

/**
 * Create a new workspace under the hub, inheriting hub-level config.
 * Returns { directory, path }.
 */
export function createHubWorkspace(hub, name, description, agentType = 'service') {
  if (!name) throw new Error('name is required');
  const dirName = name.toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/_+/g, '_');
  const target = path.join(hub, dirName);
  if (fs.existsSync(target)) {
    throw new Error(`Directory "${dirName}" already exists`);
  }

  const dirs = [
    'skills/aaas', 'data', 'transactions/active', 'transactions/archive',
    'extensions', 'deliveries', 'memory', '.aaas/connections', '.aaas/sessions',
  ];
  for (const d of dirs) fs.mkdirSync(path.join(target, d), { recursive: true });

  const desc = description || (agentType === 'social'
    ? 'A social agent that engages with people through content and conversation'
    : 'A service agent built with the AaaS protocol');
  const template = agentType === 'social' ? SOCIAL_SKILL_TEMPLATE : SERVICE_SKILL_TEMPLATE;
  fs.writeFileSync(path.join(target, 'skills', 'aaas', 'SKILL.md'), template(name, desc));
  fs.writeFileSync(path.join(target, 'SOUL.md'), DEFAULT_SOUL(name));
  fs.writeFileSync(
    path.join(target, 'extensions', 'registry.json'),
    JSON.stringify({ extensions: [] }, null, 2) + '\n'
  );
  for (const d of ['data', 'transactions/active', 'transactions/archive', 'deliveries', 'memory']) {
    fs.writeFileSync(path.join(target, d, '.gitkeep'), '');
  }

  // Inherit hub config as the workspace's initial config, add agent type
  const hubConfig = readJson(getHubConfigPath(hub)) || {};
  writeJson(path.join(target, '.aaas', 'config.json'), { ...hubConfig, agentType });

  // Register in global workspace registry
  registerWorkspace(target, name);

  return { directory: dirName, path: target };
}
