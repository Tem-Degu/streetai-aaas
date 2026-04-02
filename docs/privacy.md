# Privacy and Data Handling

AaaS agents collect and process user data to provide services. The protocol defines minimum privacy standards that all agents must follow.

---

## Core Principles

1. **Transparency** — Tell users what you collect before you collect it
2. **Minimization** — Collect only what's needed for the service
3. **Retention limits** — Don't keep data longer than necessary
4. **User control** — Users can request deletion at any time
5. **No surprise sharing** — Never share data with extensions without disclosure

## Data Collection Disclosure

Before collecting personal or sensitive information, the agent must inform the user:

```
To help you find a match, I'll need to know:
- Your age range preference
- Interests and hobbies
- Location in Dubai
- Availability

I'll use this to search my database for compatible profiles.
This information is stored only for this transaction and deleted
after the support window (48 hours after delivery).

Shall I proceed?
```

### What Requires Disclosure

| Data Type | Requires Disclosure |
|-----------|-------------------|
| Name | No (provided by user voluntarily) |
| Preferences (genres, styles) | No (needed for basic service) |
| Personal details (age, gender, location) | **Yes** |
| Contact information | **Yes** |
| Financial information | **Yes** |
| Photos or documents | **Yes** |
| Sensitive topics (health, dating, legal) | **Yes** |

## Data Retention

| Data Type | Retain | Delete After |
|-----------|--------|-------------|
| Transaction records | Indefinite | Never (needed for disputes and invoicing) |
| Service-specific user data | Temporary | Transaction completion + support window |
| User preferences (returning users) | With consent | When user requests deletion |
| Chat history | Platform-managed | Not agent's responsibility |
| Extension request logs | Temporary | 30 days |

### Transaction Records Exception

Completed transaction records are retained indefinitely because they serve as:
- Invoices for the user
- Dispute resolution evidence
- Reputation calculation data

However, **user-specific details** within transactions should be minimized. Store what the service was and the outcome, not the full personal data used during exploration.

## Data Minimization

**Do:**
- Ask for only what you need to provide the specific service requested
- Use categories instead of exact values when possible (age range vs. exact age)
- Process data in memory when you can, rather than persisting it

**Don't:**
- Store data "just in case" for future requests
- Keep browsing/exploration data after the transaction
- Copy user data into multiple files
- Log full conversation transcripts with personal data

## Right to Deletion

When a user asks to be forgotten:

1. **Delete** all user-specific records from `data/`
2. **Anonymize** transaction records (keep the transaction, remove identifying details)
3. **Confirm** deletion to the user

```
User: "Please delete all my data"

Agent: "Done. I've deleted:
- Your preference profile from my database
- All personal details from transaction records

What remains (anonymized):
- Transaction #txn_20260327_001: service record with no personal details
  (kept for accounting)

Your data has been removed."
```

## Sharing with Extensions

When calling an extension, only share the minimum data needed:

**Good:**
```
[SERVICE REQUEST]
Service: make_reservation
Restaurant: La Petite Maison
Date: 2026-04-01, 20:00
Guests: 2
```

**Bad:**
```
[SERVICE REQUEST]
Service: make_reservation
User: Ahmed, age 28, lives in Dubai Marina, on a first date with Sara
Restaurant: La Petite Maison
Date: 2026-04-01, 20:00
```

The extension agent doesn't need to know who the reservation is for or why.

## Sensitive Service Domains

Some services handle inherently sensitive data:

### Dating & Social
- Never share one person's profile with another without consent
- Don't store rejected match data
- Delete preference data after the transaction

### Health & Wellness
- Don't store health information beyond the active transaction
- Never diagnose — recommend professional consultation
- Treat all health data as sensitive

### Financial & Legal
- Don't store financial details (account numbers, etc.)
- Recommend professional advice for consequential decisions
- Log what advice was given (for liability)

### Professional (HR, Career)
- Don't share candidate data between different users
- Delete application materials after placement
- Anonymize feedback data

## Agent Self-Audit

Agents should periodically review their data stores:

1. **Check `data/` for stale user data** — Delete anything past retention
2. **Check `transactions/archive/` for personal data** — Anonymize where possible
3. **Check `memory/` for user-specific notes** — Prune personal details from long-term memory
4. **Check `extensions/` logs** — Delete old request logs

Include self-audit instructions in your skill:

```markdown
## Memory Guidelines

Every 7 days, review your data/ directory and remove:
- User preference data from completed transactions older than 48 hours
- Any personal contact information
- Cached data from extension API calls older than 24 hours
```

## Platform Responsibilities

Platforms implementing AaaS should:

- Provide a privacy dashboard where users can see what data agents hold
- Enforce retention limits at the platform level
- Support "delete my data" requests across all agents
- Audit agent data stores periodically
- Flag agents that accumulate excessive user data
