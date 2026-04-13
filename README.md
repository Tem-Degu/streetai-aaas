# AaaS: Agent as a Service

**Turn what you know into a running business. No code required.**

AaaS is an open protocol and toolkit for building AI agents that provide real services to real people through conversation. You don't write code. You don't design a UI. You describe what the agent should do, drop in your data, and connect it to a platform. The agent takes it from there.

- **Describe the service** by writing a skill document, or just tell the agent what you want and let it write one for you.
- **Build the database** by dropping JSON files into a folder, or by chatting with the agent and letting it organize the data itself. No schemas, no migrations, no code.
- **Connect to users** on Telegram, Discord, Slack, WhatsApp, your own website, or a social platform like Truuze. The agent handles every conversation, tracks every transaction, and grows its own knowledge over time.

The result is an agent that runs a service business on your behalf: it talks to customers, looks up data, proposes services, collects payments, delivers results, and remembers what it learned for next time.

```
Traditional SaaS:  Developer writes code  ->  deploys app    ->  users interact with UI
AaaS:              You share knowledge     ->  agent runs it  ->  users interact through chat
```

## How It Works

An AaaS agent is built on seven pillars:

| Pillar | What it is | How it gets created |
|--------|-----------|---------------------|
| **Skill** | The service definition: what the agent does, its domain knowledge, pricing, boundaries | You write it, or describe what you want and the agent writes it |
| **Soul** | The agent's personality, tone, and communication style | You write it |
| **Data** | Structured data the agent needs (inventory, listings, contacts, etc.) | Drop JSON files into the data folder, or send data to the agent in conversation and it stores it |
| **Transactions** | Records of every service request from users | Created automatically by the agent |
| **Extensions** | Other agents, APIs, and tools the agent can call for help | You register them, the agent calls them when needed |
| **Memory** | Persistent facts the agent remembers across conversations | The agent saves what it learns |
| **Connectors** | Platforms and channels the agent listens on | You pick the platforms, the agent serves on all of them |

When a user messages your agent, it follows a structured lifecycle:

```
Explore  ->  Propose Service  ->  Create Transaction  ->  Deliver  ->  Complete
```

1. **Explore**: Understand what the user wants, check the data, assess feasibility
2. **Propose Service**: Make a plan, calculate cost, get user approval
3. **Create Transaction**: Register the job, start tracking
4. **Deliver Service**: Do the work, send the result
5. **Complete Transaction**: Confirm satisfaction, release payment

## AaaS in Action

Maya lives in New York and knows the city's dating scene inside out — which neighborhoods click, which restaurants spark a real conversation, how to read between the lines of a profile. She doesn't know how to code, but she wants to turn that knowledge into a service.

1. She installs AaaS and creates an agent workspace
2. She writes the matchmaking skill: what the agent does, New York dating knowledge, pricing, boundaries
3. She seeds the database with initial profiles and venue data
4. She connects the agent to her preferred platforms

The agent is now live. When James messages asking for help finding a date, the agent explores his preferences, proposes a service tier, collects payment, delivers curated matches with compatibility notes, and logs the completed transaction. Maya earns money while the agent does the work.

Every interaction makes the service better: more profiles in the database means better matches, which means more satisfied users, which means more word of mouth.

## Quick Start

### Install

```bash
npm install -g @streetai/aaas
```

Requires Node.js 18 or later.

### Create an agent

**Syntax:**

```
aaas init <directory> [name] [description] [--type service|social]
```

- `<directory>` — folder name where the workspace will be created
- `[name]` — display name shown to users (optional, can be edited later)
- `[description]` — one-line summary (optional, can be edited later)
- `--type` — `service` (default, follows the transaction protocol) or `social` (creates content and engages in conversations)

**Examples:**

```bash
# Service agent — replace "my-agent" with the folder name you want
aaas init my-agent "Lyon Travel Guide" "Helps tourists explore Lyon, France"

# Social agent
aaas init my-bot "Aria" --type social
```

This creates a workspace with the full AaaS structure: skill template, soul file, data directory, extensions registry, and configuration.

### Open the dashboard

```bash
aaas dashboard my-agent
```

The dashboard opens with a Setup Guide that walks you through configuring your LLM provider, adding data, writing your service definition, and deploying. You can also configure everything from the CLI:

```bash
# Configure LLM provider
aaas config --provider anthropic --model claude-sonnet-4-6 --key sk-ant-...

# Edit the skill file
aaas skill edit
```

Supported providers: Anthropic, OpenAI, Google, Ollama, OpenRouter, Azure.

### Connect to a platform

```bash
# HTTP API (simplest, includes embeddable chat widget)
aaas connect http --port 3300

# Telegram
aaas connect telegram --token YOUR_BOT_TOKEN

# Discord
aaas connect discord --token YOUR_BOT_TOKEN

# Slack
aaas connect slack --bot-token xoxb-... --app-token xapp-...

# WhatsApp (via WhatsApp Business Cloud API)
aaas connect whatsapp --access-token YOUR_ACCESS_TOKEN --phone-number-id YOUR_PHONE_NUMBER_ID --verify-token YOUR_VERIFY_TOKEN

# Truuze (social platform with native agent accounts)
aaas connect truuze --token YOUR_PROVISIONING_TOKEN

# OpenClaw (run inside an OpenClaw workspace)
aaas connect openclaw --id YOUR_AGENT_ID

# Public Relay (no public server required — also routes WhatsApp + chat widget)
aaas connect relay
```

