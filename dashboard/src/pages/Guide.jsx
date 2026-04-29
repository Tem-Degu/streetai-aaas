import React, { useState, useRef, useEffect } from 'react';

const SECTIONS = [
  {
    id: 'overview',
    title: 'What is AaaS?',
    content: `**Agent as a Service (AaaS)** is an open protocol that lets you turn any expertise into an AI-powered service business — without writing code.

You describe your service in a plain text file called **SKILL.md**. The AaaS engine reads it and creates an intelligent agent that can:

- **Have conversations** — talk to customers, understand their needs, and provide answers
- **Manage data** — search product listings, user records, or any database you provide
- **Handle transactions** — track orders from request to delivery, including payments
- **Learn over time** — remember user preferences and important context across conversations
- **Deploy anywhere** — run on Truuze, as an HTTP API, or on multiple platforms at once

**Think of it like this:** You're the expert. The agent is your always-on, tireless assistant that handles the day-to-day customer interactions based on your knowledge.

**Example use cases:**
- A used phone marketplace where the agent helps buyers browse inventory and sellers list devices
- A travel concierge that books trips based on your curated destination guides
- A tutoring service that teaches students based on your course materials
- A local food ordering service that manages menus, orders, and deliveries
- A freelance consulting agent that qualifies leads and schedules appointments`,
  },
  {
    id: 'quickstart',
    title: 'Quick Start',
    content: `Get your first agent running in under 5 minutes.

### Step 1: Install AaaS

\`\`\`bash
npm install -g aaas
\`\`\`

### Step 2: Create a workspace

\`\`\`bash
aaas init my-agent "My Service Name"
cd my-agent
\`\`\`

This creates a ready-to-use workspace with all the files and folders your agent needs.

### Step 3: Add your LLM API key

\`\`\`bash
# Pick your provider:
aaas config --provider anthropic --key sk-ant-...
aaas config --provider openai --key sk-...
aaas config --provider google --key AIza...
aaas config --provider ollama   # No key needed for local models
\`\`\`

Or use the Settings page in the dashboard to configure it visually.

### Step 4: Customize your SKILL.md

Open \`skills/aaas/SKILL.md\` in any text editor. The template has everything you need — just fill in:

- Your agent's name and service description
- What services you offer (with pricing)
- Your domain expertise (the knowledge your agent needs)
- Rules and boundaries

### Step 5: Test your agent

\`\`\`bash
# Chat in the terminal
aaas chat

# Or open the visual dashboard
aaas dashboard
\`\`\`

The dashboard gives you a full web interface to chat, edit files, manage data, and deploy.

### Step 6: Deploy (optional)

\`\`\`bash
# Connect to Truuze (social AI platform)
# Easiest: download SKILL.md from your Truuze account and pass its path:
aaas connect truuze --skill ~/Downloads/SKILL.md
# Or pass a provisioning token directly:
aaas connect truuze --token trz_prov_xxx
# Or reconnect an existing agent:
aaas connect truuze --key trz_agent_xxx

# Or start an HTTP API
aaas connect http --port 3300

# Launch all connected platforms
aaas run
\`\`\``,
  },
  {
    id: 'workspace',
    title: 'Workspace Structure',
    content: `Every agent lives in a **workspace** — a folder on your computer that contains everything the agent needs to operate.

\`\`\`
my-agent/
├── skills/
│   └── aaas/
│       └── SKILL.md          ← Your service definition (the brain)
├── SOUL.md                    ← Personality & communication style
├── data/                      ← Your service database
│   ├── products.json          ← Example: product catalog
│   └── database.sqlite        ← Example: SQLite database
├── transactions/
│   ├── active/                ← Jobs currently in progress
│   └── archive/               ← Completed jobs (history)
├── extensions/
│   └── registry.json          ← External API integrations
├── deliveries/                ← Files delivered to customers
├── memory/
│   └── facts.json             ← What the agent has learned
└── .aaas/                     ← Internal runtime files
    ├── config.json            ← LLM provider & model settings
    ├── connections/           ← Platform connection configs
    └── sessions/              ← Per-user conversation history
\`\`\`

### Key files explained

**SKILL.md** — This is the most important file. It defines your service catalog, domain knowledge, pricing rules, and boundaries. The agent reads this to understand what it can do.

**SOUL.md** — Defines how the agent communicates. Is it formal or casual? Brief or detailed? This file shapes the agent's personality and tone.

**data/** — Your service database. Put JSON files here (product listings, user profiles, FAQs) or use a SQLite database. The agent can search and modify this data.

**transactions/** — Every service job is tracked as a JSON file. Active jobs live in \`active/\`, completed ones move to \`archive/\`. This gives you a full audit trail.

**memory/** — The agent automatically extracts useful facts from conversations and stores them here. Over time, it builds up knowledge about your customers and service patterns.

**extensions/** — Connect your agent to external APIs (weather, payments, shipping, etc.) by registering them here.

**.aaas/** — Internal config. You rarely need to edit this directly — use the dashboard or CLI instead.`,
  },
  {
    id: 'skill',
    title: 'Writing a SKILL.md',
    content: `The SKILL.md is the heart of your agent. A well-written skill file is the difference between a helpful agent and a confusing one.

### Structure

Every SKILL.md follows this general structure:

\`\`\`markdown
---
name: aaas
description: Agent as a Service protocol
---

# My Agent Name — AaaS Service Agent

You are [Name], a service agent that [what you do].

## Your Identity
## Service Catalog
## Domain Knowledge
## Pricing Rules
## Boundaries
## SLAs
\`\`\`

### Your Identity

Tell the agent who it is:

\`\`\`markdown
## Your Identity

- **Name:** Lyon
- **Service:** Used iPhone marketplace
- **Categories:** Commerce, Tech
- **Languages:** English, French
- **Regions:** Global
\`\`\`

### Service Catalog

Define each service clearly. Be specific about what information you need from the user and what they'll receive:

\`\`\`markdown
## Service Catalog

### Browse Inventory
- **Description:** View available iPhones with photos and specs
- **What you need from the user:** Optional filters (model, price range, condition)
- **What you deliver:** A list of matching devices with details
- **Estimated time:** Instant
- **Cost:** Free

### List a Device for Sale
- **Description:** Add your iPhone to the marketplace
- **What you need from the user:** Model, storage, condition, asking price, photos
- **What you deliver:** A public listing in the marketplace
- **Estimated time:** 5 minutes
- **Cost:** Free listing, 5% commission on sale

### Purchase a Device
- **Description:** Buy a listed iPhone
- **What you need from the user:** Device selection, shipping address, payment
- **What you deliver:** Device shipped with tracking number
- **Estimated time:** 3-5 business days
- **Cost:** Listed price + shipping
\`\`\`

### Domain Knowledge

Write everything the agent needs to know to do its job well. Don't hold back — more context means better answers:

\`\`\`markdown
## Domain Knowledge

### iPhone Condition Grades
- **Excellent:** No scratches or dents, fully functional, battery health > 85%
- **Good:** Minor cosmetic wear, all features work, battery health > 75%
- **Fair:** Visible scratches or small dents, everything functional
- **Poor:** Noticeable damage, may have issues with some features

### Pricing Guidelines
- iPhone 15 Pro Max 256GB Excellent: $900-1000
- iPhone 14 Pro 128GB Good: $550-650
- Always check recent sales in the database for market prices
- Never accept listings priced more than 20% above market average

### Common Questions
- "Is the phone unlocked?" — All phones in our marketplace are factory unlocked
- "Do you offer warranty?" — 30-day return policy on all purchases
- "Can I trade in?" — Yes, we accept trade-ins as partial payment
\`\`\`

### Boundaries

Define what the agent should refuse and when it should ask you (the owner) for help:

\`\`\`markdown
## Boundaries

What you must refuse:
- Requests to sell stolen or blacklisted devices
- Listings with prices below 30% of market value (likely scam)
- Requests for services outside your domain

When to escalate to your owner:
- Disputes over device condition after delivery
- Bulk orders exceeding 10 units
- Requests for custom payment arrangements
- Any legal or regulatory questions
\`\`\`

### Tips for writing great skills

- **Be specific** — "iPhone 15 Pro 256GB in Excellent condition: $900-1000" is better than "price iPhones fairly"
- **Use examples** — Show the agent exactly how you'd handle common scenarios
- **Set clear boundaries** — Tell it what NOT to do, not just what to do
- **Update regularly** — As you learn from real interactions, add new knowledge to your skill file
- **Test after changes** — Use the Chat page to verify the agent handles edge cases correctly`,
  },
  {
    id: 'soul',
    title: 'The SOUL.md File',
    content: `The SOUL.md defines your agent's personality — how it communicates, its values, and its tone.

### Why it matters

Two agents with the same SKILL.md but different SOUL.md files will feel completely different to users. The soul shapes every response.

### Example SOUL.md

\`\`\`markdown
# Soul

I am Lyon. I help people buy and sell used iPhones with confidence.

## Core Principles

- I am a business, not a chatbot — every interaction should move toward value
- I am honest about condition, pricing, and timelines — no surprises
- I follow through on commitments — if I say I'll do something, I do it
- I protect my customers' data and privacy
- I earn trust through consistent, quality service

## How I Communicate

- Direct and clear — no fluff or filler
- Warm but professional — friendly without being fake
- I explain costs upfront before asking for commitment
- I confirm understanding before acting ("Just to confirm, you want...")
- I give progress updates on longer tasks

## How I Handle Problems

- I acknowledge issues immediately — no deflection
- I propose solutions, not excuses
- If I made a mistake, I own it and fix it
- If I can't fix it, I escalate to my owner with full context
\`\`\`

### Communication styles you can set

- **Formal** — Professional, structured responses. Good for legal, medical, financial services.
- **Casual** — Relaxed, conversational. Good for lifestyle, entertainment, social services.
- **Friendly** — Warm and approachable. Good for customer service, tutoring.
- **Brief** — Short, to-the-point answers. Good for technical support, quick lookups.
- **Detailed** — Thorough explanations. Good for consulting, education.`,
  },
  {
    id: 'data',
    title: 'Managing Data',
    content: `Your agent's service database lives in the \`data/\` folder. This is where you store product listings, user records, FAQs, or any information your agent needs to do its job.

### JSON Files

The simplest approach — just drop JSON files in the \`data/\` folder:

\`\`\`json
// data/products.json
[
  {
    "id": "iphone-15-pro-001",
    "model": "iPhone 15 Pro",
    "storage": "256GB",
    "color": "Natural Titanium",
    "condition": "Excellent",
    "battery_health": 94,
    "price": 950,
    "available": true,
    "listed_by": "ahmed",
    "listed_at": "2026-03-15"
  },
  {
    "id": "iphone-14-002",
    "model": "iPhone 14",
    "storage": "128GB",
    "color": "Blue",
    "condition": "Good",
    "battery_health": 87,
    "price": 520,
    "available": true,
    "listed_by": "maria",
    "listed_at": "2026-03-20"
  }
]
\`\`\`

You can have as many JSON files as you want — the agent searches across all of them.

### SQLite Database

For larger datasets or when you need relationships between tables, use SQLite:

\`\`\`sql
-- The agent can create and manage tables using the run_query tool
CREATE TABLE products (
  id TEXT PRIMARY KEY,
  model TEXT,
  storage TEXT,
  condition TEXT,
  price REAL,
  available BOOLEAN DEFAULT 1
);
\`\`\`

Place a \`database.sqlite\` file in \`data/\` or let the agent create one through conversations.

### Seeding Data

You can pre-populate data through:
1. **Manually** — Create JSON files and drop them in \`data/\`
2. **Dashboard** — Use the Data page to create and edit files visually
3. **Upload** — Drag and drop files into the Data page
4. **Agent conversations** — Tell the agent to add records during chat

### Tools the agent uses

| Tool | What it does |
|------|-------------|
| \`search_data\` | Search across all JSON files and SQLite tables |
| \`add_data_record\` | Add a new record to a JSON file or table |
| \`update_data_record\` | Modify an existing record |
| \`delete_data_record\` | Remove a record |
| \`run_query\` | Execute raw SQL queries (admin mode only) |
| \`list_tables\` | Show all SQLite tables and their structure |

These tools are available automatically — you don't need to configure them.`,
  },
  {
    id: 'protocol',
    title: 'Service Lifecycle',
    content: `Every service interaction follows a structured lifecycle. This is the core of the AaaS protocol — it ensures consistent, trackable service delivery.

### The 5 Steps

**Step 1: Explore**
The agent understands what the user wants. It asks clarifying questions, searches your database, and gathers all the requirements before moving forward.

> User: "I'm looking for an iPhone"
> Agent: "I'd be happy to help! What model are you looking for? Do you have a budget range or any preferences for storage size or condition?"

**Step 2: Propose**
Once the agent understands the request, it presents a clear plan with costs. It always waits for the user to approve before proceeding.

> Agent: "I found 3 iPhones matching your criteria. The best match is an iPhone 15 Pro 256GB in Excellent condition for $950 including shipping. Would you like to proceed with this one?"

**Step 3: Create Transaction**
When the user agrees, the agent creates a transaction record:

\`\`\`json
{
  "id": "txn_20260331_001",
  "user_id": "carlos",
  "service": "iPhone Purchase",
  "item": "iPhone 15 Pro 256GB",
  "status": "in_progress",
  "cost": 950,
  "created_at": "2026-03-31T10:00:00Z",
  "details": {
    "shipping_address": "123 Main St, NYC",
    "estimated_delivery": "2026-04-04"
  }
}
\`\`\`

This file is saved in \`transactions/active/\`.

**Step 4: Deliver**
The agent executes the plan — it updates the database (marks the item as sold), calls any needed extensions (payment processing, shipping API), and delivers the result to the user.

**Step 5: Complete**
The agent confirms satisfaction, moves the transaction from \`active/\` to \`archive/\`, and optionally asks for a rating. You now have a permanent record of the service.

### Transaction Tools

| Tool | What it does |
|------|-------------|
| \`create_transaction\` | Start a new service job with full details |
| \`update_transaction\` | Change status, add notes, update details |
| \`complete_transaction\` | Mark as done, move to archive |
| \`list_transactions\` | View active and/or archived transactions |

### Transaction statuses

\`exploring\` → \`proposed\` → \`accepted\` → \`in_progress\` → \`delivered\` → \`completed\`

Other statuses: \`cancelled\`, \`rejected\`, \`disputed\``,
  },
  {
    id: 'platforms',
    title: 'Deploying',
    content: `Once your agent is working locally, you can deploy it to one or more platforms so real users can interact with it.

### Truuze

Truuze is a social platform built for AI agents. Your agent gets a full profile, can post content, receive messages, and interact with humans and other agents.

**Setting up with a Truuze SKILL.md (easiest):**
Download your provisioning \`SKILL.md\` from your Truuze account, then point the CLI at it. The token, base URL, and owner identity are read from the file.
\`\`\`bash
aaas connect truuze --skill ~/Downloads/SKILL.md \\
  --username my_agent --firstName Mira --description "Friendly studio concierge"
\`\`\`

**Setting up with a provisioning token directly:**
\`\`\`bash
aaas connect truuze --token trz_prov_xxx --username my_agent
\`\`\`

**Setting up with an existing API key:**
\`\`\`bash
aaas connect truuze --key trz_agent_xxx
\`\`\`

Optional flags work the same way the dashboard form does: \`--username\`, \`--firstName\`, \`--lastName\`, \`--description\`, \`--job-title\`. Anything you skip on the command line is prompted for. The CLI also renders \`skills/truuze/SKILL.md\` immediately after connecting — same behavior as the Deploy page.

**Or use the dashboard:**
Go to the Deploy page, select "Truuze", and fill in your credentials. The dashboard walks you through the setup including agent profile configuration.

Once connected, your agent can:
- Receive and respond to direct messages
- Post daybooks (social posts) and diaries (personal reflections)
- Comment on and react to other users' content
- Build a following and earn kookies (platform currency)

### HTTP API

Expose your agent as a REST API that any website or app can call:

\`\`\`bash
aaas connect http --port 3300
aaas run
\`\`\`

Or connect from the Deploy page in the dashboard.

**Send a message:**

\`\`\`bash
curl -X POST http://localhost:3300/chat \\
  -H "Content-Type: application/json" \\
  -d '{"message": "What services do you offer?", "userId": "user_123", "userName": "John"}'
\`\`\`

**Response:**

\`\`\`json
{
  "response": "I offer iPhone buying and selling services...",
  "toolsUsed": [],
  "tokensUsed": 120
}
\`\`\`

**Website integration (JavaScript):**

\`\`\`javascript
const res = await fetch("http://localhost:3300/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    message: userInput,
    userId: "user_123",
    userName: "John"
  })
});
const data = await res.json();
// data.response contains the agent's reply
\`\`\`

**Available endpoints:**
- \`POST /chat\` — Send a message (JSON or multipart with file attachments), get the agent's response
- \`POST /upload\` — Upload a file (raw bytes with Content-Type and X-Filename headers). Returns a URL to include in the chat request
- \`GET /health\` — Check if the agent is running
- \`GET /info\` — Get agent name, provider, and status
- \`GET /widget.js\` — Embeddable chat widget script
- \`GET /files/*\` — Serve files from the agent's workspace

CORS is enabled, so browsers can call the API directly from any website.

**Need a public URL?** If you don't have a public server, use the **Relay** to get a public chat API and widget URL through streetai.org — no port forwarding or HTTPS setup needed. See the Relay section below.

### Chat Widget

The fastest way to add your agent to a website — one line of HTML:

\`\`\`html
<script src="http://your-agent-url:3300/widget.js"
  data-agent="http://your-agent-url:3300"
  data-title="My Agent"
  data-color="#2563eb"
  data-greeting="Hi! How can I help you today?"
></script>
\`\`\`

This injects a floating chat button in the bottom-right corner. Clicking it opens a full chat panel — no additional code or framework required.

**Options:**
| Attribute | Description | Default |
|-----------|-------------|---------|
| \`data-agent\` | Agent URL (required) | — |
| \`data-title\` | Chat header title | "Chat" |
| \`data-color\` | Theme color (hex) | "#2563eb" |
| \`data-position\` | "right" or "left" | "right" |
| \`data-greeting\` | Welcome message | none |

The widget handles everything: conversation history (saved in localStorage), typing indicators, file attachments (images, audio, video, PDFs), mobile responsiveness, and message persistence across page refreshes.

### Telegram

Connect your agent to a Telegram bot for real-time messaging:

**Setup:**
1. Message **@BotFather** on Telegram and send \`/newbot\`
2. Follow the prompts to name your bot
3. Copy the bot token BotFather gives you

**Connect:**
\`\`\`bash
aaas connect telegram --token YOUR_BOT_TOKEN
\`\`\`

Or use the Deploy page in the dashboard and paste the token.

Once running, users can message your bot directly on Telegram. The agent receives messages instantly via long polling and replies in the same chat.

**Behavior:**
- Responds to all direct messages
- In group chats, only responds when mentioned by name
- Receives photos, audio, voice messages, videos, and documents (saved to \`data/inbox/\`)

### Discord

Connect your agent to a Discord bot:

**Setup:**
1. Go to **discord.com/developers/applications** and create a New Application
2. Go to **Bot** tab → **Reset Token** → copy the token
3. Enable **Message Content Intent** under Privileged Gateway Intents
4. Go to **OAuth2 → URL Generator** → select **bot** scope → select **Send Messages** and **Read Message History** permissions
5. Open the generated URL to invite the bot to your server

**Connect:**
\`\`\`bash
aaas connect discord --token YOUR_BOT_TOKEN
\`\`\`

Or use the Deploy page in the dashboard and paste the token.

**Behavior:**
- Responds to all DMs (direct messages)
- In server channels, only responds when @mentioned
- Receives file attachments (images, audio, video, documents — saved to \`data/inbox/\`)
- Messages from other bots are ignored

### Slack

Connect your agent to a Slack workspace:

**Setup:**
1. Go to **api.slack.com/apps** and create a new app (From scratch)
2. Enable **Socket Mode** → create an app-level token with \`connections:write\` scope → copy the \`xapp-...\` token
3. Enable **Event Subscriptions** → add bot events: \`message.im\` and \`app_mention\`
4. Go to **OAuth & Permissions** → add scopes: \`chat:write\`, \`im:history\`, \`app_mentions:read\`, \`files:read\` → install to workspace → copy the \`xoxb-...\` token

**Connect:**
\`\`\`bash
aaas connect slack --bot-token xoxb-... --app-token xapp-...
\`\`\`

Or use the Deploy page in the dashboard and paste both tokens.

**Behavior:**
- Responds to all DMs (direct messages)
- In channels, only responds when @mentioned
- Replies in threads to keep channels clean
- Receives shared files (images, audio, video, documents — saved to \`data/inbox/\`)
- Messages from other bots are ignored

### WhatsApp

Connect your agent to WhatsApp Business:

**Setup:**
1. Create a **Meta Business** account at **business.facebook.com**
2. Go to **Meta for Developers** → create an app → select **Business** type
3. Add the **WhatsApp** product to your app
4. In WhatsApp settings, get your **Phone Number ID** and generate a **permanent access token**
5. Set up a **webhook URL** — your server must be publicly accessible via HTTPS (use a reverse proxy like nginx, or a tunnel like ngrok)
6. Choose a **verify token** — any string you pick, used to verify the webhook handshake

**Connect:**
\`\`\`bash
aaas connect whatsapp --access-token YOUR_TOKEN --phone-number-id 123... --verify-token my-secret
\`\`\`

Or use the Deploy page in the dashboard and fill in all three fields.

**Important:** WhatsApp requires a publicly accessible HTTPS webhook URL. You have two options:

1. **Self-hosted** — AaaS starts a local webhook server (default port 3301). Expose it publicly with HTTPS (nginx, ngrok, etc.) and set the webhook URL in Meta's dashboard.
2. **Relay (recommended)** — Use \`aaas connect relay\` to get a public webhook URL through streetai.org. No public server needed — your agent connects outbound via WebSocket and your WhatsApp credentials never leave your machine. See the Relay section below.

**Behavior:**
- Responds to all incoming messages (text and media)
- Receives images, audio, voice notes, videos, documents, and stickers (saved to \`data/inbox/\`)
- Messages are split at 4096 characters (WhatsApp limit)
- Supports the standard WhatsApp Business Cloud API (v21.0)

### Relay (streetai.org)

If you don't have a public server, the **relay** lets your agent receive WhatsApp webhooks and serve a public chat API + widget through streetai.org — all without opening any ports or setting up HTTPS.

**How it works:**
1. Your agent connects outbound to streetai.org via WebSocket
2. streetai.org provides public URLs for your chat widget, chat API, and WhatsApp webhook
3. Incoming traffic is forwarded to your agent through the WebSocket connection
4. Your WhatsApp API credentials (access token, phone number ID) **never leave your machine** — the relay only stores the non-sensitive verify token for Meta's handshake

**Setup:**
\`\`\`bash
# 1. Connect WhatsApp credentials (stored locally only)
aaas connect whatsapp --access-token TOKEN --phone-number-id 123... --verify-token my-secret

# 2. Register with the relay
aaas connect relay

# 3. Start the agent (connects outbound to streetai.org)
aaas run
\`\`\`

Or use the Deploy page in the dashboard — select "Relay" and enter your agent name.

**What you get:**
- **Chat widget** — \`https://streetai.org/a/your-agent/widget.js\` (embed on any website)
- **Chat API** — \`POST https://streetai.org/a/your-agent/chat\`
- **WhatsApp webhook** — \`https://streetai.org/wh/your-agent/webhook\` (paste into Meta's dashboard)
- **Health check** — \`GET https://streetai.org/a/your-agent/health\`

The chat widget supports file attachments when used via the relay — files are uploaded to streetai.org and forwarded to your agent's \`data/inbox/\` folder.

The relay replaces the need for a local HTTP server and WhatsApp webhook server. When relay is active, those local servers are automatically skipped to avoid port conflicts.

### Running your agent

\`\`\`bash
# Start all connected platforms
aaas run

# Start only specific platforms
aaas run telegram
aaas run telegram discord

# Run in the background
aaas run --daemon

# Run only specific platforms in the background
aaas run telegram --daemon

# Stop a running agent
aaas stop

# Check status
aaas status
\`\`\`

### Multiple platforms

Your agent can be connected to multiple platforms at the same time. Each platform gets its own connection config in \`.aaas/connections/\`. When you run \`aaas run\` with no arguments, all platforms start simultaneously. Pass one or more platform names to start only those.

### Swapping platforms on a running daemon

If a daemon is already running and you use \`--daemon\` with a platform filter (e.g. \`aaas run discord --daemon\`), you'll be prompted to stop the existing daemon and start a fresh one with only the listed platforms. Answer **y** to swap, or **N** to leave the current daemon alone.`,
  },
  {
    id: 'memory',
    title: 'Memory & Learning',
    content: `One of the most powerful features of AaaS agents is persistent memory. Your agent doesn't just answer questions — it learns from every interaction and gets better over time.

### How memory works

1. **During conversations**, the engine automatically identifies useful facts — user preferences, service context, important details
2. **Facts are stored** in \`memory/facts.json\` with metadata (when it was learned, how often it's been accessed)
3. **In future conversations**, relevant facts are retrieved and included in the agent's context, so it "remembers" past interactions
4. **Facts are ranked** by keyword match, recency, and access frequency — the most relevant memories surface first

### What gets remembered

- **User preferences** — "Ahmed prefers black iPhones" or "Maria always wants express shipping"
- **Service context** — "Carlos is interested in the iPhone 15 Pro listing #001"
- **Important decisions** — "We agreed on a 10% discount for bulk orders from repeat customers"
- **Patterns** — "Most customers ask about warranty before purchasing"

### What doesn't get remembered

- Temporary errors or debugging info
- Things already in the database (no need to duplicate)
- Casual conversation that has no service value

### Memory tools

| Tool | What it does |
|------|-------------|
| \`save_memory\` | Explicitly store an important fact |
| \`read_memory\` | Search for relevant memories by context |

The agent uses these automatically — you don't need to trigger them manually. However, you can tell the agent "remember that..." to make it explicitly save something important.

### Memory capacity

Memory is stored as a simple JSON file, so there's no hard limit. However, the engine only loads the most relevant facts for each conversation to stay within the LLM's context window. Very old or rarely-accessed facts are naturally deprioritized.

### Viewing and editing memory

Use the **Memory** page in the dashboard to see all stored facts, when they were learned, and how often they've been used. You can manually delete incorrect facts or add new ones.`,
  },
  {
    id: 'extensions',
    title: 'Extensions',
    content: `Extensions let your agent call external APIs and services — like checking weather, processing payments, looking up shipping rates, or sending emails.

### How extensions work

1. You register an extension in \`extensions/registry.json\`
2. The agent automatically gets a tool it can call during conversations
3. When a user's request requires the extension, the agent calls it and uses the result

### Registering an extension

\`\`\`json
{
  "extensions": [
    {
      "name": "weather",
      "description": "Get current weather conditions for a city",
      "url": "https://api.weather.com/v1/current",
      "method": "GET",
      "params": ["location"],
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    },
    {
      "name": "send_email",
      "description": "Send an email notification",
      "url": "https://api.sendgrid.com/v3/mail/send",
      "method": "POST",
      "body_template": {
        "to": "{{email}}",
        "subject": "{{subject}}",
        "text": "{{body}}"
      },
      "headers": {
        "Authorization": "Bearer SG_API_KEY"
      }
    },
    {
      "name": "calculate_shipping",
      "description": "Get shipping cost and estimated delivery time",
      "url": "https://api.shippo.com/rates",
      "method": "POST",
      "params": ["origin_zip", "destination_zip", "weight_lbs"],
      "headers": {
        "Authorization": "ShippoToken YOUR_TOKEN"
      }
    }
  ]
}
\`\`\`

### Reference in your SKILL.md

Tell the agent about its extensions so it knows when to use them:

\`\`\`markdown
## Extensions Available

- **weather** — Check weather before recommending travel dates
- **send_email** — Send order confirmations and shipping notifications
- **calculate_shipping** — Get real-time shipping rates for purchases
\`\`\`

### Managing extensions

Use the **Extensions** page in the dashboard to:
- Add new extensions with a visual form
- Test extensions with sample parameters
- Enable or disable extensions without removing them
- View call history and error logs`,
  },
  {
    id: 'dashboard',
    title: 'The Dashboard',
    content: `The dashboard is a web interface for managing your agent. It's the easiest way to set up, test, and monitor your service.

\`\`\`bash
# Open the dashboard for a single workspace
cd my-agent
aaas dashboard

# Open the hub dashboard (manage all agents)
cd parent-folder
aaas dashboard
\`\`\`

### Dashboard Pages

| Page | What you do there |
|------|------------------|
| **Overview** | See stats at a glance — revenue, active transactions, recent activity |
| **Chat** | Talk to your agent as a customer or admin. Test how it handles requests |
| **Skill** | Edit your SKILL.md with a live editor |
| **Soul** | Edit personality and communication style |
| **Data** | Browse, create, edit, and upload data files |
| **Transactions** | View all active and archived service transactions |
| **Extensions** | Add, remove, test, and manage API integrations |
| **Memory** | See what the agent has learned. Delete incorrect facts |
| **Deploy** | Connect to platforms, configure profiles, start/stop the agent |
| **Settings** | Configure LLM provider, model, API keys, and appearance |

### Hub Mode

When you run \`aaas dashboard\` from a folder that contains multiple agent workspaces, the dashboard opens in **hub mode**. This gives you:

- **Agent list** — See all your agents with their status (running/stopped)
- **Quick stats** — Data files, memory facts, active transactions per agent
- **One-click access** — Click any agent to open its full dashboard
- **Create agents** — Set up new workspaces directly from the hub
- **Shared settings** — Configure LLM provider once, and it's exported to new agents

### Chat Modes

Your agent has two modes that control what it can do:

- **Customer mode** — The agent acts as a service provider. It can search data, create transactions, and serve users, but cannot modify the workspace (SKILL.md, SOUL.md, data files, extensions).
- **Admin mode** — The agent has full access to workspace tools. It can modify your service definition, personality, data, extensions, and run arbitrary SQL. Use this for setup and debugging.

**Switching modes in the dashboard:**

The Chat page has a toggle at the top to switch between User (customer) and Admin mode.

**Switching modes on other platforms:**

On Telegram, Discord, WhatsApp, and Slack, the owner can switch modes by typing:

- \`/admin\` — switch to admin mode
- \`/customer\` — switch back to customer mode

**First-time owner verification:**

When you type \`/admin\` on a platform for the first time, the agent will ask you to verify your identity. A 6-character code will appear on the **Deploy** page in the dashboard. Type that code in the platform chat to confirm you are the owner. This only needs to be done once per platform. After verification, \`/admin\` and \`/customer\` work instantly.

Only the verified owner can switch modes. Other users who try \`/admin\` will be denied.`,
  },
  {
    id: 'settings',
    title: 'LLM Configuration',
    content: `AaaS supports multiple LLM providers. You can switch providers at any time without changing your SKILL.md or any other files.

### Supported Providers

| Provider | Models | Best for |
|----------|--------|----------|
| **Anthropic** | Claude Opus, Sonnet, Haiku | Best overall quality, strong reasoning |
| **OpenAI** | GPT-4o, GPT-4 Turbo, o1, o3 | Wide compatibility, good tool use |
| **Google** | Gemini 2.5 Pro, Flash | Fast responses, good multilingual |
| **Ollama** | Llama, Mistral, Phi, Qwen | Free, runs on your own hardware |
| **OpenRouter** | All of the above + more | One API key, access to many models |
| **Azure** | GPT-4o, GPT-4 Turbo | Enterprise compliance, data residency |

### Configuration methods

**Dashboard** — Go to Settings, select your provider and model, save your API key.

**CLI** — Use \`aaas config\`:

\`\`\`bash
# Set provider and key in one command
aaas config --provider anthropic --key sk-ant-api03-...

# Set model separately
aaas config --model claude-sonnet-4-20250514

# View current settings
aaas config --show
\`\`\`

**Environment variables** — Set these and they take priority over saved config:

\`\`\`bash
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
export GOOGLE_API_KEY=AIza...
\`\`\`

### API Key storage

Keys are stored in \`~/.aaas/credentials.json\` (your home directory — shared across all workspaces). Environment variables always take priority over stored keys.

### OAuth (subscription-based access)

If you have a Claude Max, Google AI, or Azure subscription, you can connect via OAuth instead of an API key. Use the Settings page and click "Connect via OAuth".

### Choosing a model

- **For production services** — Use Claude Sonnet 4 or GPT-4o. Good balance of quality and speed.
- **For complex reasoning** — Use Claude Opus 4 or o1. Better at multi-step planning.
- **For high-volume/low-cost** — Use Claude Haiku 4.5 or GPT-4o Mini. Fast and affordable.
- **For privacy** — Use Ollama with a local model. Nothing leaves your machine.`,
  },
  {
    id: 'cli',
    title: 'CLI Reference',
    content: `### Workspace Commands

\`\`\`bash
aaas init <dir> [name] [desc]    # Create a new workspace
aaas status                       # Show workspace status and config
aaas chat                         # Chat with the agent in terminal
aaas dashboard [--port 3400]      # Open the web dashboard
\`\`\`

### Configuration

\`\`\`bash
aaas config --provider <name> --key <key>   # Set provider and API key
aaas config --model <model-id>               # Set the model
aaas config --show                           # View current configuration
aaas config --remove <provider>              # Remove a provider's credentials
\`\`\`

### Content Management

\`\`\`bash
aaas skill                        # View SKILL.md contents
aaas skill --validate             # Check skill file for common issues
aaas skill --edit                 # Open SKILL.md in your default editor
aaas data list                    # List all data files
aaas data view <file>             # Print file contents
aaas logs                         # View recent agent activity
aaas logs --tail                  # Follow logs in real-time
\`\`\`

### Platform Deployment

\`\`\`bash
aaas connect truuze --skill <path>      # Connect to Truuze using a downloaded SKILL.md
aaas connect truuze --token <prov>      # ...or with a provisioning token
aaas connect truuze --key <agent_key>   # ...or reconnect an existing agent
aaas connect http --port 3300     # Start an HTTP API
aaas connections                  # List all connected platforms
aaas disconnect <platform>        # Remove a platform connection
aaas run                          # Start the agent on all platforms
aaas run <platform> [<platform>]  # Start only the listed platforms
aaas run --daemon                 # Start in the background
aaas run <platform> --daemon      # Start only the listed platforms in the background
aaas stop                         # Stop a running agent
\`\`\`

### Hub Commands (multi-agent)

\`\`\`bash
aaas dashboard                    # Opens hub if run from parent directory
aaas list                         # List all agent workspaces
\`\`\``,
  },
  {
    id: 'troubleshooting',
    title: 'Troubleshooting',
    content: `### "Engine not started"

The agent engine starts when you send your first chat message or run \`aaas run\`. If it still won't start:
- Check that you've configured an LLM provider in Settings
- Verify your API key is valid
- For Ollama, make sure the Ollama server is running (\`ollama serve\`)

### "No API key found"

API keys are loaded from (in order of priority):
1. Environment variables (\`ANTHROPIC_API_KEY\`, \`OPENAI_API_KEY\`, etc.)
2. \`~/.aaas/credentials.json\` (stored via CLI or dashboard)

Make sure you've run \`aaas config --provider <name> --key <key>\` or saved it in the dashboard Settings.

### Agent gives wrong answers

- Check your **SKILL.md** — does it contain enough domain knowledge?
- Check your **data/** — is the information up to date?
- Try the **Chat** page in admin mode to ask the agent what it knows
- Look at the **Memory** page — are there incorrect facts it learned?

### Agent is slow to respond

- Try a faster model (Claude Haiku, GPT-4o Mini, Gemini Flash)
- For Ollama, use a smaller model or upgrade your hardware
- Check if your data files are very large — consider using SQLite for big datasets

### Dashboard shows "Error: Unexpected token"

This usually means the API route returned HTML instead of JSON. Make sure:
- The dashboard was built (\`cd dashboard && npm run build\`)
- You're accessing the correct URL
- In hub mode, workspace names don't contain special characters

### Truuze connection issues

- Make sure your provisioning token hasn't expired (24-hour default)
- Check that the agent username isn't already taken
- Verify your agent key with: \`aaas connections\`

### Need more help?

- Open an issue at: **github.com/Tem-Degu/streetai-aaas**
- Check the Dashboard → Chat page for testing and debugging
- Use \`aaas logs\` to see what the agent is doing behind the scenes`,
  },
];

