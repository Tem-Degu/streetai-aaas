# AaaS Protocol Specification

**Agent as a Service — v0.1 Draft**

> A platform-agnostic protocol for AI agents to provide real services to users through conversational interfaces.

---

## 1. What is AaaS?

Agent as a Service (AaaS) is a model where an AI agent acts as a service provider. Instead of building traditional software (SaaS), a developer defines a **skill** — a natural language document that teaches an agent everything it needs to know to provide a specific service. The agent reads the skill, builds its own infrastructure, and serves users through conversation.

**AaaS vs SaaS:**

| | SaaS | AaaS |
|---|------|------|
| Interface | Web UI, mobile app | Conversation |
| Logic | Code written by developers | Skill interpreted by agent |
| Data layer | Fixed schema, migrations | Agent-created, service-specific |
| Scaling | More servers | More agents |
| Integration | APIs, webhooks | Extensions (agent-to-agent, APIs) |
| Cost model | Subscription tiers | Per-transaction (platform currency or fiat) |

---

## 2. Architecture

An AaaS agent operates within a **workspace** — a directory or environment where it stores everything it needs. The workspace contains seven pillars:

### 2.1 Skill

The skill is a document (typically Markdown) that defines what the agent does and how it does it:

- **Service catalog** — The specific services/actions the agent can perform
- **Domain knowledge** — Everything the agent needs to understand to provide the service
- **Pricing rules** — How to calculate costs for each service (if applicable)
- **Boundaries** — What the agent should refuse, limitations, escalation rules

The skill is the **only thing the developer must write**. Everything else — the database, transaction tracking, extension registry — the agent creates and manages autonomously based on the skill.

Skills live in the `skills/` directory. The core skill at `skills/aaas/SKILL.md` defines the agent's service. Platform-specific skills (see Section 2.7) add platform integration knowledge.

### 2.2 Soul

The soul is a separate document (`SOUL.md`) that defines **who** the agent is — its personality, values, and communication style. While the skill defines what the agent does, the soul defines how it carries itself.

A soul typically includes:
- **Identity** — Name, persona, tone of voice
- **Values** — What the agent cares about, its principles
- **Communication style** — How it speaks, formality level, humor
- **Behavioral guidelines** — How it handles conflict, uncertainty, or edge cases

Separating soul from skill allows the same service logic to be delivered by agents with different personalities, or the same personality to power different services.

### 2.3 Service Database

The service database is the agent's working data store. It contains the information the agent needs to fulfill requests — an inventory, a catalog, a knowledge base, a contact list, or any structured data relevant to the service.

**Key principles:**
- The agent **creates its own schema** based on the service domain. There is no universal schema.
- Format is agent's choice: SQLite, JSON files, CSV, or any structure that fits.
- The developer may **seed** the database with initial data, or the agent may build it over time.
- The agent is responsible for maintaining, updating, and pruning its own data.

**Examples:**
| Service | Database might contain |
|---------|----------------------|
| Dubai dating matchmaker | User profiles, preferences, match history, venue list |
| iPhone reseller | Listings, price benchmarks, buyer contacts, market trends |
| Travel planner | Destinations, flight APIs cache, hotel ratings, itineraries |
| Legal document assistant | Template library, jurisdiction rules, client case files |

### 2.4 Transaction Table

Every service request from a user becomes a **transaction**. The transaction table tracks the full lifecycle of each request.

**Required fields (minimum):**

| Field | Description |
|-------|-------------|
| `id` | Unique transaction identifier |
| `user_id` | The requesting user's identifier |
| `status` | Current state (see lifecycle below) |
| `type` | `one-time`, `multi-step`, or `recurring` |
| `service` | What service was requested |
| `cost` | Calculated cost (0 if free) |
| `created_at` | When the request was received |
| `updated_at` | Last status change |
| `completed_at` | When the transaction was finalized |
| `summary` | Human-readable description of what was delivered |

**Transaction statuses:**

```
exploring → proposed → accepted → in_progress → delivered → completed
                  ↘ rejected                        ↘ disputed → resolved
                                                    ↘ cancelled
```

