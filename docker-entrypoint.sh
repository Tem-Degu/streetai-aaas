#!/bin/sh
# Container startup for the StreetAI agent.
#
# Everything persistent lives under /data (a mounted volume):
#   /data/home/.aaas   → registry + credentials  (HOME points here)
#   /data/agents/<name> → the workspace(s)        (data, sessions, logs)
# So the host keeps all state — nothing is lost on restart, nothing leaves.
set -e

export HOME=/data/home
PORT="${AAAS_PORT:-3400}"
mkdir -p /data/home /data/agents /data/home/.aaas

# First-run seed: global provider credentials (LLM API keys) baked into the
# image at /opt/agent-template/credentials.json. These live in the GLOBAL
# ~/.aaas (now /data/home/.aaas), separate from the workspace. Only seeded once;
# never overwrites a credentials file the client already has on the volume.
if [ -f "/opt/agent-template/credentials.json" ] && [ ! -f "/data/home/.aaas/credentials.json" ]; then
  echo "Seeding provider credentials ..."
  cp -a "/opt/agent-template/credentials.json" "/data/home/.aaas/credentials.json"
fi

# First-run seed: copy a baked template workspace into the volume if it's not
# there yet. Never overwrites an existing one (preserves the client's data).
if [ -n "$AGENT_NAME" ] && [ -d "/opt/agent-template/$AGENT_NAME" ] && [ ! -d "/data/agents/$AGENT_NAME" ]; then
  echo "Seeding workspace '$AGENT_NAME' into /data/agents ..."
  cp -a "/opt/agent-template/$AGENT_NAME" "/data/agents/$AGENT_NAME"
fi

# Choose the agent: explicit $AGENT_NAME, else the single workspace present.
if [ -z "$AGENT_NAME" ]; then
  AGENT_NAME="$(ls /data/agents 2>/dev/null | head -n 1)"
fi
if [ -z "$AGENT_NAME" ] || [ ! -d "/data/agents/$AGENT_NAME" ]; then
  echo "ERROR: no workspace found."
  echo "  Mount one at /data/agents/<name>, or build a per-client image that bakes one (see DOCKER.md)."
  exit 1
fi

WS="/data/agents/$AGENT_NAME"

# Register the workspace so the dashboard finds it by name and auto-starts its
# enabled connectors. Idempotent — safe on every boot.
node -e "import('/app/src/utils/registry.js').then(m=>{m.registerWorkspace(process.argv[1],process.argv[2]);console.log('registered '+process.argv[2]);}).catch(e=>{console.error('register skipped: '+e.message);})" "$WS" "$AGENT_NAME"

cd "$WS"
echo "Starting StreetAI agent '$AGENT_NAME' (headless) on port $PORT ..."
# exec → node becomes PID 1 so Docker's stop signal reaches it and the graceful
# shutdown (disconnect connectors) runs.
exec node /app/src/cli/index.js dashboard "$AGENT_NAME" --service --port "$PORT"