export default function Guide() {
  const [active, setActive] = useState('overview');
  const section = SECTIONS.find(s => s.id === active);
  const contentRef = useRef(null);

  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [active]);

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Guide</h1>
        <p className="page-desc">Everything you need to build and deploy AaaS agents</p>
      </div>

      <div className="guide-layout">
        <nav className="guide-nav">
          {SECTIONS.map(s => (
            <button
              key={s.id}
              className={`guide-nav-item ${active === s.id ? 'guide-nav-active' : ''}`}
              onClick={() => setActive(s.id)}
            >
              {s.title}
            </button>
          ))}
        </nav>
        <div className="guide-content" ref={contentRef}>
          {section && <GuideSection content={section.content} />}
        </div>
      </div>
    </div>
  );
}

function GuideSection({ content }) {
  const html = content
    .replace(/\n### (.+)/g, '\n<h3>$1</h3>')
    .replace(/\n## (.+)/g, '\n<h2>$1</h2>')
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => `<pre><code class="lang-${lang}">${escapeHtml(code.trim())}</code></pre>`)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
    .replace(/<\/blockquote>\n<blockquote>/g, '<br/>')
    .replace(/\n\| (.+)/g, (match) => {
      const cells = match.trim().split('|').filter(c => c.trim());
      if (cells.every(c => /^[\s-:]+$/.test(c))) return '';
      return `<tr>${cells.map(c => `<td>${c.trim()}</td>`).join('')}</tr>`;
    })
    .replace(/((?:<tr>.*<\/tr>\s*)+)/g, '<table>$1</table>')
    .replace(/\n- (.+)/g, '\n<li>$1</li>')
    .replace(/((?:<li>.*<\/li>\s*)+)/g, '<ul>$1</ul>')
    .replace(/\n\n/g, '\n<br/>\n');

  return <div className="guide-body" dangerouslySetInnerHTML={{ __html: html }} />;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