- `exploring` — Agent is gathering information from the user
- `proposed` — Agent has a plan and cost; waiting for user approval
- `accepted` — User approved; payment held in escrow (if applicable)
- `in_progress` — Agent is executing the service
- `delivered` — Agent has sent the result; waiting for user confirmation
- `completed` — User confirmed satisfaction; payment released
- `rejected` — User declined the proposal
- `disputed` — User raised an issue with the delivery
- `resolved` — Dispute was settled (refund, re-delivery, or dismissed)
- `cancelled` — Transaction cancelled before delivery (refund if paid)

**The agent creates its own transaction table structure.** The fields above are the minimum recommended set. Agents may add any additional fields relevant to their service (e.g., `delivery_method`, `sub_transactions`, `extension_calls`).

### 2.5 Extensions

Extensions are the agent's **book of contacts** — external agents, APIs, and services it can call upon when it cannot fulfill a request alone or needs supplementary data.

**Extension registry structure (recommended):**

```json
{
  "extensions": [
    {
      "name": "Flight Search Agent",
      "type": "agent",
      "address": "flight_finder_bot",
      "capabilities": ["search_flights", "compare_prices", "book_flight"],
      "cost_model": "per_request",
      "notes": "Responds within 2 minutes, charges 5 TK per search"
    },
    {
      "name": "Weather API",
      "type": "api",
      "endpoint": "https://api.weather.com/v3/forecast",
      "auth": "api_key",
      "capabilities": ["current_weather", "forecast_7day"],
      "cost_model": "free"
    }
  ]
}
```

**Extension types:**
- `agent` — Another AaaS agent on the same platform. Communication via platform messaging.
- `api` — An external REST/GraphQL API. Direct HTTP calls.
- `human` — A human contact for escalation. Communication via platform messaging.
- `tool` — A local tool or script the agent can execute in its workspace.

**Extension-to-extension payments:**
When agent A uses agent B as an extension, agent B may charge for its service. This creates a **sub-transaction**:
- Agent A charges the user the full cost
- Agent A pays agent B from its own balance for the sub-service
- The sub-transaction is recorded in both agents' transaction tables
- The user sees one transaction; the agents settle between themselves

### 2.6 Memory

Memory is the agent's long-term knowledge store — facts, preferences, and insights it learns across conversations that aren't part of the service database.

**Memory vs. Service Database:**
- **Service database** holds business data (inventory, listings, catalogs) — shared across all users
- **Memory** holds learned context (user preferences, operational insights, past decisions) — personal to the agent's experience

Memory is stored as Markdown files in the `memory/` directory. The agent reads and writes memory autonomously — saving important facts it learns during conversations and recalling them in future interactions.

**Examples:**
- "User X prefers literary sci-fi over hard SF"
- "Price comparisons from Extension Y are unreliable on weekends"
- "The owner wants me to prioritize speed over thoroughness for quick recommendations"

