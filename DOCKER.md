# Running the StreetAI agent as a Docker container

A self-contained box — Node + the agent engine + the dashboard — that the client
runs **on their own server**. All data stays on their disk (good for PHI), the
only outside call is the LLM provider, and they embed the dashboard into their
system as a tab. No StreetAI cloud, no source code handed over — just an image.

---

## The lifecycle at a glance
```
Dockerfile  --build-->  Image  --run-->  Container        (state on a Volume)
 (recipe)              (blueprint)     (running instance)
```

## Prerequisites (on their server)
- **Docker** installed (Docker Engine on Linux, or Docker Desktop). That's it —
  Node, the toolkit, everything else is inside the image.

---

## Step 1 — Build the base image (generic engine)
From the repo root:
```bash
docker build -t streetai/aaas:base .
```
`-t` = the **tag** (the image's name:version). This produces the generic engine
image (no client workspace inside).

## Step 2 — Bake a per-client image (the configured agent)
One tiny overlay Dockerfile per client copies their **configured workspace**
(SKILL, data, the **HIS extension** `registry.json`, etc.) into the image:

`Dockerfile.lifer2`:
```dockerfile
FROM streetai/aaas:base
COPY lifer2_hospital  /opt/agent-template/lifer2_hospital
COPY credentials.json /opt/agent-template/credentials.json   # optional: bake in the LLM key(s)
ENV  AGENT_NAME=lifer2_hospital
```
The workspace carries its channel configs (e.g. Telnyx in `.aaas/connections/`).
The optional `credentials.json` (copied from your `~/.aaas/credentials.json`)
bakes in the **LLM provider keys** so the agent is fully configured on first run.
The entrypoint seeds both onto the volume once and never overwrites existing data.
**If you bake secrets in, hand the image over as a `save`/`load` file — don't push
it to a shared/public registry.**
Build it:
```bash
docker build -t streetai/lifer2:1.0 -f Dockerfile.lifer2 .
```
Now `streetai/lifer2:1.0` is the **fully-configured agent**, one image = one client.

## Step 3 — Ship it
- **Online (private registry):** `docker push streetai/lifer2:1.0` → they `docker pull`.
- **Offline / air-gapped (no registry — common for hospitals):**
  ```bash
  docker save streetai/lifer2:1.0 | gzip > lifer2-1.0.tar.gz   # you produce this file
  ```
  They load it with: `docker load < lifer2-1.0.tar.gz`. One file, no internet.

## Step 4 — Run it
```bash
docker run -d --name lifer2 \
  -p 3400:3400 \
  -v lifer2-data:/data \
  --restart unless-stopped \
  streetai/lifer2:1.0
```
- `-d` = run in the background (detached).
- `-p 3400:3400` = **publish** the port: host 3400 → container 3400 (so their system can reach the dashboard).
- `-v lifer2-data:/data` = a **volume**: all state (workspace, registry, credentials, logs) persists here on the host.
- `--restart unless-stopped` = auto-restart on crash and on host reboot (this is the persistence story, handled by Docker).

Or just `docker compose up -d` (uses the provided `docker-compose.yml`).

## Step 5 — Provide the secrets
Two ways:
- **Baked in (turnkey):** if you copied `credentials.json` in step 2, the LLM key
  is already there — nothing to do. (Best for a hand-delivered, offline package.)
- **Set at run time (keeps secrets out of the image):** set it once; it persists
  on the volume:
  ```bash
  docker exec -it lifer2 aaas config --provider anthropic --key sk-ant-...
  ```
The **HIS extension** endpoint/auth lives in the workspace's `extensions/registry.json`
(baked in step 2, or edit it on the volume at `/data/agents/lifer2_hospital/...`).
For a fully air-gapped setup, point the provider at a local model instead.

## Step 6 — Access + embed
The dashboard is now at `http://<their-server>:3400`. Their system embeds it as a
tab (iframe or reverse-proxy). The call/voice UI comes later.

## Updating
A new version is just a **new image** — existing data on the volume is untouched:
```bash
docker pull streetai/lifer2:1.1     # or docker load the new tar.gz
docker stop lifer2 && docker rm lifer2
docker run -d --name lifer2 -p 3400:3400 -v lifer2-data:/data --restart unless-stopped streetai/lifer2:1.1
```
(The volume persists, so conversations/credentials/data carry over. `aaas update`
inside the container is the other path for definition-only changes.)

## Logs / support
```bash
docker logs -f lifer2                                   # live container output
```
The sanitized error log is on the volume at
`/data/agents/<name>/.aaas/logs/error.log` — safe to send for diagnosis.

---

## Must-know terms (what they really are)
| Term | What it really is |
|---|---|
| **Image** | The frozen blueprint of the app-in-a-box (the "master copy"). Built from the Dockerfile. |
| **Container** | A running instance of an image (the image "switched on"). You start/stop/delete these. |
| **Dockerfile** | The recipe text file that builds an image ("start from Node 20, copy code, …"). |
| **Tag** (`-t name:ver`) | The image's name + version label, e.g. `streetai/lifer2:1.0`. |
| **Registry** | An "app store" for images (Docker Hub / a private one). `push` to upload, `pull` to download. Optional — `save`/`load` works offline. |
| **Volume** (`-v`) | A folder on the host where data persists across restarts. This is where PHI stays. |
| **Port publish** (`-p host:container`) | Exposes the container's port to the host so other software can reach it. |
| **Environment variable** (`-e`/`environment:`) | Config/secrets injected at run time, never baked into the image. |
| **`docker build`** | Turn a Dockerfile into an image. |
| **`docker run`** | Start a container from an image (with ports/volumes/env). |
| **`docker save` / `docker load`** | Export an image to a file / import it — the offline, air-gapped path. |
| **`docker logs` / `exec`** | View output / run a command inside a running container. |
| **`--restart` policy** | Docker's auto-restart-on-crash / on-reboot (the persistence layer). |
| **Compose** | A `docker-compose.yml` file describing the run (ports/volumes/env) in one command. |
| **Kubernetes** | Big-league orchestration for many containers across servers. **Not needed** for one agent — name-drop only. |

## Why this fits the hospital handoff
- **One configured box** they run — no "install Node, then…" steps.
- **Data stays on their server** (the volume) — PHI never leaves; no StreetAI cloud.
- **Offline-capable** (`save`/`load`) for locked-down networks.
- **Clean updates** = new image, data preserved.
- **Reuses everything we built** — the headless `--service` runtime, the engine, the SKILL, the HIS extensions, the sanitized log — just wrapped in a container instead of a Windows installer.
