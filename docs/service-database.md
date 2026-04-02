# Service Database

The service database is where your agent stores the data it needs to provide its service. Unlike traditional software where a developer designs the schema, in AaaS the agent creates and manages its own data structure based on the skill.

---

## How It Works

The service database lives in the `data/` directory of the agent's workspace:

```
your-agent/
└── data/
    ├── books.json          # Example: book catalog
    ├── customers.json      # Example: customer preferences
    └── cache/              # Example: temporary data
```

The agent reads and writes to these files using its workspace tools. There is no external database server — everything is files.

## Format

The agent chooses its own format based on what fits the service:

| Format | Good for | Example |
|--------|----------|---------|
| **JSON** | Structured records, catalogs, registries | Product listings, user profiles, venue data |
| **SQLite** | Large datasets, complex queries, relational data | Transaction history, search indexes |
| **CSV** | Tabular data, imports/exports | Price lists, spreadsheets |
| **Markdown** | Documentation, knowledge bases, notes | Research notes, guides, templates |
| **Plain text** | Logs, simple lists | Activity logs, quick notes |

**Recommendation:** Start with JSON for most use cases. It's readable, easy to modify, and the agent handles it naturally. Move to SQLite if the dataset grows beyond a few hundred records or needs complex queries.

## Seeding Data

You can seed the database with initial data before the agent starts serving:

```bash
# Create initial data
echo '[
  {"id": 1, "title": "Product A", "price": 100},
  {"id": 2, "title": "Product B", "price": 200}
]' > your-agent/data/products.json
```

Or you can leave `data/` empty and instruct the agent (in the skill) to build its database from scratch through conversations and research.

## Agent-Managed Growth

Over time, the agent expands its database:

- **Learning from interactions** — When a customer mentions a product the agent doesn't know about, it adds it
- **Market updates** — The agent can call API extensions to refresh pricing data
- **Customer data** — Preferences and history from returning customers (with consent)

Include instructions in your skill for how the agent should maintain its data:

```markdown
## Service Database Setup

Your product database is at `data/products.json`. When you encounter a product
not in your database during a conversation, add it with at least: title, category,
typical_price_range, and condition_notes.

Run a price refresh weekly by calling the PriceCheck extension for each product.

Remove products that haven't been referenced in 90 days to keep the database lean.
```

## Data Patterns by Service Type

### Marketplace / Commerce Agent

```
data/
├── listings.json       # Active listings (items for sale)
├── market_prices.json  # Reference pricing by category
├── buyers.json         # Known buyer profiles and preferences
└── sold.json           # Completed sales (reference)
```

### Matchmaking / Social Agent

```
data/
├── profiles.json       # User profiles and preferences
├── venues.json         # Locations for meetings
├── match_history.json  # Past matches and outcomes
└── blocklist.json      # Users who shouldn't be matched
```

### Knowledge / Education Agent

```
data/
├── catalog.json        # Content catalog (books, courses, etc.)
├── curriculum/         # Structured learning paths
├── student_notes.json  # Per-student progress and preferences
└── resources.json      # External links and references
```

### Professional Services Agent

```
data/
├── templates/          # Document templates
├── regulations.json    # Rules, laws, guidelines
├── client_cases.json   # Past case references (anonymized)
└── pricing_tiers.json  # Service pricing matrix
```

## Privacy and Retention

**Important rules for user data in the service database:**

1. **Disclose first** — Before storing any user-specific data, the agent must tell the user what it's storing and why
2. **Minimize** — Store only what's needed for the service
3. **Clean up** — Delete user-specific data after the transaction lifecycle ends (transaction + support window)
4. **Honor deletion requests** — If a user asks to be removed, delete their data and confirm
5. **Separate concerns** — Keep user data separate from service data (e.g., `profiles.json` vs `venues.json`)

## Size Considerations

- **Small (< 1MB):** JSON files work perfectly. Most agents start here.
- **Medium (1-50MB):** JSON still works but consider SQLite for query performance.
- **Large (50MB+):** Use SQLite or consider whether the agent needs all this data locally. API extensions may be better for large datasets.

The agent's workspace is persistent storage, but it's not a data warehouse. Keep the working dataset focused on what the agent needs for active service delivery.
