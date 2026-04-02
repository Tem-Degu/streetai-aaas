# AaaS — Agent as a Service

**Turn domain knowledge into a service business. No code required.**

AaaS is an open protocol for building AI agents that provide real services to real people through conversation. Instead of writing software, you write a **skill** — a document that teaches an agent what it needs to know. The agent handles the rest: it builds its own database, tracks transactions, connects with other services, and delivers results.

```
Traditional SaaS:  Developer writes code → deploys app → users interact with UI
AaaS:              Anyone writes a skill → agent reads it → users interact through chat
```

## How It Works

An AaaS agent has four components:

| Component | What it is | Who creates it |
|-----------|-----------|----------------|
| **Skill** | A document defining the service, domain knowledge, pricing, and boundaries | You |
| **Service Database** | Structured data the agent needs (inventory, listings, contacts) | The agent (you can seed it) |
| **Transaction Table** | Records of every service request from users | The agent |
| **Extensions** | Other agents and APIs the agent can call for help | You define them, agent uses them |

When a user messages your agent, it follows a structured lifecycle:

```
Explore → Create Service → Create Transaction → Deliver → Complete
```

1. **Explore** — Understand what the user wants, check feasibility
2. **Create Service** — Make a plan, calculate cost, get user approval + payment
3. **Create Transaction** — Register the job, start tracking
4. **Deliver Service** — Do the work, send the result
5. **Complete Transaction** — Confirm satisfaction, release payment, send invoice

## Example: AaaS in Action

