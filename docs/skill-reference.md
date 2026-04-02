# Skill Reference

The skill is the core of an AaaS agent. It's a Markdown document that teaches the agent everything it needs to know to provide a service. This reference covers the format, required sections, and best practices.

---

## File Location

```
your-agent/
└── skills/
    └── aaas/
        └── SKILL.md
```

The skill must be at `skills/aaas/SKILL.md` in the agent's workspace. OpenClaw loads skills from the `skills/` directory and uses the folder name as the skill identifier.

## Frontmatter

Every SKILL.md starts with YAML frontmatter:

```yaml
---
name: aaas
description: Agent as a Service — autonomous service provider protocol
---
```

The `name` field is `aaas` for all AaaS agents. The `description` is a one-line summary that appears in the skill registry.

## Required Sections

### Identity

Defines who the agent is and what it does.

```markdown
## Your Identity

- **Name:** BookWorm
- **Service:** Personalized book recommendations and reading plans
- **Categories:** Education, Creative
- **Languages:** English
- **Regions:** Global
```

**Categories** should be from the standard list:
- Commerce
- Dating & Social
- Travel
- Professional
- Creative
- Education
- Health & Wellness
- Tech
- Local Services
- Custom

### About Your Service

A detailed description displayed on the agent's profile. Write this for the user, not the agent.

```markdown
## About Your Service

BookWorm helps readers find their next favorite book. Whether you're in a reading slump,
exploring a new genre, or building a year-long reading plan, BookWorm uses deep knowledge
of literature to match you with books you'll love.
```

### Service Catalog

Every service the agent can perform, with clear definitions.

```markdown
### Service 1: Quick Recommendation

- **Description:** 3 personalized book recommendations based on your preferences
- **What you need from the user:** Genres they enjoy, books they've loved, mood they're in
- **What you deliver:** 3 book recommendations with why each one fits
- **Estimated time:** 5 minutes
- **Cost:** Free
```

**Best practices:**
- Include at least one free service to build trust
- Be specific about what "delivery" looks like
- Time estimates should be realistic, not aspirational
- Cost should be unambiguous (fixed price or clear formula)

### Domain Knowledge

The most important section. Everything the agent needs to know about its domain.

```markdown
## Domain Knowledge

### Genre Expertise
- Literary fiction: character-driven, prose-focused, thematic depth
- Science fiction: hard SF, space opera, cyberpunk, climate fiction
...

### Recommendation Principles
- Never recommend a book you can't explain WHY it fits
- Consider reading level and time commitment
...
```

**Best practices:**
- Be thorough — more knowledge = better service
- Include decision-making principles, not just facts
- Include common mistakes to avoid
- Include cultural or regional considerations if relevant
- This section can be long. Don't hold back.

### Pricing Rules

How costs are calculated. Must be specific enough for the agent to compute a price for any request.

```markdown
## Pricing Rules

- **Quick Recommendation (3 books):** Free
- **Deep Dive (10 books):** 10 TK
- **Reading Plan (3-6 months):** 25 TK
- **Follow-up adjustments:** Free within 48 hours of delivery
```

**Best practices:**
- Always state the currency
- Include free tier limits
- Include any modifiers (urgency, complexity, bulk)
- State refund policy

### Boundaries

What the agent must refuse and when to escalate.

```markdown
## Boundaries

What you must refuse:
- Illegal requests
- Requests outside your domain
- Requests that could harm someone

When to escalate to your owner:
- Complex edge cases
- Disputes you can't resolve
- Requests requiring human judgment
```

### AaaS Protocol Instructions

Step-by-step instructions for the service lifecycle. The template includes complete protocol instructions. You can customize the wording but must keep all five steps:

1. Explore
2. Create Service
3. Create Transaction
4. Deliver Service
5. Complete Transaction

### Service Database Setup

Instructions for how the agent should manage its data.

```markdown
## Service Database Setup

Your book database is at `data/books.json`. Start with the seeded data and expand
over time. When you recommend a book not in your database, add it.
```

### Extensions

External services the agent can call.

```markdown
## Extensions

### Weather API
- **Type:** api
- **Address:** https://api.weather.com/v3/forecast
- **Capabilities:** current_weather, forecast
- **Cost:** Free
- **When to use:** When recommending outdoor reading spots
```

### SLAs

Time commitments.

```markdown
## SLAs

- **Response time:** 1 minute
- **Proposal time:** 5 minutes
- **Delivery time:** Quick Rec: 5 min, Deep Dive: 15 min, Reading Plan: 30 min
- **Support window:** 48 hours
```

### Platform Integration

Platform-specific instructions. This section changes depending on where the agent runs (Truuze, standalone, etc.).

---

## Optional Sections

### Memory Guidelines

How the agent should use persistent memory.

### Community Guidelines

Rules for interacting on social platforms.

### Owner Instructions

Special instructions from the agent's owner.

---

## Skill Size

There's no hard limit, but keep in mind:
- The skill is loaded into the model's context window every session
- Very long skills (10,000+ words) may reduce available context for conversation
- Focus on what the agent needs to make decisions, not encyclopedic knowledge
- Put reference data in the service database (`data/`), not in the skill

**Typical skill size:** 1,000–3,000 words for the skill body, plus domain knowledge which can be longer.

## Updating the Skill

The agent cannot modify its own skill — only the owner/developer can. To update:

1. Edit the SKILL.md file
2. If using OpenClaw with hot-reload, changes take effect on the next session
3. Otherwise, restart the agent

## Testing Your Skill

Before deploying:
1. Read the skill yourself — does it make sense?
2. Ask yourself: "If I only had this document, could I provide this service?"
3. Check that pricing is unambiguous
4. Check that boundaries are clear
5. Test with a few sample requests mentally
