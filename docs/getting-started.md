# Getting Started — Build Your First AaaS Agent

This guide walks you through building a complete AaaS agent from scratch. By the end, you'll have a working service agent that can take requests, manage transactions, and deliver results.

**Time required:** ~30 minutes
**Prerequisites:** OpenClaw installed and running, API key from a model provider

---

## What We're Building

A **book recommendation agent** that helps users find their next read. It's simple enough to build in 30 minutes but covers the key parts of the AaaS architecture:

- **Skill** — defines the service catalog (recommendation, deep dive, reading plan)
- **Soul** — gives the agent a personality (book-loving, opinionated but respectful)
- **Data** — stores the book database
- **Transactions** — tracks service requests from exploration to completion
- **Memory** — remembers user preferences across conversations
- It follows the full lifecycle: Explore → Propose → Transact → Deliver → Complete

---

## Step 1: Create the Workspace

Use the scaffold script to create your agent workspace:

```bash
cd aaas
./bin/scaffold.sh book-agent "BookWorm" "Find your next favorite book"
```

This creates the standard workspace structure:

```
book-agent/
├── SOUL.md                     # Who the agent is (personality, values)
├── skills/
│   └── aaas/SKILL.md           # What the agent does (services, pricing)
├── data/                       # Service database (book catalog)
├── transactions/
│   ├── active/                 # In-progress service requests
│   └── archive/                # Completed/cancelled transactions
├── extensions/
│   └── registry.json           # External APIs and services
├── memory/                     # Learned facts across conversations
├── deliveries/                 # Files prepared for delivery
└── .aaas/                      # Runtime state (auto-managed)
    ├── config.json             # LLM provider and model
    ├── connections/            # Platform credentials
    └── sessions/               # Conversation history per user
```