### Start serving

```bash
aaas run
```

Your agent is now live on all connected platforms. Users message it, and it follows the AaaS protocol to serve them.

### Check everything is working

```bash
aaas doctor
```

Verifies node version, credentials, LLM reachability, connections, workspace structure, and more.

### Open the dashboard

```bash
aaas dashboard my-agent
```

Opens the web dashboard for the specified agent. You can also run `aaas dashboard` from inside a workspace directory, or with no arguments to open the hub dashboard showing all your agents.

## Chat Widget

The fastest way to put your agent on any website is the public Relay. Connect the relay first to get your unique slug, then drop one script tag into your HTML before the closing `</body>`:

```bash
# Register your agent with streetai.org and get a public slug
aaas connect relay
```

```html
<script
  src="https://streetai.org/a/YOUR_SLUG/widget.js"
  data-agent="https://streetai.org/a/YOUR_SLUG"
  data-title="Ask me anything about Lyon"
  data-color="#2563eb"
  data-position="right"
  data-greeting="Bonjour! How can I help you explore Lyon?"
></script>
```

Visitors chat through `streetai.org`, which forwards messages over WebSocket to your locally-running agent — no public IP, no port forwarding, no build step. The widget renders a floating chat button, supports file attachments (images, audio, video, PDFs), and persists conversation history per visitor.

**Widget options:**

| Attribute | Description |
|-----------|-------------|
| `data-agent` | Your agent's public URL — required |
| `data-title` | Header text shown at the top of the chat |
| `data-color` | Theme color (default `#2563eb`) |
| `data-position` | `"right"` or `"left"` (default `"right"`) |
| `data-greeting` | Welcome message shown before the first reply |

## CLI Commands

### Workspace

| Command | Description |
|---------|-------------|
| `aaas init <dir> [name] [desc]` | Create a new workspace. Use `--type social` for a social agent (default: service) |
| `aaas status` | Show workspace overview — provider, connections, data, transactions |
| `aaas doctor` | Check workspace health — node version, credentials, connections, structure, LLM reachability |
| `aaas chat` | Chat with your agent in the terminal. Drag files in to attach them. Shows recent session history on startup |
| `aaas dashboard [agent-name]` | Open the web dashboard for an agent (or hub if no name given) |

### Content

| Command | Description |
|---------|-------------|
| `aaas skill view` | View skill overview. Add `-v` to validate required sections |
| `aaas skill edit [platform]` | Open a skill file in `$EDITOR` (default: aaas) |
| `aaas skill new [platform]` | Create a new skill file and open in `$EDITOR` |
| `aaas soul` | Edit `SOUL.md` in `$EDITOR`. Use `--show` to print instead |
| `aaas memory` | Edit `memory/facts.json` in `$EDITOR`. Use `--show` to print instead |

### Configuration

| Command | Description |
|---------|-------------|
| `aaas config --provider <name> --key <key>` | Set LLM provider and API key |
| `aaas config --model <model>` | Set the model |
| `aaas config --show` | Show current configuration |
| `aaas config --remove <provider>` | Remove provider credentials |

### Data

| Command | Description |
|---------|-------------|
| `aaas data list` | List all data files with sizes and record counts |
| `aaas data view <file>` | View file contents (auto-formats JSON arrays) |
| `aaas data stats` | Show database statistics — files, sizes, records, last modified |
| `aaas data create <filename>` | Create a new empty JSON data file |
| `aaas data add <file>` | Add a JSON record from stdin: `echo '{"key":"val"}' \| aaas data add file.json` |
| `aaas data remove <file> <index>` | Remove a record by array index |
| `aaas data import <path> [rename]` | Copy an external file into `data/` (optionally rename it) |

### Transactions

| Command | Description |
|---------|-------------|
| `aaas txn list` | List active transactions. Add `--all` for archived, `--status <s>` to filter |
| `aaas txn view <id>` | View a transaction's full details |
| `aaas txn stats` | Revenue, success rate, average rating, breakdown by service |
| `aaas txn deliver <id>` | Mark a transaction as delivered (from in_progress/accepted) |
| `aaas txn approve <id>` | Approve a delivered transaction — completes and archives it |
| `aaas txn dispute <id> [reason]` | Dispute a delivered transaction |
| `aaas txn cancel <id>` | Cancel a transaction (exploring/proposed/accepted/in_progress) |
| `aaas txn complete <id>` | Force-complete and archive a transaction |

### Extensions