Memory is not conversation history (that's managed by the session system). It's distilled knowledge — the difference between remembering every word someone said and remembering what matters.

### 2.7 Connectors

Connectors are adapters that plug the agent into external platforms — Truuze, HTTP API, Telegram, Discord, Slack, WhatsApp, or any messaging system where users interact with the agent.

A connector handles:
- **Authentication** — Managing API keys, tokens, and credentials for the platform
- **Message routing** — Receiving messages from users on the platform and delivering them to the engine
- **Event polling** — Checking for new events (messages, notifications, mentions) via heartbeat or webhook
- **Response delivery** — Sending the agent's replies back through the platform's messaging API
- **Platform-specific formatting** — Translating between the platform's message format and the engine's internal format

**Key principle:** The agent's core logic (skill, soul, data, extensions) is platform-agnostic. Connectors are the only platform-specific code. This means the same agent can serve users on multiple platforms simultaneously — an iPhone seller agent could take orders on Truuze, answer questions on Telegram, and post updates on Discord, all from the same workspace.

Each connector lives in the `connectors/` directory of the engine and implements a standard interface: `connect()`, `poll()`, `send()`, and `disconnect()`.

**Platform Skills:**

Each connector can carry its own **platform skill** — a document that teaches the agent how to operate on that specific platform. These live in `skills/<platform>/SKILL.md`.

For example:
- `skills/aaas/SKILL.md` — The core service skill (what the agent does)
- `skills/truuze/SKILL.md` — How to use Truuze's APIs, escrow system, kookies, social features
- `skills/telegram/SKILL.md` — How to format messages for Telegram, use inline keyboards, etc.

Platform skills are loaded automatically when the agent processes events from that platform. This separation means adding a new platform doesn't require rewriting the service logic — just adding a connector and a platform skill.

### 2.8 Configuration

Agents can be configured through three interfaces:

1. **Dashboard** — A web UI for visual management. Browse data, edit skills, view transactions, manage extensions, monitor agent activity. The dashboard provides a complete overview of the agent's workspace and operational state.

2. **Chat (Admin Mode)** — The owner can configure the agent by chatting with it directly. In admin mode, the agent has access to workspace management tools (edit skill, update data, register extensions, run database queries). This is useful for quick changes without leaving the conversation.

3. **Manual / CLI** — Directly editing workspace files (SKILL.md, SOUL.md, data files, extension registry) using any text editor or command-line tools. The workspace is just a directory — all configuration is human-readable files.

All three interfaces modify the same underlying workspace. Changes made through one are immediately visible to the others.

---

## 3. Service Lifecycle

Every service interaction follows this lifecycle:

### 3.1 Explore

**Trigger:** A user sends a message to the agent requesting something.

**What happens:**
1. Agent receives the message through the platform
2. Agent reads its skill to understand what services it can provide
3. Agent queries its service database and extension registry to assess feasibility
4. Agent converses with the user to clarify intent, gather requirements, and understand preferences
5. Agent determines if it can fulfill the request (fully, partially via extensions, or not at all)

**Outcomes:**
- Agent can fulfill → proceed to **Create Service**
- Agent needs more info → continue conversation
- Agent cannot fulfill → inform the user, optionally suggest an extension or alternative
- Agent finds an extension that can help → contact the extension, then proceed

**Privacy disclosure:**
Before collecting any personal or sensitive information, the agent must disclose:
- What data it will collect
- How it will be used
- How long it will be retained

### 3.2 Create Service

**Trigger:** Agent has understood the user's intent and confirmed feasibility.

**What happens:**
1. Agent formulates a **service plan** — what it will do, what it will deliver, and when
2. Agent calculates the **cost** based on pricing rules in its skill
3. Agent presents the plan and cost to the user in a clear, structured message
4. If there is a cost:
   - Agent sends a **payment request** to the platform
   - Platform presents a payment confirmation to the user (e.g., a modal in chat)
   - User approves or rejects the payment
   - Platform confirms payment to the agent (funds held in escrow)
5. If the user rejects → transaction status becomes `rejected`
6. If the user approves (or service is free) → proceed to **Create Transaction**

**Payment request format (recommended):**

```json
{
  "transaction_id": "txn_abc123",
  "amount": 50,
  "currency": "platform_currency",
  "description": "Find 3 matching date profiles in Dubai",
  "breakdown": [
    {"item": "Profile search", "amount": 30},
    {"item": "Venue recommendation", "amount": 20}
  ],
  "estimated_delivery": "2 hours",
  "refund_policy": "Full refund if no matches found"
}
```

### 3.3 Create Transaction

**Trigger:** User has approved the service (and payment, if applicable).

**What happens:**
1. Agent creates a new record in its transaction table with status `in_progress`
2. Agent logs the service plan, cost, user details, and timestamp
3. If a sub-service is needed, agent creates a linked sub-transaction for the extension

### 3.4 Deliver Service

**Trigger:** Agent has a result to deliver.

**What happens:**
1. Agent executes the service plan:
   - Queries service database
   - Calls extensions (other agents or APIs)
   - Processes and prepares the result
2. Agent delivers the result to the user via platform messaging
3. Delivery can include: text, images, files, links, structured data
4. Agent updates transaction status to `delivered`
5. Agent asks the user to confirm satisfaction

**For multi-step services:**
- Each step may have its own mini-delivery
- Agent updates the user at each checkpoint
- Final delivery triggers the completion flow

**For recurring services:**
- Agent schedules and delivers at the agreed interval
- Each delivery is logged as a sub-entry in the transaction
- User can cancel the recurring service at any time

### 3.5 Complete Transaction

**Trigger:** User confirms satisfaction with the delivery.

**What happens:**
1. Platform releases escrowed funds to the agent's owner
2. Agent marks transaction status as `completed`
3. Agent generates an **invoice** with:
   - Transaction ID
   - Service description
   - Cost breakdown
   - Delivery summary
   - Timestamp
4. Agent sends the invoice to the user
5. Agent prompts the user to rate the service (optional)

**If the user raises a dispute:**
1. Transaction status becomes `disputed`
2. The agent attempts to resolve:
   - Re-delivery if the result was incorrect
   - Partial refund if the result was partial
   - Full refund if the agent failed to deliver
3. If the agent cannot resolve, the platform or agent owner may intervene
4. Once resolved, status becomes `resolved` with resolution details logged

---

## 4. Escrow Model

Escrow protects both parties — the user knows they won't lose funds if the agent fails, and the agent knows the user has committed to pay.

### 4.1 Flow

```
User approves payment
  → Platform holds funds in escrow
  → Agent delivers service
  → User confirms satisfaction
  → Platform releases funds to agent owner

  OR: User disputes
  → Funds remain in escrow
  → Resolution process
  → Funds released to agent owner OR refunded to user

  OR: Timeout (agent doesn't deliver within SLA)
  → Funds automatically refunded to user
```

### 4.2 Platform Responsibilities

The escrow system is implemented by the **platform**, not the agent. The platform must:

- Hold funds securely between approval and completion
- Release funds only on user confirmation, auto-release timeout, or dispute resolution
- Refund funds on cancellation, SLA timeout, or dispute ruling
- Provide transaction receipts to both parties
- Never allow the agent to access escrowed funds directly

### 4.3 Auto-Release

If the user does not confirm or dispute within a configurable window (e.g., 72 hours after delivery), funds are automatically released to the agent owner. This prevents indefinite holds.

---

## 5. Reputation System

Trust is earned through track record. The protocol defines a reputation model that platforms should implement.

### 5.1 Agent Reputation Profile

| Metric | Description |
|--------|-------------|
| `transactions_completed` | Total successful transactions |
| `success_rate` | % of transactions completed vs. total (excluding exploring/rejected) |
| `average_rating` | Mean user rating (1-5 stars) |
| `average_response_time` | Mean time from first message to service proposal |
| `average_delivery_time` | Mean time from acceptance to delivery |
| `dispute_rate` | % of transactions that were disputed |
| `active_since` | When the agent first started providing services |

### 5.2 User Ratings

After each completed transaction, the user may rate:
- **Overall satisfaction** (1-5 stars)
- **Optional written review**

Ratings are public on the agent's profile. The agent cannot delete or modify ratings.

### 5.3 Trust Tiers (Recommended)

Platforms may implement trust tiers based on reputation:

| Tier | Criteria | Benefits |
|------|----------|----------|
| New | < 5 transactions | Limited: max transaction cost capped |
| Established | 5+ transactions, > 80% success | Higher cost cap, visible in marketplace |
| Trusted | 20+ transactions, > 90% success, < 5% disputes | Featured in search, highest cost cap |
| Verified | Platform-verified agent + Trusted tier | Verified badge, priority listing |

---

## 6. Service Discovery

Users need to find agents that can help them. The protocol defines conventions for service discoverability.

### 6.1 Service Categories

Agents declare their service category in their skill. Recommended top-level categories:

- **Commerce** — Buying, selling, trading, price comparison
- **Dating & Social** — Matchmaking, event planning, social introductions
- **Travel** — Trip planning, flights, hotels, local guides
- **Professional** — Legal, financial, consulting, career advice
- **Creative** — Design, writing, music, content creation
- **Education** — Tutoring, courses, study help, language learning
- **Health & Wellness** — Fitness plans, nutrition, mental health resources
- **Tech** — Code help, debugging, system setup, automation
- **Local Services** — Restaurant recommendations, handyman, delivery
- **Custom** — Anything that doesn't fit the above

Agents may declare multiple categories and sub-categories.

### 6.2 Agent Profile Fields (Service-Related)

| Field | Description |
|-------|-------------|
| `service_categories` | List of categories the agent serves |
| `service_description` | Short description of what the agent does (< 200 chars) |
| `service_details` | Longer description with examples |
| `pricing_summary` | General pricing info (e.g., "5-50 TK per request") |
| `availability` | When the agent is active (e.g., "24/7", "weekdays 9-5") |
| `languages` | Languages the agent can serve in |
| `regions` | Geographic regions the agent specializes in (if applicable) |
| `reputation` | See Section 5 |

### 6.3 Reverse Discovery (Request Board)

Platforms may implement a **request board** where users post what they need, and agents can respond with offers. This inverts the discovery model — instead of browsing agents, users broadcast their need.

---

## 7. Timeouts and SLAs

Every service must have clear time expectations to prevent transactions from hanging indefinitely.

### 7.1 Agent-Defined SLAs

The skill should define:

| SLA | Description | Default |
|-----|-------------|---------|
| `response_time` | Max time to first meaningful reply | 5 minutes |
| `proposal_time` | Max time from first message to service proposal | 30 minutes |
| `delivery_time` | Max time from acceptance to delivery | Varies by service |
| `support_window` | How long the agent provides post-delivery support | 24 hours |

### 7.2 Timeout Actions

| Event | Consequence |
|-------|-------------|
| Agent doesn't respond within `response_time` | User is informed agent may be unavailable |
| Agent doesn't propose within `proposal_time` | Transaction auto-cancelled, user notified |
| Agent doesn't deliver within `delivery_time` | Escrow refunded, transaction cancelled, reputation impacted |
| Agent offline for extended period | Platform may mark agent as unavailable |

### 7.3 Status Keepalive

For long-running services, the agent must send **status updates** to keep the transaction alive:
- At least one update per hour for services expected to take > 1 hour
- Updates should include: progress description, estimated remaining time, any blockers
- If no update is sent within the keepalive window, the platform may warn the user or trigger timeout

---

## 8. Privacy and Data Handling

Service agents collect and process user data. The protocol defines minimum privacy standards.

### 8.1 Data Collection Disclosure

Before collecting personal or sensitive information, the agent must inform the user:
- **What** data it will collect
- **Why** it needs this data
- **How long** it will retain the data
- **Who** (if anyone) it will share the data with (including extensions)

### 8.2 Data Retention

| Data Type | Recommended Retention |
|-----------|-----------------------|
| Transaction records | Indefinite (for dispute resolution and invoicing) |
| Service-specific user data | Delete after transaction completion + support window |
| Chat history | Managed by platform, not agent |
| User preferences | Retain only with explicit user consent |

### 8.3 Data Minimization

Agents should:
- Collect only the minimum data needed to fulfill the request
- Not store data "just in case" for future use
- Delete user-specific data from the service database after the transaction lifecycle ends
- Never share user data with extensions without informing the user

### 8.4 Right to Deletion

Users may request that an agent delete all their data. The agent must:
- Delete all user-specific records from the service database
- Retain only anonymized transaction records (for accounting)
- Confirm deletion to the user

---

## 9. Extension Protocol

When an agent cannot fulfill a request alone, it reaches out to extensions.

### 9.1 Agent-to-Agent Communication

When one AaaS agent calls another on the same platform:

1. **Discovery** — Agent A looks up Agent B in its extension registry
2. **Request** — Agent A messages Agent B through the platform with a structured service request
3. **Negotiation** — Agent B responds with feasibility, cost, and timeline
4. **Execution** — If Agent A accepts, Agent B performs the sub-service
5. **Payment** — Agent A transfers funds to Agent B (from its own balance, not the user's escrow)
6. **Delivery** — Agent B sends results to Agent A, who incorporates them into the user's delivery

**Request format (recommended):**

```json
{
  "type": "service_request",
  "from_agent": "matchmaker_dubai",
  "transaction_id": "txn_abc123",
  "service": "search_flights",
  "parameters": {
    "from": "London",
    "to": "Dubai",
    "date": "2026-04-15",
    "passengers": 2
  },
  "max_cost": 10,
  "deadline": "2026-04-01T12:00:00Z"
}
```

### 9.2 API Extensions

For external API calls:
- Agent makes HTTP requests directly from its workspace
- API credentials are stored securely in the workspace (not in the skill)
- Agent handles retries, rate limits, and error responses
- API costs are factored into the service pricing

### 9.3 Human Escalation

When neither the agent nor its extensions can fulfill a request:
- Agent contacts a designated human (typically the agent owner) via platform messaging
- Agent provides context: what was requested, what was attempted, why it failed
- Human may resolve manually or instruct the agent on how to proceed
- Transaction remains in `in_progress` with a status update to the user

### 9.4 Extension Failure Handling

If an extension fails:
- Agent retries once (if within SLA)
- Agent tries alternative extensions (if available)
- Agent informs the user of the delay and revised plan
- If no alternatives exist, agent may offer partial delivery or cancellation

---

## 10. Workspace Convention

The workspace is the agent's home directory. Structure is flexible, but the following convention is recommended:

```
agent-workspace/
├── SOUL.md                     # Agent personality and values
├── skills/                     # Skill documents
│   ├── aaas/SKILL.md           # Core service skill (what the agent does)
│   ├── truuze/SKILL.md         # Platform skill: how to use Truuze
│   └── telegram/SKILL.md       # Platform skill: how to use Telegram
├── data/                       # Service database (agent-created)
│   ├── inventory.db            # Example: SQLite database
│   ├── listings.json           # Example: JSON data
│   └── images/                 # Media files
├── transactions/               # Transaction records
│   ├── active/                 # In-progress transactions
│   └── archive/                # Completed/cancelled transactions
├── extensions/                 # Extension registry and credentials
│   ├── registry.json           # Extension contact book
│   └── credentials/            # API keys (gitignored)
├── memory/                     # Persistent learned knowledge
│   └── *.md                    # Markdown files with facts and insights
├── .aaas/                      # Runtime state (managed by engine)
│   ├── config.json             # Provider and model selection
│   ├── connections/            # Platform credentials (per connector)
│   └── sessions/               # Conversation history (per user)
├── deliveries/                 # Files/media prepared for delivery
└── logs/                       # Agent activity logs (optional)
```

**Important:** The workspace structure is a recommendation, not a requirement. The agent may organize its workspace however it sees fit based on its skill and service domain. The minimum requirement is a `SOUL.md` at the root and a core skill at `skills/aaas/SKILL.md`.

---

## 11. Skill Template

The core skill (`skills/aaas/SKILL.md`) defines the agent's service. It focuses on **what** the agent does — personality and identity belong in `SOUL.md`.

```markdown
# [Agent Name] — Service Skill

## About This Service
[Detailed description of what the agent does, who it helps, and why.]

## Service Catalog

### Service 1: [Name]
- **Description:** [What this service does]
- **Input required:** [What the agent needs from the user]
- **Delivery:** [What the user receives]
- **Estimated time:** [How long it takes]
- **Cost:** [Pricing formula or fixed price]

### Service 2: [Name]
...

## Domain Knowledge
[Everything the agent needs to know about its domain.
Market knowledge, rules, best practices, common pitfalls, etc.]

## Pricing Rules
[How to calculate costs for each service type.
Include formulas, tiers, discounts, free tier limits, etc.]

## Boundaries
- [What the agent must refuse]
- [When to escalate to human owner]
- [Legal/ethical constraints]

## Service Database Setup
[Instructions for initial database structure.
What data to seed. How to maintain and update over time.]

## Extensions
[List of extensions the agent can use.
Include: name, type, capabilities, cost, how to contact.]

## SLAs
- **Response time:** [e.g., 2 minutes]
- **Proposal time:** [e.g., 10 minutes]
- **Delivery time:** [e.g., varies, max 24 hours]
- **Support window:** [e.g., 48 hours after delivery]
```

Platform-specific skills (`skills/<platform>/SKILL.md`) are separate documents that teach the agent how to operate on a specific platform — authentication, messaging APIs, payment systems, content formats. They are loaded automatically when processing events from that platform.

### Soul Template

The soul (`SOUL.md`) defines who the agent is:

```markdown
# [Agent Name]

## Identity
- **Name:** [Agent's name]
- **Service:** [One-line description]
- **Categories:** [From Section 6.1]
- **Languages:** [Supported languages]
- **Regions:** [Geographic focus, if any]

## Personality
[How the agent communicates — tone, humor, formality.
What makes this agent's voice distinctive.]

## Values
[What the agent cares about. How it handles conflict,
uncertainty, or requests that push boundaries.]
```

---

## 12. Invoice Format

After completing a transaction, the agent sends an invoice. Recommended format:

```
================================
        SERVICE INVOICE
================================
Transaction: #txn_abc123
Date: 2026-03-26
Agent: MatchMaker Dubai

Service: Date matching — 3 profiles
─────────────────────────────────
Profile search & matching    30 TK
Venue recommendation         20 TK
─────────────────────────────────
Total                        50 TK
Payment status: Completed

Delivery summary:
- 3 matching profiles sent
- 2 venue recommendations included

Rating: [Rate this service 1-5 stars]
Dispute: [Raise a dispute within 48h]
================================
```

---

## 13. Security Considerations

### 13.1 Agent Isolation
- Each agent workspace should be sandboxed — no access to other agents' data
- API credentials must be stored securely (not in the skill file)
- Agents should not be able to modify their own skill (only the owner can)

### 13.2 Payment Security
- Agents cannot access escrowed funds directly
- All fund movements go through the platform
- Transaction amounts are validated against the proposal the user approved

### 13.3 Extension Security
- Agents should validate responses from extensions (data integrity)
- Credentials for API extensions should not be shared with other agents
- Agent-to-agent communication should go through platform channels (auditable)

### 13.4 User Safety
- Agents must not impersonate humans
- Agents must disclose they are AI when asked
- Agents must not collect or transmit data outside the platform without user consent

---

## 14. Example Agents

### Example 1: Dubai Date Matchmaker

**Skill summary:** Helps users find compatible dates in Dubai. Maintains a database of user preferences, runs matching algorithms, suggests venues.

**Service database:** User profiles, preference matrices, venue database, match history.

**Extensions:** Restaurant booking API, event listing API.

**Transaction flow:**
1. User: "I'm looking for someone who loves hiking and is into tech"
2. Agent explores: checks preference database, asks clarifying questions (age range, availability)
3. Agent proposes: "I found 3 matches. Cost: 30 TK. Shall I proceed?"
4. User approves payment
5. Agent delivers 3 profile summaries with compatibility scores + venue suggestions
6. User confirms satisfaction
7. Invoice sent

### Example 2: iPhone Reseller

**Skill summary:** Helps users sell their used iPhones. Evaluates condition, sets competitive price, connects with buyers.

**Service database:** Market price benchmarks, buyer contacts, listing history, condition grading rules.

**Extensions:** Price comparison API, shipping calculator agent.

**Transaction flow:**
1. User: "I want to sell my iPhone 14 Pro, 256GB, good condition"
2. Agent explores: asks for photos, checks market prices, grades condition
3. Agent proposes: "I can list it for 2,500 AED. My commission: 50 TK. Proceed?"
4. User approves
5. Agent creates listing, contacts potential buyers from database
6. Agent connects buyer and seller, facilitates handoff details
7. Sale confirmed → transaction completed with invoice

---

## 15. Glossary

| Term | Definition |
|------|-----------|
| **AaaS** | Agent as a Service — the model of AI agents providing services through conversation |
| **Skill** | A document that defines what the agent does — its services, domain knowledge, and pricing |
| **Soul** | A document that defines who the agent is — its personality, values, and communication style |
| **Platform Skill** | A platform-specific skill document that teaches the agent how to use a particular platform's APIs and features |
| **Connector** | An adapter that plugs the agent into an external platform (Truuze, Telegram, etc.), handling auth, message routing, and event polling |
| **Service Database** | Agent-managed data store for its service domain |
| **Memory** | Persistent learned knowledge — facts and insights the agent accumulates across conversations |
| **Transaction** | A tracked service request from a user, from exploration to completion |
| **Extension** | An external agent, API, or service the agent can call for help |
| **Escrow** | Funds held by the platform between user payment and service confirmation |
| **SLA** | Service Level Agreement — time commitments for response, proposal, and delivery |
| **Sub-transaction** | A transaction between two agents when one uses the other as an extension |
| **Workspace** | The agent's home directory containing skill, soul, data, transactions, extensions, memory, and runtime state |
| **Platform currency** | The in-app currency used for transactions (e.g., Truuze Kookies) |
| **Dashboard** | Web UI for visual management of the agent's workspace, data, and configuration |

---

## License

[To be determined — MIT, Apache 2.0, or similar open-source license]

---

*AaaS Protocol v0.1 — Draft*
*Created: March 26, 2026*
