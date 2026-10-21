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

[Website](https://tugra.io) · [Docs](docs/README.md) · [Releasing](docs/RELEASING.md) · [Roadmap](#roadmap)

</div>

---

> **Status:** Beta. Under active development; APIs may change between minor releases. Stars, issues and feedback are very welcome.

## Agent-native by default

Tugra ships a native [MCP](https://modelcontextprotocol.io) server — point Claude, Cursor or your own agent at your infrastructure to inspect, deploy, scale and operate it, using the same personal-access tokens, scopes and audit trail as the REST API. No separate integration package, no secret values ever returned to the model.

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

It's the same `POST /api/v1/mcp` endpoint, the same personal-access-token auth, scopes and IP allowlist as the REST API underneath — no separate credential to manage, and no decrypted secret values are ever returned to the model. The catalog is **46 tools**: 25 read-only (including one-call fleet status / health / app-listing rollups and a sandboxed volume file browser), plus 21 PAT-scoped mutate/ops tools (deploy · restart · live-scale · roll back · set env · form/grow a swarm · fleet-wide actions across a cluster · one-click domain DNS setup). Every mutate tool reuses the REST API's exact team-permission checks and audit trail, and the irreversible ones (dissolve a swarm, remove an app) require an explicit name-confirmation. OAuth for third-party clients is still on the roadmap.

## What is Tugra?

Tugra is a self-hostable, open-core control plane for deploying, monitoring and operating apps and databases across your own servers — the day-to-day of Heroku, Render or Railway, without handing your infrastructure to someone else's cloud. Its focus is the **fleet**: real Docker Swarm clusters across your servers (not just one-box-at-a-time management), fleet-wide bulk operations, and a built-in MCP server for AI-driven ops — all under a license you can actually read.

## Why Tugra

- **Fleet-first, not single-box** — group servers into clusters, form a real Docker Swarm across them, and run one command across your whole fleet in a single bulk-ops call instead of SSH-ing into each box.
- **Agent-native too** — a built-in MCP server exposes 46 tools (read + PAT-scoped mutate/fleet ops) over `POST /api/v1/mcp`, scoped by the same personal-access tokens as the REST API.
- **9 database engines, one workflow** — PostgreSQL, MySQL, MariaDB, MongoDB, Redis, KeyDB, Dragonfly, ClickHouse and LibSQL, all provisioned, backed up and restored the same way.
- **Real TLS, real wildcards** — automatic Let's Encrypt per app via Traefik, plus DNS-01 wildcard certificates (`*.yourdomain.com`) for clustered/Swarm ingress — not just single-domain HTTP-01.
- **Backups that leave the building** — scheduled dumps to local disk or S3-compatible storage (S3/R2/MinIO), encrypted, with one-click restore.
- **Open-core, not open-washed** — everything above ships free under AGPL-3.0 in *this* repository. Pro/Cloud (SSO, audit-log export, whitelabel, multi-tenant billing) is a separately-licensed add-on — nothing here phones home, nags you to upgrade, or silently caps what you can do.

## How Tugra compares

A side-by-side with the self-hostable PaaS tools people actually evaluate (competitor data checked 2026-10). `✅` built-in · `~` partial / limited · `—` no documented built-in equivalent · `🔜` on Tugra's roadmap. Spotted an error? [Open an issue](https://github.com/SimerayCom/tugra/issues).

| | **Tugra** | Coolify | Dokploy | Portainer | CapRover | Dokku |
|---|---|---|---|---|---|---|
| **Deploy & build** | | | | | | |
| Web UI dashboard | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Deploy from Git | ✅ | ✅ | ✅ | ~ | ~ | ✅ |
| Docker Compose deploy | ✅ | ✅ | ✅ | ✅ | ~ | ~ |
| Preview deployments (PR apps) | ✅ | ✅ | ✅ | — | — | ~ |
| Rollbacks | ✅ | ✅ | ✅ | — | ✅ | ~ |
| App store / one-click templates | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| **Data** | | | | | | |
| Managed database engines | **9** | 8 | 6 | — | — | — |
| Scheduled S3 backups + restore | ✅ | ✅ | ✅ | — | — | ~ |
| Arbitrary Docker-volume backups | ✅ | — | ✅ | — | — | — |
| **Domains & TLS** | | | | | | |
| Custom domains + automatic SSL | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| DNS-01 wildcard certificates | ✅ | ~ | — | — | — | ~ |
| **Fleet & HA** | | | | | | |
| Multi-node clustering | ✅ Swarm | Individual¹ | ✅ Swarm | ✅ | ✅ | ~ k3s⁶ |
| Multi-manager Raft HA + ingress HA | ✅ | — | — | — | — | — |
| Fleet-wide bulk ops (one call) | ✅ | — | — | — | — | — |
| OS patching (per-server + fleet) | ✅ | — | — | — | — | — |
| **Observability** | | | | | | |
| Built-in metrics (CPU/RAM/disk) | ✅ | ~ | ✅ | ~ | — | — |
| Uptime monitors + notifications | ✅ | ~ | ✅ | — | — | — |
| App / container log viewer | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| **Access & agent** | | | | | | |
| Teams / RBAC | ✅ | ~ | ✅ | ~⁷ | — | — |
| SSO / OIDC | ✅ (Pro)⁸ | ✅ | ✅ | ~⁷ | — | — |
| Audit log | ✅ | ✅ | ✅ | ~⁷ | — | — |
| MCP / agent control | ✅ 46 tools⁵ | ✅ | ✅ | — | — | ~² |
| **Trust & license** | | | | | | |
| No phone-home (zero telemetry) | ✅ | — | — | ~ | — | ✅ |
| Migrate in (import from Coolify) | ✅ | — | — | — | — | — |
| Core license | AGPL-3.0 | Apache-2.0 | Apache-2.0³ | zlib + BE⁷ | Apache-2.0 + terms⁴ | MIT |

<sub>¹ Coolify v4 manages servers individually (no built-in clustering). ² A third-party, early-stage Dokku MCP project, not an official release. ³ Dokploy's core is Apache-2.0; a separate Source-Available license covers its enterprise `proprietary/` directory (SSO, audit logs, whitelabel) — the same open-core shape Tugra uses. ⁴ CapRover's `LICENSE` is Apache-2.0 with an appendix restricting modification/redistribution of paid features. ⁵ Tugra, Coolify and Dokploy all ship MCP servers with read and write tools, so agent control is at parity; Tugra adds fleet-wide actions (one call across a cluster), name-confirmation on destructive tools, and secret redaction. ⁶ Dokku has no Docker Swarm support; its multi-node option is the `scheduler-k3s` plugin (k3s/Kubernetes), a different architecture. ⁷ Portainer's RBAC, SSO and audit logs are part of its paid Business Edition. ⁸ Tugra's core is free and full-featured (teams/RBAC, audit log, backups, monitoring, MCP, migrator, multi-node HA); SSO/OIDC is a Pro feature. Product names are trademarks of their respective owners; Tugra is not affiliated with or endorsed by them.</sub>

## Quick start

On a fresh Linux host, **one command** installs the prerequisites (git, Docker), clones the repo and brings the stack up:

```bash
curl -fsSL https://raw.githubusercontent.com/SimerayCom/tugra/main/scripts/bootstrap.sh | sh
```

Prefer to read before you run (sensible for any script you're handing root-ish Docker access)? Clone and run the installer yourself — it only writes a local `.env` and calls `docker compose`, installs Docker if it's missing, and is idempotent (safe to re-run):

```bash
git clone https://github.com/SimerayCom/tugra.git
cd tugra
less scripts/install.sh   # review it first
./scripts/install.sh
```

The installer generates strong secrets into a local `.env` (re-running preserves them), then brings up the hub, web UI, PostgreSQL and Redis with `docker compose`. When it finishes, open the printed **Web UI** URL (`http://<host-ip>:3001`; the hub/API base is `http://<host-ip>:3000`) and create the first account — it becomes the instance **owner**. On a fresh install the installer also prints a one-time **setup code** to enter when creating that account (recover it with `grep SETUP_CODE .env`). Then follow the onboarding wizard to connect your first server.

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

Pro and Cloud editions (SSO, audit-log export, whitelabel, managed control plane) are offered under a separate commercial license. For a non-AGPL license or something Community can't do, contact **license@tugra.io**.

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
- [x] Native MCP server — 46 tools (read + PAT-scoped mutate/fleet ops) + guided prompts
- [x] App store — one-click template catalog + Home-mode launcher
- [x] Read-only file browser for app volumes (web UI + MCP `list_files`)
- [x] Preview deployments (per pull request)
- [x] Uptime monitoring (HTTP/TCP/metric) + notification channels
- [x] Scheduled tasks (cron) · rollbacks · resource limits & health checks
- [x] Projects / environments · teams, roles & invites · tags · shared variables
- [x] Public API (OpenAPI) + CLI (`tugra`)
- [x] Server patching (OS package updates)
- [x] Self-update (signed releases) + guided onboarding
- [x] Migrator — adopt local Docker containers + import from Coolify (connect · plan · apply · rollback)

**Next**

- [ ] MCP OAuth for third-party clients (dynamic client registration, PKCE)
- [ ] File manager — write support (upload / rename / delete)
- [ ] More migration sources (Dokploy, CapRover)
- [ ] Mobile app

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

<div align="center"><sub>AGPL-3.0 © Simeray Ltd — see <a href="LICENSE">LICENSE</a>.</sub></div>