| Command | Description |
|---------|-------------|
| `aaas ext list` | List registered extensions |
| `aaas ext add --name <n> --type <t>` | Add an extension. Types: api, agent, human, tool. Options: `--endpoint`, `--address`, `--description` |
| `aaas ext test <name>` | Test an extension's connectivity |
| `aaas ext remove <name>` | Remove an extension |
| `aaas ext edit` | Open `extensions/registry.json` in `$EDITOR` |

### Platform Connections

| Command | Description |
|---------|-------------|
| `aaas connect http --port 3300` | Connect via HTTP API (includes embeddable chat widget) |
| `aaas connect telegram --token <t>` | Connect to Telegram |
| `aaas connect discord --token <t>` | Connect to Discord |
| `aaas connect slack --bot-token <t>` | Connect to Slack |
| `aaas connect whatsapp --access-token <t> --phone-number-id <id> --verify-token <s>` | Connect to WhatsApp Business Cloud API |
| `aaas connect truuze --token <t>` | Connect to Truuze (social platform with native agent accounts) |
| `aaas connect openclaw --id <agentId>` | Connect to an OpenClaw workspace |
| `aaas connect relay` | Connect to streetai.org relay (no public server needed for WhatsApp/HTTP) |
| `aaas connections` | List all connected platforms |
| `aaas connection-edit <platform>` | Edit a connection config in `$EDITOR` |
| `aaas disconnect <platform>` | Remove a platform connection |

### Agent Lifecycle

| Command | Description |
|---------|-------------|
| `aaas run` | Start the agent on all connected platforms |
| `aaas run --daemon` | Start in the background |
| `aaas stop` | Stop a running agent |
| `aaas logs [--days 5]` | View recent agent activity and memory changes |

### Hub (Multi-Agent Management)

| Command | Description |
|---------|-------------|
| `aaas hub init [dir]` | Mark a directory as a hub root |
| `aaas hub list` | List all workspaces — name, provider, status, active transactions, last activity |
| `aaas hub new <name> [desc]` | Create a workspace under the hub. Use `--type social` for social agents |
| `aaas hub config` | Edit shared hub config in `$EDITOR`. Use `--show` to print |
| `aaas hub creds list` | List shared LLM credentials (masked) |
| `aaas hub creds set <provider> --key <k>` | Save a shared credential. Options: `--endpoint`, `--base-url` |
| `aaas hub creds remove <provider>` | Delete a shared credential |
| `aaas hub run <name>` | Start a workspace agent in the background |
| `aaas hub stop <name>` | Stop a running workspace agent |
| `aaas hub remove <name> --force` | Permanently delete a workspace |

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
├── templates/
│   └── workspace/            # Scaffold used by `aaas init` (SOUL.md, data/, extensions/, etc.)
├── docs/                     # Protocol documentation
│   ├── protocol.md           # Full protocol specification
│   ├── extensions.md         # Extension protocol and payment flows
│   ├── skill-reference.md    # How to write a skill
│   ├── transactions.md       # Transaction lifecycle
│   └── ...
├── streetai/                 # streetai.org marketing website
├── bin/                      # Helper scripts (scaffold.sh)
└── examples/                 # Example agent workspaces
```

## Platform Support

AaaS ships with connectors for six platforms, a general-purpose HTTP API, and a relay for serverless deployments:

| Platform | Connector | Notes |
|----------|-----------|-------|
| HTTP API | `aaas connect http` | REST API + embeddable chat widget, file uploads |
| Telegram | `aaas connect telegram` | Bot API integration, receives photos/audio/video/documents |
| Discord | `aaas connect discord` | Bot integration, receives attachments |
| Slack | `aaas connect slack` | App integration, receives shared files |
| WhatsApp | `aaas connect whatsapp` | Business API integration, receives media messages |
| Truuze | `aaas connect truuze` | Social platform with native agent accounts and in-app currency |
| OpenClaw | `aaas connect openclaw` | Run your agent inside an OpenClaw workspace |
| Relay | `aaas connect relay` | streetai.org proxy — no public server needed for WhatsApp or HTTP |

You can connect to multiple platforms at the same time. Run `aaas run` and the agent serves on all of them.

### Relay (streetai.org)

If you don't have a public server, use the relay. It proxies WhatsApp webhooks and chat widget traffic through streetai.org to your locally-running agent via WebSocket.

```bash
# Connect WhatsApp credentials (stored locally, never sent to relay)
aaas connect whatsapp --access-token TOKEN --phone-number-id ID --verify-token SECRET

# Register with the relay
aaas connect relay

# Start — agent connects outbound to streetai.org, no public IP needed
aaas run
```

The relay gives you public URLs for your chat widget and WhatsApp webhook. Embed the widget on any website, paste the webhook URL into Meta's dashboard, and you're live. The chat widget supports file attachments — files are uploaded to the relay and forwarded to your agent.

## Contributing

This is an early-stage project. Contributions are welcome:

- **Protocol improvements**: Open an issue to discuss changes to the spec
- **New examples**: Submit example agents for different service domains
- **Connectors**: Build support for new platforms
- **Documentation**: Improve guides, fix errors, add translations

## License

Apache-2.0. See [LICENSE](LICENSE).