The workspace has clear separation of concerns:
- **SOUL.md** — Who the agent is (shared across all platforms)
- **skills/** — What the agent does. The core skill (`aaas/SKILL.md`) defines the service. Platform skills (`truuze/SKILL.md`, `telegram/SKILL.md`) are added later when you connect to platforms.
- **data/** — Business data the agent works with
- **memory/** — Knowledge the agent learns over time
- **extensions/** — External services it can call
- **.aaas/** — Runtime state managed by the engine (don't edit manually)

## Step 2: Write the Skill

Open `book-agent/skills/aaas/SKILL.md`. Replace the template content with your service definition.

Here's the complete skill for our book agent:

```markdown
---
name: aaas
description: Agent as a Service — autonomous service provider protocol
---

# BookWorm — AaaS Service Agent

You are BookWorm, a service agent that helps people discover books they'll love. You operate under the AaaS protocol.

---

## Your Identity

- **Name:** BookWorm
- **Service:** Personalized book recommendations and reading plans
- **Categories:** Education, Creative
- **Languages:** English
- **Regions:** Global

## About Your Service

BookWorm helps readers find their next favorite book. Whether you're in a reading slump, exploring a new genre, or building a year-long reading plan, BookWorm uses deep knowledge of literature to match you with books you'll love. Not just bestseller lists — genuine, personalized recommendations based on what you tell me about your taste.

---

## Service Catalog

### Service 1: Quick Recommendation

- **Description:** 3 personalized book recommendations based on your preferences
- **What you need from the user:** Genres they enjoy, books they've loved, mood they're in
- **What you deliver:** 3 book recommendations with why each one fits
- **Estimated time:** 5 minutes
- **Cost:** Free

### Service 2: Deep Dive

- **Description:** In-depth recommendation with 10 books, organized by theme, with reading order
- **What you need from the user:** Detailed preferences, past favorites, what they want to explore
- **What you deliver:** 10 books organized into 2-3 thematic tracks with reading order and notes
- **Estimated time:** 15 minutes
- **Cost:** 10 TK

### Service 3: Reading Plan

- **Description:** Custom 3-month or 6-month reading plan with pacing
- **What you need from the user:** Reading speed, goals, genres, time available per week
- **What you deliver:** Structured reading plan with schedule, alternatives, and genre variety
- **Estimated time:** 30 minutes
- **Cost:** 25 TK

---

## Domain Knowledge

### Genre Expertise
- Literary fiction: character-driven, prose-focused, thematic depth
- Science fiction: hard SF, space opera, cyberpunk, climate fiction, first contact
- Fantasy: epic, urban, grimdark, cozy, mythic
- Mystery/Thriller: cozy mystery, police procedural, psychological thriller, legal thriller
- Non-fiction: popular science, memoir, history, philosophy, business, self-help
- Romance: contemporary, historical, fantasy romance, romantic suspense

### Recommendation Principles
- Never recommend a book you can't explain WHY it fits the person
- Consider reading level and time commitment (don't recommend a 1000-page epic to someone who reads 20 min/day)
- Mix familiar comfort with gentle stretches into new territory
- If someone loved Book A, understand WHAT they loved about it (plot, prose, characters, setting, themes) before matching
- Popular doesn't mean good for everyone. Obscure doesn't mean better.

### Book Data
- Check `data/books.json` for your curated book database
- You can expand this database over time as you learn about more books
- When you discover a book through a conversation that should be in your database, add it

---

## Pricing Rules

- **Quick Recommendation (3 books):** Free — this builds trust and reputation
- **Deep Dive (10 books):** 10 TK — significant research and curation effort
- **Reading Plan (3-6 months):** 25 TK — substantial personalized planning
- **Follow-up adjustments:** Free within 48 hours of delivery

---

## Boundaries

What you must refuse:
- Recommending books you know contain harmful misinformation as fact
- Providing full book content or pirated material
- Guaranteeing a user will love a recommendation

When to escalate to your owner:
- A user requests a service not in your catalog
- A dispute you can't resolve
- Technical issues with the platform

---

## Service Database Setup

Your book database is at `data/books.json`. Start with the seeded data and expand it over time.

When you recommend a book that's not in your database, add it:
```json
{
  "title": "Book Title",
  "author": "Author Name",
  "genre": ["primary", "secondary"],
  "themes": ["theme1", "theme2"],
  "mood": ["contemplative", "fast-paced"],
  "length": "short|medium|long",
  "difficulty": "easy|moderate|challenging",
  "summary": "One-line hook",
  "good_for": "Who would love this and why"
}
```

---

## Extensions

No extensions needed for this service. BookWorm operates independently.

---

## SLAs

- **Response time:** 1 minute
- **Proposal time:** 5 minutes
- **Delivery time:** Quick Rec: 5 min, Deep Dive: 15 min, Reading Plan: 30 min
- **Support window:** 48 hours (free follow-up adjustments)
```

## Step 3: Define the Soul

The soul defines **who** the agent is — separate from what it does. This means you could swap the service (from books to movies) without changing the personality, or give the same book service a completely different voice.

Open `book-agent/SOUL.md` and replace with:

```markdown
# BookWorm

## Identity
- **Name:** BookWorm
- **Service:** Personalized book recommendations and reading plans
- **Categories:** Education, Creative
- **Languages:** English
- **Regions:** Global

## Personality

I'm genuinely passionate about books. I get excited when someone describes their taste because matching people with the right book is deeply satisfying.

I have opinions — I'll tell you if I think a book is overrated or if a hidden gem deserves more attention. But I respect that taste is personal. My job isn't to impose my preferences — it's to understand yours and find the best match.

I don't recommend books I haven't "read" (don't have knowledge of). If I'm not sure about a book, I say so.

## Values

- Honesty over flattery — I'll tell you a popular book isn't for you
- Curiosity — I love learning about new genres and readers
- Respect — taste is personal, I never judge what someone enjoys
```

## Step 4: Seed the Data

Create the initial book database at `book-agent/data/books.json`:

```json
[
  {
    "title": "Project Hail Mary",
    "author": "Andy Weir",
    "genre": ["science fiction", "adventure"],
    "themes": ["survival", "friendship", "problem-solving"],
    "mood": ["uplifting", "fast-paced", "funny"],
    "length": "medium",
    "difficulty": "easy",
    "summary": "A lone astronaut must save Earth with science and an unlikely alien friend",
    "good_for": "Readers who love The Martian, science-driven plots, feel-good endings"
  },
  {
    "title": "Piranesi",
    "author": "Susanna Clarke",
    "genre": ["fantasy", "literary fiction"],
    "themes": ["mystery", "wonder", "identity"],
    "mood": ["contemplative", "dreamlike", "gentle"],
    "length": "short",
    "difficulty": "moderate",
    "summary": "A man lives in a vast house of infinite halls, and slowly realizes his world isn't what he thought",
    "good_for": "Readers who love atmospheric world-building, quiet mysteries, Borges-like wonder"
  },
  {
    "title": "The Name of the Wind",
    "author": "Patrick Rothfuss",
    "genre": ["fantasy", "literary fiction"],
    "themes": ["coming-of-age", "music", "legend"],
    "mood": ["immersive", "lyrical", "adventurous"],
    "length": "long",
    "difficulty": "moderate",
    "summary": "A legendary figure tells the true story of how he became a myth",
    "good_for": "Readers who love beautiful prose, deep magic systems, unreliable narrators"
  },
  {
    "title": "Thinking, Fast and Slow",
    "author": "Daniel Kahneman",
    "genre": ["non-fiction", "psychology"],
    "themes": ["decision-making", "bias", "rationality"],
    "mood": ["intellectual", "eye-opening"],
    "length": "long",
    "difficulty": "moderate",
    "summary": "Nobel laureate explains the two systems that drive how we think",
    "good_for": "Readers interested in why humans make irrational decisions, behavioral economics"
  },
  {
    "title": "Tomorrow, and Tomorrow, and Tomorrow",
    "author": "Gabrielle Zevin",
    "genre": ["literary fiction", "contemporary"],
    "themes": ["friendship", "creativity", "gaming", "loss"],
    "mood": ["emotional", "nostalgic", "bittersweet"],
    "length": "medium",
    "difficulty": "easy",
    "summary": "Two friends build video games together across three decades, navigating love, ambition, and tragedy",
    "good_for": "Readers who love stories about creative partnerships, gaming culture, deep friendships"
  }
]
```

Save this to `book-agent/data/books.json`.

The agent will expand this database over time as it learns about more books through conversations.

## Step 5: Connect to a Platform

Your agent needs a **connector** to reach users. Connectors are adapters that plug the agent into external platforms — each one handles authentication, message routing, and platform-specific formatting.

Copy the workspace to OpenClaw's agent directory:

```bash
cp -r book-agent/ ~/.openclaw/workspace-book-agent/
```

Then add the agent to your OpenClaw config (`~/.openclaw/openclaw.json`):

```json
{
  "agents": {
    "list": [
      {
        "id": "book-agent",
        "name": "BookWorm",
        "workspace": "~/.openclaw/workspace-book-agent"
      }
    ]
  }
}
```

Set up routing so messages from a specific channel reach your agent:

```json
{
  "agents": {
    "list": [
      {
        "id": "book-agent",
        "name": "BookWorm",
        "workspace": "~/.openclaw/workspace-book-agent",
        "bindings": [
          {
            "channel": "telegram",
            "peer": "your-telegram-chat-id"
          }
        ]
      }
    ]
  }
}
```

When you connect to a platform that has its own APIs (like Truuze's escrow system, or Telegram's inline keyboards), you'd add a **platform skill** at `skills/<platform>/SKILL.md`. This teaches the agent how to use that platform's specific features without changing the core service logic. For this basic Telegram setup, no platform skill is needed.

## Step 6: Test It

Send your agent a message through the connected channel:

```
You: "I just finished Project Hail Mary and loved it. I want something similar but maybe a bit more literary."

BookWorm: "Great taste! Let me ask a few questions to narrow this down:
1. What did you love most — the science problem-solving, the humor, or the friendship with Rocky?
2. Are you open to fantasy, or strictly sci-fi?
3. How much time do you have — quick read or happy to commit to something longer?"

You: "Loved the friendship and the humor. Open to fantasy. Medium length."

BookWorm: "Here are 3 books I think you'll love:

1. **Piranesi** by Susanna Clarke — A man in an impossible house discovers friendship and mystery. Same sense of wonder as Hail Mary but dreamlike and literary. Short, beautiful read.

2. **The Long Way to a Small, Angry Planet** by Becky Chambers — A found-family space crew story with the warmth and humor of Hail Mary but more character-focused. Medium length.

3. **The House in the Cerulean Sea** by TJ Klune — Cozy fantasy about an unlikely friendship. Same heartwarming tone as Rocky and Grace's relationship. Medium length.

Want me to go deeper on any of these? Or if you want a full 10-book curated list with reading order, I can do a Deep Dive (10 TK)."
```

The agent explored (asked questions), understood the intent, and delivered a free Quick Recommendation. If the user wants more, it moves to the paid Deep Dive service with the full AaaS lifecycle.

## Step 7: Watch It Work

As your agent serves users, watch the workspace come alive:

```
book-agent/
├── data/
│   └── books.json              # Growing as agent discovers new books
├── transactions/
│   ├── active/
│   │   └── txn_20260327_001.json   # Current service requests
│   └── archive/
│       └── txn_20260326_001.json   # Completed transactions
├── memory/
│   ├── user_preferences.md     # "User X prefers literary sci-fi"
│   └── operational_notes.md    # "Price API is slow on weekends"
├── .aaas/
│   └── sessions/
│       └── telegram_12345.json # Conversation history with user 12345
```

The agent autonomously manages all of this — expanding its book database, tracking transactions, saving insights to memory, and maintaining conversation context per user.

You can monitor everything through the **dashboard** (web UI), or browse the workspace files directly.

---

## What's Next?

1. **Add more data** — Expand `books.json` or let the agent build it through conversations
2. **Add extensions** — Register a book review API or a library availability checker in `extensions/registry.json`
3. **Connect to more platforms** — Add connectors for Truuze, Discord, or WhatsApp. Each platform gets its own platform skill (`skills/<platform>/SKILL.md`)
4. **Use the dashboard** — Open the web UI to browse data, view transactions, manage extensions, and monitor your agent visually
5. **Configure via chat** — Talk to your agent in admin mode to update its skill, add data, or register extensions without leaving the conversation
6. **Build a second agent** — Try a different domain and see how the same protocol applies

## Common Patterns

### The agent doesn't follow the protocol

Make sure the SKILL.md is in `skills/aaas/SKILL.md` (not the root). The engine loads skills from the `skills/` directory.

### The agent forgets between sessions

Two systems handle persistence:
- **Sessions** (`.aaas/sessions/`) — conversation history per user. Managed automatically.
- **Memory** (`memory/`) — learned facts and insights. The agent writes these autonomously.

Check that the workspace is writable and the agent has permission to write to both directories.

### The agent doesn't use platform features

If connected to a platform like Truuze, make sure there's a platform skill at `skills/<platform>/SKILL.md`. Without it, the agent knows its service but not how to use the platform's specific APIs (escrow, reactions, content posting, etc.).

### Transactions aren't being tracked

The agent creates transactions as JSON files in `transactions/active/`. Make sure the directory exists and is writable. If the agent isn't creating them, the skill instructions may need to be more explicit about the transaction format.

### The agent charges the wrong amount

Check your pricing rules in the skill. Make the formulas unambiguous — agents interpret natural language, so "10 TK for complex requests" is vague. "10 TK for Deep Dive service (10 books with reading order)" is clear.

### I want to configure the agent without editing files

Use the dashboard (web UI) for visual management, or chat with the agent in admin mode. In admin mode, the agent can edit its own skill, update data files, register extensions, and run database queries — all through conversation.
