# AaaS: Agent as a Service

**Turn domain knowledge into a service business. No code required.**

AaaS is an open protocol and CLI toolkit for building AI agents that provide real services to real people through conversation. Instead of writing software, you write a **skill** (a document that teaches an agent what it knows). The agent handles the rest: it builds its own database, tracks transactions, connects with other services, and delivers results.

```
Traditional SaaS:  Developer writes code  ->  deploys app  ->  users interact with UI
AaaS:              Anyone writes a skill  ->  agent reads it  ->  users interact through chat
```

## How It Works

An AaaS agent is built on seven pillars:

| Pillar | What it is | Who creates it |
|--------|-----------|----------------|
| **Skill** | A document defining the service, domain knowledge, pricing, and boundaries | You |
| **Soul** | The agent's personality, tone, and communication style | You |
| **Data** | Structured data the agent needs (inventory, listings, contacts) | The agent (you can seed it) |
| **Transactions** | Records of every service request from users | The agent |
| **Extensions** | Other agents, APIs, and tools the agent can call for help | You define them, agent uses them |
| **Memory** | Persistent facts the agent remembers across conversations | The agent |
| **Connectors** | Platforms and channels the agent listens on | You configure them |

When a user messages your agent, it follows a structured lifecycle:

```
Explore  ->  Create Service  ->  Create Transaction  ->  Deliver  ->  Complete
```

1. **Explore**: Understand what the user wants, check feasibility
2. **Create Service**: Make a plan, calculate cost, get user approval
3. **Create Transaction**: Register the job, start tracking
4. **Deliver Service**: Do the work, send the result
5. **Complete Transaction**: Confirm satisfaction, release payment

## Quick Start

### Install

```bash
npm install -g @streetai/aaas
```

Requires Node.js 18 or later.

### Create an agent

```bash
aaas init my-agent "Lyon Travel Guide" "Helps tourists explore Lyon, France"
cd my-agent
```

This creates a workspace with the full AaaS structure: skill template, soul file, data directory, extensions registry, and configuration.

### Configure your LLM

```bash
aaas config --provider anthropic --model claude-sonnet-4-20250514 --key sk-ant-...
```

Supported providers: Anthropic, OpenAI, Google, Ollama, OpenRouter, Azure.

### Write your skill

Open `.aaas/skills/aaas/SKILL.md` and fill in what your agent does, what services it offers, its domain knowledge, pricing, and boundaries.

### Connect to a platform

```bash
# HTTP API (simplest, includes embeddable chat widget)
aaas connect http --port 3300

# Telegram
aaas connect telegram --token YOUR_BOT_TOKEN

# Discord
aaas connect discord --token YOUR_BOT_TOKEN

# Slack
aaas connect slack --token YOUR_BOT_TOKEN

# WhatsApp (via WhatsApp Business API)
aaas connect whatsapp --token YOUR_ACCESS_TOKEN

# Truuze (social platform with native agent accounts)
aaas connect truuze --token YOUR_PROVISIONING_TOKEN
```

### Start serving

```bash
aaas run
```

Your agent is now live on all connected platforms. Users message it, and it follows the AaaS protocol to serve them.

### Open the dashboard

```bash
aaas dashboard
```

A web dashboard opens in your browser where you can monitor transactions, manage data, edit extensions, view memory, and test conversations with your agent.

## Chat Widget

The HTTP connector includes an embeddable chat widget for websites. Add one script tag:

```html
<script
  src="http://localhost:3300/widget.js"
  data-agent="Lyon Travel Guide"
  data-title="Ask me anything about Lyon"
  data-color="#2563eb"
  data-position="right"
  data-greeting="Bonjour! How can I help you explore Lyon?"
></script>
```

The widget renders a floating chat button on your site. No build step, no dependencies.

## CLI Commands

| Command | Description |
|---------|-------------|
| `aaas init <dir>` | Create a new agent workspace |
| `aaas status` | Show workspace overview |
| `aaas skill` | View and validate the agent skill |
| `aaas config` | Configure LLM provider and model |
| `aaas data list/view/add/remove` | Manage the service database |
| `aaas transactions list/view/stats` | View and filter transactions |
| `aaas extensions list/add/remove/test` | Manage extensions |
| `aaas logs` | View recent memory and activity |
| `aaas chat` | Chat with your agent in the terminal |
| `aaas connect <platform>` | Connect to a platform |
| `aaas connections` | List active connections |
| `aaas disconnect <platform>` | Remove a connection |
| `aaas run` | Start the agent on all connected platforms |
| `aaas stop` | Stop a running agent |
| `aaas dashboard` | Open the web dashboard |

## Extensions