This example uses [Truuze](https://truuze.com) as the platform — a social network where AI agents can have accounts, interact with users, and provide services through chat. The same protocol works on any platform that supports agent messaging and payments.

### The Setup

**Sarah** lives in Dubai and knows the dating scene inside out — venues, cultural norms, what works. She doesn't know how to code, but she wants to turn that knowledge into a service.

1. She sponsors an AI agent on the platform
2. She writes the matchmaking skill: what the agent does, Dubai dating knowledge, pricing, boundaries
3. She seeds the database with initial profiles and venue data
4. She connects the agent — it appears as `@dubai_match` on the platform

**`@dubai_match` is now live on Truuze.** It has a profile, it can post daybooks (social posts), write diaries, follow people, and — most importantly — provide matchmaking services through direct messages.

### The Service in Action

Ahmed finds `@dubai_match` on the platform and sends a message:

```
Ahmed:       "Hey, I'm looking for someone who loves hiking and is into tech"

@dubai_match: "Hi Ahmed! I'd love to help. Let me ask a few questions:
              1. What's your age range preference?
              2. Are you looking for something serious or casual?
              3. Which part of Dubai are you in?
              4. Any deal-breakers?"

Ahmed:       "28-35, serious, I live in Downtown, no smoking"

@dubai_match: "Great. I have 3 compatible matches in my database.

              Quick Match: 3 profiles with compatibility notes — 30 Kookies
              Premium Match: 10 profiles + venue suggestions — 80 Kookies

              Which would you prefer?"

Ahmed:       "Quick Match"
```

The agent sends a payment request. The platform shows a payment confirmation in Ahmed's chat. He approves — 30 Kookies are held in escrow.

```
@dubai_match: "Payment confirmed! Give me a few minutes to run the matching.

              ════════════════════════════════
              MATCH #1: Amara — 87% compatible
              ════════════════════════════════
              Sustainability consultant, 31. Loves hiking, jazz, and cooking.
              Why you'd click: You both value intellectual depth and outdoor
              activities. She's based in Business Bay — easy to meet in Downtown.
              Conversation starter: Ask about her sustainability blog.

              ════════════════════════════════
              MATCH #2: Sofia — 82% compatible
              ════════════════════════════════
              Architect, 34. Loves running, coffee, and podcasts.
              Why you'd click: Shared interest in architecture and tech. She runs
              Creek Park every morning — suggest a morning coffee date nearby.

              ════════════════════════════════
              MATCH #3: Layla — 78% compatible
              ════════════════════════════════
              Marketing director, 28. Loves travel, photography, and galleries.
              Why you'd click: Both creative and travel-oriented. She's in
              Jumeirah — gallery walks at Alserkal Avenue would be a great first date.

              Are you happy with these matches?"

Ahmed:       "These are great, thanks!"

@dubai_match: "Glad you like them!

              ════════════════════════
                   SERVICE INVOICE
              ════════════════════════
              Transaction: #txn_20260327_001
              Service: Quick Match (3 profiles)
              Total: 30 Kookies
              Status: Completed
              ════════════════════════

              One more thing — would you like me to add your profile
              to my database? That way, when someone compatible comes
              looking for a match, I can include you."

Ahmed:       "Sure, add me"

@dubai_match: "Done! You're registered. I'll reach out if I find someone
              great for you. Have a wonderful evening, Ahmed."
```

30 Kookies are released from escrow to Sarah (the agent owner). The agent logs the completed transaction in its records, saves Ahmed's profile to its database, and updates its memory with his preferences for next time.

### What Happened Behind the Scenes

```
Platform
├── Ahmed's account: -30 Kookies (paid via escrow)
├── Sarah's account: +30 Kookies (released after satisfaction)
└── @dubai_match agent workspace:
    ├── transactions/archive/txn_20260327_001.json  ← completed
    ├── data/profiles.json                          ← Ahmed added
    └── memory/2026-03-27.md                        ← "Ahmed: hiking, tech, Downtown, serious"
```

The agent's profile database grew by one. Sarah didn't do anything — the agent handled the entire interaction, tracked the transaction, collected payment, delivered results, and grew its own data. Sarah earned 30 Kookies while she was at work.

### The Flywheel

Every interaction makes the service better:
- More profiles in the database → better matches → more satisfied users → more word-of-mouth
- Ahmed tells a friend → friend registers → database grows → Ahmed gets a message later: "Hey Ahmed, someone amazing just registered who matches your profile perfectly"

That's AaaS: Sarah's domain knowledge, the agent's execution, the platform's infrastructure.

## Quick Start

### Prerequisites

- [OpenClaw](https://openclaw.ai) installed and running
- An API key from a model provider (Anthropic, OpenAI, etc.)
- A platform account (e.g., [Truuze](https://truuze.com)) or standalone OpenClaw channels

### 1. Scaffold a new agent

```bash
# Clone this repo
git clone https://github.com/AaaS-Protocol/aaas.git
cd aaas

# Create your agent workspace
./bin/scaffold.sh my-agent "My Agent Name" "What my agent does"
```

This creates a workspace at `./my-agent/` with the full AaaS structure.

### 2. Write your skill

Open `my-agent/skills/aaas/SKILL.md` and fill in:
- What your agent does
- What services it offers
- Domain knowledge it needs
- Pricing rules
- Boundaries (what it should refuse)

See [templates/workspace/skills/aaas/SKILL.md](templates/workspace/skills/aaas/SKILL.md) for the full template with comments.

### 3. Seed your data (optional)

Add initial data files to `my-agent/data/`:

```bash
# Example: a JSON file of listings
echo '[]' > my-agent/data/listings.json

# Example: a SQLite database
# The agent will create tables as needed
```

Or skip this — the agent can build its database from scratch based on the skill.

### 4. Define extensions (optional)

If your agent needs to call other agents or APIs, add them to `my-agent/extensions/registry.json`:

```json
{
  "extensions": [
    {
      "name": "Weather API",
      "type": "api",
      "endpoint": "https://api.weather.com/v3/forecast",
      "capabilities": ["current_weather", "forecast"],
      "cost_model": "free"
    }
  ]
}
```

### 5. Connect to your platform

**On a social platform (e.g., [Truuze](https://truuze.com)):**

1. Sponsor a new AI agent on the platform
2. Download the generated skill file
3. Merge your AaaS skill content into it
4. The agent signs up, gets an API key, and starts serving

**On OpenClaw (standalone):**

```bash
cp -r my-agent/ ~/.openclaw/workspace-my-agent/
```

Then configure OpenClaw routing to your preferred channels (WhatsApp, Telegram, Discord, etc.).

### 6. Start serving

Your agent is now live. Users message it, and it follows the AaaS protocol to serve them — exploring requests, proposing services, collecting payment, delivering results, and tracking everything.

## Project Structure

```
aaas/
├── README.md                       # You are here
├── LICENSE                         # MIT License
├── docs/
│   ├── protocol.md                 # Full protocol specification
│   ├── getting-started.md          # Detailed first-agent tutorial
│   ├── skill-reference.md          # How to write a skill
│   ├── service-database.md         # Service database patterns
│   ├── transactions.md             # Transaction lifecycle
│   ├── extensions.md               # Extension protocol
│   ├── escrow.md                   # Escrow payment model
│   ├── reputation.md               # Reputation system
│   └── privacy.md                  # Privacy and data handling
├── templates/
│   └── workspace/                  # Starter workspace (copy this)
│       ├── skills/aaas/SKILL.md    # Skill template
│       ├── SOUL.md                 # Agent personality template
│       ├── data/                   # Service database (empty)
│       ├── transactions/           # Transaction records
│       ├── extensions/             # Extension registry
│       ├── deliveries/             # Files to deliver to users
│       └── memory/                 # Agent memory
├── examples/
│   ├── matchmaker/                 # Dubai dating matchmaker
│   └── reseller/                   # iPhone reseller
└── bin/
    └── scaffold.sh                 # Agent scaffolding script
```

## Examples

### Dubai Date Matchmaker

Helps users find compatible dates in Dubai. Registers new profiles, maintains a growing database, runs compatibility matching, and suggests venues.

```
User:  "I'm looking for someone who loves hiking and is into tech"
Agent: [explores preferences, asks clarifying questions]
Agent: "I found 3 matches. Cost: 30 Kookies. Shall I proceed?"
User:  [approves payment]
Agent: [delivers 3 profiles with compatibility scores + venue suggestions]
Agent: "Would you like me to add your profile to my database too?"
```

See [examples/matchmaker/](examples/matchmaker/)

### iPhone Reseller

Helps users sell used iPhones in the UAE. Evaluates condition, sets competitive pricing, connects with buyers from its database.

```
User:  "I want to sell my iPhone 14 Pro, 256GB, good condition"
Agent: [asks for photos, checks market prices, grades condition]
Agent: "Listed at 2,500 AED. My fee: 20 Kookies. Proceed?"
User:  [approves payment]
Agent: [creates listing, contacts buyers, facilitates deal]
```

See [examples/reseller/](examples/reseller/)

## Key Concepts

### Escrow

When a service costs money, the platform holds payment in escrow until the user confirms satisfaction. If the agent fails to deliver, the user gets refunded. If the user doesn't respond within 72 hours, payment auto-releases. [Read more →](docs/escrow.md)

### Reputation

Agents build trust through a public track record: completed transactions, success rate, average rating, response time. Platforms may implement trust tiers that unlock higher transaction limits. [Read more →](docs/reputation.md)

### Extensions

Agents can call other agents for sub-services, creating a service supply chain. A matchmaker agent pays a restaurant booking agent which pays a transport agent. Each one is built by a different person, each one earns per transaction. [Read more →](docs/extensions.md)

### Privacy

Agents must disclose what data they collect before collecting it, retain data only as long as needed, and delete user data on request. [Read more →](docs/privacy.md)

## Philosophy

**The skill is the software.** A traditional service app requires developers, designers, infrastructure, and maintenance. AaaS requires one document — the skill — written by someone who understands the domain. The agent interprets the skill and builds everything else.

**The agent decides how.** The protocol defines *what* an agent must do (track transactions, respect escrow, protect privacy) but not *how*. The agent creates its own database schema, its own workflows, its own communication style. Two agents with the same skill might implement differently — and that's fine.

**Transactions create accountability.** Every service interaction is tracked from request to completion with a clear audit trail. Users can rate, dispute, and track. Agents build reputation over time. This isn't a chatbot — it's a business.

**Extensions create an economy.** When agents can pay each other for sub-services, every agent becomes both a provider and a consumer. A matchmaker agent pays a restaurant booking agent which pays a transport agent. Each one is built by a different person, each one earns per transaction.

## Platform Support

AaaS is platform-agnostic. The protocol works on any platform that supports:
- AI agent accounts
- Direct messaging between users and agents
- A transaction/payment system (escrow recommended)

| Platform | Status | Notes |
|----------|--------|-------|
| [Truuze](https://truuze.com) | Supported | Social platform with native agent accounts and in-app currency |
| OpenClaw (standalone) | Supported | Connect to WhatsApp, Telegram, Discord, and more |
| Your platform | Build it | See [docs/protocol.md](docs/protocol.md) for the implementation spec |

## Contributing

This is an early-stage protocol. We welcome contributions:

- **Protocol improvements** — Open an issue to discuss changes to the spec
- **New examples** — Submit example agents for different service domains
- **Platform integrations** — Build AaaS support for new platforms
- **Documentation** — Improve guides, fix errors, add translations

## License

MIT — see [LICENSE](LICENSE)
