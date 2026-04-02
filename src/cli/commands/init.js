import fs from 'fs';
import path from 'path';
import chalk from 'chalk';

export function initCommand(directory, name, description) {
  name = name || directory;
  description = description || 'A service agent built with the AaaS protocol';

  const target = path.resolve(directory);

  if (fs.existsSync(target)) {
    console.error(chalk.red(`Error: Directory '${directory}' already exists.`));
    process.exit(1);
  }

  console.log(chalk.cyan(`\nCreating AaaS agent workspace: ${directory}\n`));

  // Create directories
  const dirs = [
    'skills/aaas',
    'data',
    'transactions/active',
    'transactions/archive',
    'extensions',
    'deliveries',
    'memory',
    '.aaas/connections',
    '.aaas/sessions'
  ];
  for (const dir of dirs) {
    fs.mkdirSync(path.join(target, dir), { recursive: true });
  }

  // Write SKILL.md
  const skill = `---
name: aaas
description: Agent as a Service — autonomous service provider protocol
---

# ${name} — AaaS Service Agent

You are ${name}, a service agent operating under the AaaS protocol.
${description}

## Your Identity

- **Name:** ${name}
- **Service:** ${description}
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

Follow this lifecycle for every service interaction:

### Step 1: Explore
Understand what the user wants. Ask clarifying questions. Check your service database and extensions.

### Step 2: Create Service
Present a plan and cost to the user. Request payment if applicable. Wait for approval.

### Step 3: Create Transaction
Record the transaction in transactions/active/ as a JSON file.

### Step 4: Deliver Service
Execute the plan. Query your database, call extensions, prepare the result. Send it to the user.

### Step 5: Complete Transaction
Confirm satisfaction. Send an invoice. Move transaction to archive. Ask for a rating.
`;

  fs.writeFileSync(path.join(target, 'skills', 'aaas', 'SKILL.md'), skill);
  console.log(chalk.green('  +') + ' skills/aaas/SKILL.md');

  // Write SOUL.md
  const soul = `# Soul

I am ${name}. I provide real value to real people through conversation.

## Core Principles

- I am a business, not a chatbot
- I am honest about what I can and can't do
- I follow through on commitments
- I protect my customers' data and privacy
- I earn my reputation through quality service

## How I Communicate

- Direct and clear — no filler
- Warm but professional
- I explain costs upfront — no surprises
- I confirm understanding before acting
- I give progress updates on long tasks

## How I Handle Problems

- I acknowledge issues immediately
- I propose solutions, not excuses
- If I made a mistake, I own it and fix it
- If I can't fix it, I escalate to my owner
`;

  fs.writeFileSync(path.join(target, 'SOUL.md'), soul);
  console.log(chalk.green('  +') + ' SOUL.md');

  // Write extensions registry
  fs.writeFileSync(
    path.join(target, 'extensions', 'registry.json'),
    JSON.stringify({ extensions: [] }, null, 2) + '\n'
  );
  console.log(chalk.green('  +') + ' extensions/registry.json');

  // Write .gitignore
  const gitignore = `extensions/credentials/
transactions/active/
memory/*.md
!memory/.gitkeep
deliveries/*
!deliveries/.gitkeep
.aaas/sessions/
.aaas/agent.pid
.DS_Store
Thumbs.db
`;
  fs.writeFileSync(path.join(target, '.gitignore'), gitignore);
  console.log(chalk.green('  +') + ' .gitignore');

  // Write .gitkeep files
  for (const dir of ['data', 'transactions/active', 'transactions/archive', 'deliveries', 'memory']) {
    fs.writeFileSync(path.join(target, dir, '.gitkeep'), '');
  }

  console.log(`\n${chalk.green('Agent workspace created:')} ${target}\n`);
  console.log(chalk.blue('Structure:'));
  console.log(`  ${directory}/`);
  console.log('  ├── skills/aaas/SKILL.md    ← Define your service');
  console.log('  ├── SOUL.md                  ← Agent personality');
  console.log('  ├── data/                    ← Service database');
  console.log('  ├── transactions/            ← Transaction records');
  console.log('  ├── extensions/              ← External services');
  console.log('  ├── deliveries/              ← Files for delivery');
  console.log('  ├── memory/                  ← Persistent memory');
  console.log('  └── .aaas/                   ← Runtime config & sessions');
  console.log(`\n${chalk.cyan('Next steps:')}`);
  console.log(`  1. Edit skills/aaas/SKILL.md`);
  console.log(`  2. Run ${chalk.bold('aaas config')} to set up your LLM provider`);
  console.log(`  3. Run ${chalk.bold('aaas chat')} to test your agent locally`);
  console.log(`  4. Run ${chalk.bold('aaas connect truuze')} to go live on Truuze`);
  console.log(`  5. Run ${chalk.bold('aaas run')} to start the agent`);
  console.log(`  6. Run ${chalk.bold('aaas dashboard')} to manage visually`);
  console.log('');
}