Agents can call external APIs, other agents, human contacts, and local tools through extensions. The extension system supports multiple auth types (Bearer, custom header, query parameter, Basic auth), custom headers, and all HTTP methods.

Extensions also enable payment flows. When a service involves payments through an external provider like Stripe or PayPal, the agent creates a payment link via the extension, sends it to the user, and verifies the payment status when the user confirms.

```json
{
  "name": "Stripe Payments",
  "type": "api",
  "endpoint": "https://api.stripe.com/v1",
  "auth": {
    "type": "bearer",
    "apiKey": "sk_live_..."
  },
  "capabilities": ["create_payment_link", "verify_payment"],
  "cost_model": "per_request"
}
```

See [docs/extensions.md](docs/extensions.md) for the full spec.

## Dashboard

The web dashboard gives you a complete view of your running agent:

- **Overview**: Revenue, active/completed transactions, connected platforms, memory stats
- **Skill & Soul**: View and edit the agent's knowledge base and personality
- **Data**: Browse and manage the service database
- **Transactions**: Full history with detail views, filtering, and revenue breakdowns
- **Extensions**: Register, configure, and test extensions with all auth types
- **Memory**: View the agent's stored facts
- **Connections**: See which platforms are connected
- **Chat**: Test conversations with the agent directly
- **Guide**: Setup instructions for each connector
- **Deploy**: Deployment options and API endpoint reference

## Project Structure

```
aaas/
├── src/
│   ├── cli/                  # CLI commands (init, config, run, connect, etc.)
│   ├── connectors/           # Platform connectors (HTTP, Telegram, Discord, etc.)
│   ├── engine/               # Core agent engine, prompts, and tool definitions
│   ├── server/               # Dashboard API server
│   ├── widget/               # Embeddable chat widget
│   ├── auth/                 # Authentication utilities
│   └── utils/                # Shared helpers
├── dashboard/                # React web dashboard (Vite + React)
│   ├── src/pages/            # Dashboard pages
│   └── dist/                 # Pre-built dashboard (shipped with npm package)
├── docs/                     # Protocol documentation
│   ├── protocol.md           # Full protocol specification
│   ├── extensions.md         # Extension protocol and payment flows
│   ├── skill-reference.md    # How to write a skill
│   ├── transactions.md       # Transaction lifecycle
│   └── ...
└── examples/                 # Example agent workspaces
```

## Platform Support

AaaS ships with connectors for six platforms plus a general-purpose HTTP API:

| Platform | Connector | Notes |
|----------|-----------|-------|
| HTTP API | `aaas connect http` | REST API + embeddable chat widget |
| Telegram | `aaas connect telegram` | Bot API integration |
| Discord | `aaas connect discord` | Bot integration |
| Slack | `aaas connect slack` | App integration |
| WhatsApp | `aaas connect whatsapp` | Business API integration |
| Truuze | `aaas connect truuze` | Social platform with native agent accounts and in-app currency |

You can connect to multiple platforms at the same time. Run `aaas run` and the agent serves on all of them.

## Example: AaaS in Action

Sarah lives in Dubai and knows the dating scene inside out. She doesn't know how to code, but she wants to turn that knowledge into a service.

1. She installs AaaS and creates an agent workspace
2. She writes the matchmaking skill: what the agent does, Dubai dating knowledge, pricing, boundaries
3. She seeds the database with initial profiles and venue data
4. She connects the agent to her preferred platforms

The agent is now live. When Ahmed messages asking for help finding a date, the agent explores his preferences, proposes a service tier, collects payment, delivers curated matches with compatibility scores, and logs the completed transaction. Sarah earns money while the agent does the work.

Every interaction makes the service better: more profiles in the database means better matches, which means more satisfied users, which means more word of mouth.

## Philosophy

**The skill is the software.** A traditional service app requires developers, designers, infrastructure, and maintenance. AaaS requires one document written by someone who understands the domain. The agent interprets the skill and builds everything else.

**The agent decides how.** The protocol defines *what* an agent must do (track transactions, respect escrow, protect privacy) but not *how*. The agent creates its own database schema, its own workflows, its own communication style.

**Transactions create accountability.** Every service interaction is tracked from request to completion with a clear audit trail. Users can rate, dispute, and track. Agents build reputation over time.

**Extensions create an economy.** When agents can call other agents and APIs, every agent becomes both a provider and a consumer. A matchmaker agent pays a restaurant booking agent which pays a transport agent. Each one is built by a different person, each one earns per transaction.

## Contributing

This is an early-stage project. Contributions are welcome:

- **Protocol improvements**: Open an issue to discuss changes to the spec
- **New examples**: Submit example agents for different service domains
- **Connectors**: Build support for new platforms
- **Documentation**: Improve guides, fix errors, add translations

## License

MIT. See [LICENSE](LICENSE).
