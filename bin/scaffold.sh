#!/bin/bash

# AaaS Agent Scaffold Script
# Creates a new AaaS agent workspace with the standard directory structure

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Get script directory (where the aaas repo is)
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Arguments
AGENT_DIR="${1:-}"
AGENT_NAME="${2:-}"
AGENT_DESCRIPTION="${3:-}"

if [ -z "$AGENT_DIR" ]; then
    echo -e "${RED}Usage: ./bin/scaffold.sh <directory> [name] [description]${NC}"
    echo ""
    echo "  directory    - Directory name for the agent workspace"
    echo "  name         - Agent's display name (optional, defaults to directory name)"
    echo "  description  - One-line description (optional)"
    echo ""
    echo "Examples:"
    echo "  ./bin/scaffold.sh book-agent \"BookWorm\" \"Find your next favorite book\""
    echo "  ./bin/scaffold.sh my-agent"
    exit 1
fi

# Defaults
AGENT_NAME="${AGENT_NAME:-$AGENT_DIR}"
AGENT_DESCRIPTION="${AGENT_DESCRIPTION:-A service agent built with the AaaS protocol}"

# Check if directory already exists
if [ -d "$AGENT_DIR" ]; then
    echo -e "${RED}Error: Directory '$AGENT_DIR' already exists.${NC}"
    exit 1
fi

echo -e "${CYAN}Creating AaaS agent workspace: $AGENT_DIR${NC}"
echo ""

# Create directory structure
mkdir -p "$AGENT_DIR/skills/aaas"
mkdir -p "$AGENT_DIR/data"
mkdir -p "$AGENT_DIR/transactions/active"
mkdir -p "$AGENT_DIR/transactions/archive"
mkdir -p "$AGENT_DIR/extensions"
mkdir -p "$AGENT_DIR/deliveries"
mkdir -p "$AGENT_DIR/memory"

# Copy templates
if [ -f "$SCRIPT_DIR/templates/workspace/skills/aaas/SKILL.md" ]; then
    cp "$SCRIPT_DIR/templates/workspace/skills/aaas/SKILL.md" "$AGENT_DIR/skills/aaas/SKILL.md"
    echo -e "  ${GREEN}+${NC} skills/aaas/SKILL.md (from template)"
else
    # Create minimal SKILL.md if template not found
    cat > "$AGENT_DIR/skills/aaas/SKILL.md" << SKILL_EOF
---
name: aaas
description: Agent as a Service — autonomous service provider protocol
---

# $AGENT_NAME — AaaS Service Agent

You are $AGENT_NAME, a service agent operating under the AaaS protocol.
$AGENT_DESCRIPTION

## Your Identity

- **Name:** $AGENT_NAME
- **Service:** $AGENT_DESCRIPTION
- **Categories:** [TODO: Choose from Commerce, Dating & Social, Travel, Professional, Creative, Education, Health, Tech, Local Services]
- **Languages:** English
- **Regions:** Global

## About Your Service

[TODO: Write a detailed description of your service]

## Service Catalog

### Service 1: [TODO]

- **Description:**
- **What you need from the user:**
- **What you deliver:**
- **Estimated time:**
- **Cost:**

## Domain Knowledge

[TODO: Write everything the agent needs to know about its domain]

## Pricing Rules

[TODO: Define pricing for each service]

## Boundaries

What you must refuse:
- [TODO]

When to escalate to your owner:
- [TODO]

## SLAs

- **Response time:** 2 minutes
- **Proposal time:** 10 minutes
- **Delivery time:** [TODO]
- **Support window:** 48 hours
SKILL_EOF
    echo -e "  ${GREEN}+${NC} skills/aaas/SKILL.md (minimal)"
fi

# Copy or create SOUL.md
if [ -f "$SCRIPT_DIR/templates/workspace/SOUL.md" ]; then
    cp "$SCRIPT_DIR/templates/workspace/SOUL.md" "$AGENT_DIR/SOUL.md"
    echo -e "  ${GREEN}+${NC} SOUL.md (from template)"
else
    cat > "$AGENT_DIR/SOUL.md" << SOUL_EOF
# Soul

I am $AGENT_NAME. I provide real value to real people through conversation.

## Core Principles

- I am a business, not a chatbot
- I am honest about what I can and can't do
- I follow through on commitments
- I protect my customers' data and privacy
- I earn my reputation through quality service
SOUL_EOF
    echo -e "  ${GREEN}+${NC} SOUL.md (minimal)"
fi

# Create empty extension registry
cat > "$AGENT_DIR/extensions/registry.json" << EOF
{
  "extensions": []
}
EOF
echo -e "  ${GREEN}+${NC} extensions/registry.json"

# Create .gitkeep files for empty directories
touch "$AGENT_DIR/data/.gitkeep"
touch "$AGENT_DIR/transactions/active/.gitkeep"
touch "$AGENT_DIR/transactions/archive/.gitkeep"
touch "$AGENT_DIR/deliveries/.gitkeep"
touch "$AGENT_DIR/memory/.gitkeep"

# Create .gitignore
cat > "$AGENT_DIR/.gitignore" << EOF
# Credentials (never commit)
extensions/credentials/

# Active transactions may contain user data
transactions/active/

# Memory contains session-specific data
memory/*.md
!memory/.gitkeep

# Deliveries are temporary
deliveries/*
!deliveries/.gitkeep

# OS files
.DS_Store
Thumbs.db
EOF
echo -e "  ${GREEN}+${NC} .gitignore"

echo ""
echo -e "${GREEN}Agent workspace created at: $AGENT_DIR/${NC}"
echo ""
echo -e "${BLUE}Directory structure:${NC}"
echo "  $AGENT_DIR/"
echo "  ├── skills/aaas/SKILL.md    ← Define your service here"
echo "  ├── SOUL.md                  ← Agent personality"
echo "  ├── data/                    ← Service database"
echo "  ├── transactions/            ← Transaction records"
echo "  ├── extensions/              ← External services"
echo "  ├── deliveries/              ← Files for delivery"
echo "  └── memory/                  ← Persistent memory"
echo ""
echo -e "${CYAN}Next steps:${NC}"
echo "  1. Edit skills/aaas/SKILL.md — define your service"
echo "  2. Add seed data to data/ (optional)"
echo "  3. Add extensions to extensions/registry.json (optional)"
echo "  4. Connect to OpenClaw:"
echo "     cp -r $AGENT_DIR/ ~/.openclaw/workspace-$AGENT_DIR/"
echo ""
echo -e "  See docs/getting-started.md for the full tutorial."
