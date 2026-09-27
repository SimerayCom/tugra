<div align="center">

<img src="docs/assets/logo-seal.png" alt="Tugra" width="120" />

# Tugra

*Your seal on every server.*

**Open-core, self-hostable PaaS built for fleets and AI agents.**

[![GitHub stars](https://img.shields.io/github/stars/SimerayCom/tugra?style=flat&logo=github&label=stars)](https://github.com/SimerayCom/tugra/stargazers)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
[![Release](https://img.shields.io/github/v/release/SimerayCom/tugra?sort=semver&label=release)](https://github.com/SimerayCom/tugra/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/SimerayCom/tugra/ci.yml?branch=main&label=CI)](https://github.com/SimerayCom/tugra/actions/workflows/ci.yml)
[![Image: ghcr.io](https://img.shields.io/badge/image-ghcr.io%2Fsimeraycom%2Ftugra--hub-blue?logo=docker&logoColor=white)](#quick-start)

<!-- TODO: docs/assets/deploy.gif — record a real deploy (connect a server → deploy an app) and embed it here -->
<!-- TODO: docs/assets/screenshot-dashboard.png — add a real dashboard screenshot, linked here -->

[Website](https://tugra.io) · [Docs](docs/README.md) · [Releasing](docs/RELEASING.md) · [Roadmap](#roadmap)

</div>

---

> **Status:** Beta. Under active development and dogfooded on real servers — expect rough edges and the occasional breaking change. Stars, issues and feedback are very welcome.

## Agent-native by default

Tugra ships a native [MCP](https://modelcontextprotocol.io) server — point any AI agent (Claude, Cursor, or your own) at your infrastructure and let it read live state before you ask it to act, without a separate integration package or a scraped API key.

```bash
# List every tool the server exposes
curl -s https://your-tugra-host/api/v1/mcp \
  -H "Authorization: Bearer $TUGRA_PAT" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Ask it something real: what's actually deployed right now?
curl -s https://your-tugra-host/api/v1/mcp \
  -H "Authorization: Bearer $TUGRA_PAT" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_applications","arguments":{}}}'
```

It's the same `POST /api/v1/mcp` endpoint, the same personal-access-token auth, scopes and IP allowlist as the REST API underneath — no separate credential to manage, and no decrypted secret values are ever returned to the model. Today's catalog is **17 read-only tools** across apps, servers, clusters, databases, backups and monitors (Phase1); mutating tools land in a later phase.

## What is Tugra?

Tugra is a self-hostable, open-core control plane for deploying, monitoring and operating apps and databases across your own servers — the day-to-day of Heroku, Render or Railway, without handing your infrastructure to someone else's cloud. Its focus is the **fleet**: real Docker Swarm clusters across your servers (not just one-box-at-a-time management), fleet-wide bulk operations, and a built-in MCP server for AI-driven ops — all under a license you can actually read.

## Why Tugra

- **Fleet-first, not single-box** — group servers into clusters, form a real Docker Swarm across them, and run one command across your whole fleet in a single bulk-ops call instead of SSH-ing into each box.
- **Agent-native too** — a built-in MCP server exposes 17 read-only tools over `POST /api/v1/mcp`, scoped by the same personal-access tokens as the REST API (mutating tools are on the roadmap).
- **9 database engines, one workflow** — PostgreSQL, MySQL, MariaDB, MongoDB, Redis, KeyDB, Dragonfly, ClickHouse and LibSQL, all provisioned, backed up and restored the same way.
- **Real TLS, real wildcards** — automatic Let's Encrypt per app via Traefik, plus DNS-01 wildcard certificates (`*.yourdomain.com`) for clustered/Swarm ingress — not just single-domain HTTP-01.
- **Backups that leave the building** — scheduled dumps to local disk or S3-compatible storage (S3/R2/MinIO), encrypted, with one-click restore.
- **Open-core, not open-washed** — everything above ships free under AGPL-3.0 in *this* repository. Pro/Cloud (SSO, audit-log export, whitelabel, multi-tenant billing) is a separately-licensed add-on — nothing here phones home, nags you to upgrade, or silently caps what you can do.

## How Tugra compares

A short, honest comparison (competitor columns last verified 2026-09-27) — cells we couldn't verify with confidence are marked `—` rather than guessed:

| | **Tugra** | Coolify | Dokploy | CapRover | Dokku |
|---|---|---|---|---|---|
| Multi-node clustering | ✅ | Planned (v5, no date)¹ | ✅ Swarm-based | ✅ Swarm-based | — |
| MCP / agent control | ✅ built-in (17 tools, read-only)⁵ | ✅ built-in (read+write) | ✅ official (read+write) | — | community project (early)² |
| Database engines | **9** (named above) | 8 | 6 | — | — |
| Bulk ops across servers | ✅ one call, any node set | — | — | — | — |
| Core license | AGPL-3.0 | Apache-2.0 | Apache-2.0³ | Apache-2.0 + custom terms⁴ | MIT |

<sub>¹ Coolify's stable v4 manages servers individually; multi-server clustering was announced for a future v5 with no published date. ² Third-party project, not an official Dokku release, and marked early-stage by its own author. ³ Dokploy's core is Apache-2.0; a separate Source Available license covers its `proprietary/` enterprise directory (SSO, audit logs, whitelabel) — the same open-core shape Tugra uses. ⁴ CapRover's `LICENSE` is Apache-2.0 with an added appendix restricting modification/redistribution of paid features. ⁵ All three ship an MCP server today; Tugra's is read-only in this release (mutating tools are planned), while Coolify and Dokploy already expose write/mutate tools — so this is parity, not a Tugra-only feature. Competitor facts change — please verify before repeating them.</sub>

## Quick start

You need a Linux host with **Docker** (with the Compose v2 plugin) and `git`. From the host:

```bash
git clone https://github.com/SimerayCom/tugra.git
cd tugra
./scripts/install.sh
```

[Review `scripts/install.sh`](scripts/install.sh) before you run it, as with any script you're handing root-ish Docker access — it only writes a local `.env` and calls `docker compose`, and it's idempotent (safe to re-run).

The installer generates strong secrets into a local `.env` (re-running preserves them), then brings up the hub, web UI, PostgreSQL and Redis with `docker compose`. When it finishes, open the printed **Web UI** URL and create the first account — it becomes the instance **owner**. Then follow the onboarding wizard to connect your first server.

Re-running `./scripts/install.sh` (e.g. after `git pull`) is safe — it keeps your secrets and only updates configuration, so it doubles as the upgrade path.

**Production (TLS + a domain).** The stack ships plain HTTP on this host's ports for a quick start; put it behind your own reverse proxy that terminates TLS and re-run with your domain:

```bash
./scripts/install.sh --domain tugra.example.com
```

Route most traffic to the **web** (`:3001`) — it proxies the REST API and OAuth start to the hub for you — and send only the paths the web can't handle to the **hub** (`:3000`):

| Path prefix | → |
|---|---|
| `/agent`, `/terminal` (WebSocket), `/install`, `/webhooks`, `/auth/oauth` | hub `:3000` |
| everything else (`/`, `/api/*`) | web `:3001` |

Notes:

- **TLS is not bundled** — bring your own reverse proxy (Caddy, Traefik, nginx, …). `--domain` sets `COOKIE_SECURE=true` + `HUB_TRUSTED_PROXY=true` for that setup.
- **"Sign in with GitHub"** works only in this single-origin proxy deployment (the hub and web share a public origin so the session cookie is visible to the SPA); it isn't available in the plain two-port quick start.

> Published images (`ghcr.io/simeraycom/tugra-*`) arrive with the first tagged release. Until then the installer automatically builds from your checkout — same command, no changes needed.

**MCP quick start.** Once Tugra is up, mint a personal access token (**Settings → API tokens**) and point any MCP client at it:

```bash
curl -s http://<web-url>/api/v1/mcp \
  -H "Authorization: Bearer $TUGRA_PAT" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
```

## Self-hosted vs. cloud

Everything in [Why Tugra](#why-tugra) above is **free and open-source forever**, under AGPL-3.0, self-hosted on your own servers — no artificial cap, no feature flag waiting to be flipped on for money. The Community edition in this repository is the real product, not a crippled demo.

A Pro/Cloud tier (SSO, audit-log export, whitelabel, a managed control plane) is designed into the codebase as a cryptographically-signed license gate — but it is available under a separate commercial license. Need something Community can't do, or can't comply with AGPL-3.0 for a proprietary/SaaS build on top of Tugra? A commercial license is available — contact **license@tugra.io**.

## Architecture

| Component | Stack |
|---|---|
| Hub (API + brain) | NestJS · PostgreSQL (Prisma) · Redis / BullMQ |
| Web | Next.js |
| Agent | Go (single binary, per server) |
| Proxy | Traefik (automatic SSL, incl. DNS-01 wildcard) |

Live logs, metrics and the terminal stream over WebSockets. Full breakdown in [docs/architecture.md](docs/architecture.md).

## Roadmap

**Shipped**

- [x] Hub ↔ Agent protocol + server enrollment (dial-out WSS · ed25519 · signed commands + capability scope)
- [x] Deploy from Git / Docker Compose / image (Nixpacks · Dockerfile · static-site)
- [x] Reverse proxy + automatic SSL (Traefik · Let's Encrypt, incl. DNS-01 wildcard)
- [x] Live metrics, build logs & web terminal (WebSocket streams)
- [x] Databases (9 engines) with backups & restore (local + S3/R2 off-site)
- [x] Multi-server clusters + Docker Swarm formation, bulk ops across the fleet
- [x] Native MCP server (read-only, 17 tools)
- [x] Preview deployments (per pull request)
- [x] Uptime monitoring (HTTP/TCP/metric) + notification channels
- [x] Scheduled tasks (cron) · rollbacks · resource limits & health checks
- [x] Projects / environments · teams, roles & invites · tags · shared variables
- [x] Public API (OpenAPI) + CLI (`tugra`)
- [x] Server patching (OS package updates)
- [x] Self-update (signed releases) + guided onboarding
- [x] Migrator — discover & adopt existing/foreign containers into Tugra

**Next**

- [ ] MCP write/mutate tools + OAuth
- [ ] App store (Home mode)
- [ ] Mobile app
- [ ] Config-aware import from Coolify / Dokploy (on top of the existing adopt flow)

## Community & docs

- [Full documentation](docs/README.md) — install, architecture, API, CLI, security, open-core
- [Issues](https://github.com/SimerayCom/tugra/issues) — bug reports & feature requests
- [Discussions](https://github.com/SimerayCom/tugra/discussions) — questions, ideas, show-and-tell
- [Contributing](CONTRIBUTING.md) · [Code of Conduct](CODE_OF_CONDUCT.md) · [CLA](CLA.md)
- [Security policy](SECURITY.md)

## Contributors

<a href="https://github.com/SimerayCom/tugra/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=SimerayCom/tugra" alt="Contributors" />
</a>

## Sponsors

Tugra is built and maintained in the open. If it's useful to you or your team, consider [sponsoring the project on GitHub](https://github.com/sponsors/mrcandev) — there's no sponsor tier yet, so you'd be the first, and every bit helps keep development independent.

## Star history

[![Star History Chart](https://api.star-history.com/svg?repos=SimerayCom/tugra&type=Date)](https://star-history.com/#SimerayCom/tugra&Date)

## License

Tugra uses an **open-core** model:

- **Core** (this repository) — [GNU AGPLv3](LICENSE). Free to use, self-host, study and modify. If you run a modified version as a network service, you must share your changes under the same license.
- **Agent & CLI** — [MIT](agent/LICENSE). Use them anywhere, no strings attached.
- **Tugra Cloud & Pro features** — proprietary, not published yet (see [Self-hosted vs. cloud](#self-hosted-vs-cloud)).

**Commercial license:** If you cannot comply with the AGPLv3 (e.g. you want to build a proprietary or SaaS offering on top of Tugra), a commercial license is available. Contact **license@tugra.io**. Full breakdown in [docs/open-core.md](docs/open-core.md).

---

<div align="center"><sub>AGPL-3.0 © Tugra contributors — see <a href="LICENSE">LICENSE</a>.</sub></div>
