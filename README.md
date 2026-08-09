<div align="center">

<img src="docs/assets/logo-seal.png" alt="Tugra" width="120" />

# Tugra

**Your seal on every server.**

Self-hostable platform to deploy, monitor, back up & orchestrate your servers — one premium control plane. A Coolify / Dokploy / CasaOS alternative, from a Raspberry Pi to a fleet.

[![Release](https://img.shields.io/github/v/release/mrcandev/tugra?sort=semver&label=release)](https://github.com/mrcandev/tugra/releases)
[![License](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)

[Website](https://tugra.io) · [Docs](docs/README.md) · [Releasing](docs/RELEASING.md) · [Roadmap](#roadmap)

</div>

---

> **Status:** Beta. Under active development and dogfooded on real servers — expect rough edges and the occasional breaking change. Stars, issues and feedback are very welcome.

## What is Tugra?

Tugra is a single control plane for your servers. Connect a machine — a $50 Raspberry Pi or a rack of bare-metal — and deploy apps, watch live metrics and logs, take backups, and manage the whole fleet from one place.

Two modes, one platform:

- **Pro / PaaS mode** — deploy from Git, Docker Compose, or images; reverse proxy + automatic SSL; databases; live logs and a web terminal. The Coolify/Dokploy experience, with better polish.
- **Home mode** — a friendly self-host OS with a one-click app store, like CasaOS, for homelabbers and beginners.

## Why Tugra?

- **One pane of glass** — deploy, monitor, back up and orchestrate without stitching five tools together.
- **Lightweight agent** — a single Go binary on each server. No heavy footprint.
- **Premium, calm UI** — built to be a joy to use, dark-first, WCAG AA.
- **Yours** — self-hosted by default; your data stays on your machines.

## Quick start

You need a Linux host with **Docker** (with the Compose v2 plugin) and `git`. From the host:

```bash
git clone https://github.com/mrcandev/tugra.git
cd tugra
./scripts/install.sh
```

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

> Published images (`ghcr.io/mrcandev/tugra-*`) arrive with the first tagged release. Until then the installer automatically builds from your checkout — same command, no changes needed.

## Architecture

| Component | Stack |
|---|---|
| Hub (API + brain) | NestJS · PostgreSQL (Prisma) · Redis / BullMQ |
| Web | Next.js |
| Agent | Go (single binary, per server) |
| Mobile | Flutter |
| Proxy | Traefik (automatic SSL) |

Live logs, metrics and the terminal stream over WebSockets.

## Roadmap

**Shipped**

- [x] Hub ↔ Agent protocol + server enrollment (dial-out WSS · ed25519 · signed commands + capability scope)
- [x] Deploy from Git / Docker Compose / image (Nixpacks · Dockerfile · static-site)
- [x] Reverse proxy + automatic SSL (Traefik · Let's Encrypt)
- [x] Live metrics, build logs & web terminal (WebSocket streams)
- [x] Databases (8 engines) with backups & restore (local + S3/R2 off-site)
- [x] Preview deployments (per pull request)
- [x] Uptime monitoring (HTTP/TCP/metric) + notification channels
- [x] Scheduled tasks (cron) · rollbacks · resource limits & health checks
- [x] Projects / environments · teams, roles & invites · tags · shared variables
- [x] Public API (OpenAPI) + CLI (`tugra`)
- [x] Server patching (OS package updates)
- [x] Self-update (signed releases) + guided onboarding

**Next**

- [ ] App store (Home mode)
- [ ] Mobile app
- [ ] Migrator (import from Coolify / Dokploy)

## License

Tugra uses an **open-core** model:

- **Core** (this repository) — [GNU AGPLv3](LICENSE). Free to use, self-host, study and modify. If you run a modified version as a network service, you must share your changes under the same license.
- **Agent & CLI** — [MIT](agent/LICENSE). Use them anywhere, no strings attached.
- **Tugra Cloud & Pro features** — proprietary, hosted and maintained by us.

**Commercial license:** If you cannot comply with the AGPLv3 (e.g. you want to build a proprietary or SaaS offering on top of Tugra), a commercial license is available. Contact **license@tugra.io**.

## Contributing

Contributions are welcome — please read [CONTRIBUTING.md](CONTRIBUTING.md) first. All contributors must sign the [CLA](CLA.md) so the project can be dual-licensed.

## Security

Found a vulnerability? Please **do not** open a public issue — see [SECURITY.md](SECURITY.md).
