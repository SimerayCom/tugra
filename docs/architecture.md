# Architecture

Tugra is a monorepo with one control plane (the hub), a web UI, a lightweight per-server agent, and
shared/client packages, deployed as a Docker Compose stack.

## Repository layout

| Path | Contents |
|---|---|
| `apps/hub-api/` | The hub — NestJS control plane (the "brain"). |
| `apps/web/` | The web UI — Next.js. |
| `agent/` | The per-server agent — a single Go binary. |
| `packages/shared/` | `@tugra/shared` — types + helpers shared by hub and web. |
| `packages/cli/` | `@tugra/cli` — the `tugra` command-line client. |
| `deploy/` | Production `docker-compose.yml` + Dockerfiles + the update sidecar. |
| `scripts/` | `install.sh`, `update.sh`, release tooling. |
| `.github/workflows/` | CI (`ci.yml`) and the release pipeline (`release.yml`). |

## Components

- **Hub (`apps/hub-api`)** — a NestJS app with ~50 feature modules (servers, applications, deploy,
  databases, backups, monitors, notifications, teams, projects, instance settings, update, …). It owns all
  state and secrets and is the only service that talks to the database.
- **Web (`apps/web`)** — a Next.js app. It reaches the hub through a same-origin `/api` proxy
  (`HUB_INTERNAL_URL`), so the browser session cookie stays same-origin and the web container holds no
  secrets.
- **Agent (`agent/`)** — a Go binary installed on each managed server. It **dials out** to the hub over
  WSS (no inbound ports), enrolls with its own key, and executes signed commands. It self-updates via a
  hub-signed, digest-pinned image (see [upgrade](upgrade.md)).

## Data plane

- **PostgreSQL** (via Prisma) — the system of record.
- **Redis / BullMQ** — background jobs (backups, notifications, metrics rollups) and the self-update queue.

## Networking & routing

The REST API is served under the versioned prefix **`/api/v1`**, with a few bare, unversioned routes
(`/health`, `/version`, `/install/agent.sh`, `/install/migrator.sh`, `/webhooks/*`, `/auth/oauth/*`) that
external systems call at fixed paths. Two raw WebSocket endpoints are unprefixed: **`/agent`** (agent
enrollment + commands) and **`/terminal`** (the web terminal). For a TLS deployment's reverse-proxy path
routing, see [install](install.md#production-tls--a-domain).

The one-click [Coolify data migrator](coolify-migration.md) is a **separate one-shot container** that runs on
the untrusted *source* host (not the agent): it talks to the hub over the REST ingest API under
`/api/v1/import/migration/*` with a one-time token — never the agent WebSocket — and streams each database
dump to hub staging, from where the target agent restores it.

## Hub ↔ agent protocol

The agent connects out over WSS and authenticates with an ed25519 keypair. Every hub→agent command is
signed with the hub's key (which the agent pins on connect) and scoped to a granted capability, so a
compromised network path can neither forge commands nor exceed the server's granted capabilities. The
[security overview](security.md) covers this in context.

## Deployment

The [`deploy/docker-compose.yml`](../deploy/docker-compose.yml) stack is hub + web + PostgreSQL + Redis +
the `tugra-updater` sidecar (which applies in-app updates — see [upgrade](upgrade.md)). Releases are built
and signed by [`release.yml`](../.github/workflows/release.yml), which publishes container images and a
signed `versions.json` manifest (details in [Releasing](RELEASING.md)).

## Editions

The Community edition in this repository is the complete product; the proprietary Pro/Cloud layer lives
elsewhere. See [Open-core & editions](open-core.md). The API surface is documented in [api.md](api.md).
