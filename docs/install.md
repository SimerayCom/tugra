# Install

Tugra runs as a small Docker Compose stack — hub (API), web UI, PostgreSQL, Redis, and an
update sidecar — that you bring up with a single script. This page is the authoritative
install reference; the [project README](../README.md) has the short version.

## Prerequisites

- A **Linux host** you control (a Raspberry Pi is fine).
- **Docker** with the **Compose v2** plugin (`docker compose version`).
- **git** (to clone the repository).

## Quick start

From the host:

```bash
git clone https://github.com/SimerayCom/tugra.git
cd tugra
./scripts/install.sh
```

The installer:

1. Generates strong secrets **once** into a local `.env` at `chmod 600` (re-running preserves them).
2. Brings up the hub, web UI, PostgreSQL and Redis with `docker compose` (the hub applies database
   migrations on boot).
3. Waits for the hub to become healthy and prints the **Web UI** and **Hub API** URLs.

In the two-port quick start the web UI is at `http://<host-ip>:3001` and the hub/API base is
`http://<host-ip>:3000`. Open the web UI and create the first account — it becomes the instance
**owner**. On a fresh install the installer prints a one-time **setup code**; enter it when creating the
owner account (to recover it later: `grep SETUP_CODE .env`). Then follow the onboarding wizard to connect
your first server.

Published images (`ghcr.io/simeraycom/tugra-*`) are used when available; until the first tagged release
the installer automatically builds from your checkout — the same command, no changes needed.

## Production: TLS + a domain

The quick start serves plain HTTP on the host's ports. For production, put Tugra behind your own
reverse proxy that terminates TLS, and re-run with your domain:

```bash
./scripts/install.sh --domain tugra.example.com
```

`--domain` sets `COOKIE_SECURE=true` and `HUB_TRUSTED_PROXY=true` for that topology. **TLS is not
bundled** — bring your own proxy (Caddy, Traefik, nginx, …).

Route most traffic to the **web** service (`:3001`), which proxies the REST API and OAuth start to the
hub; send only the paths the web can't handle to the **hub** (`:3000`):

| Path prefix | Route to |
|---|---|
| `/agent`, `/terminal` (WebSocket), `/install`, `/webhooks`, `/auth/oauth` | hub `:3000` |
| everything else (`/`, `/api/*`) | web `:3001` |

"Sign in with GitHub" works only in this single-origin proxy deployment (the hub and web share one
public origin so the session cookie is visible to the SPA); it isn't available in the two-port quick start.

## Installer flags

| Flag | Effect |
|---|---|
| `--domain <host>` | Serve `https://<host>` behind a TLS reverse proxy (sets `COOKIE_SECURE` + `HUB_TRUSTED_PROXY`). |
| `--hub-url <url>` | Explicit public hub URL (overrides `--domain`). |
| `--web-url <url>` | Explicit public web (browser) origin. |
| `--build` | Force building images from your checkout (skip pulling published images). |
| `--pull` | Force pulling published images (no source fallback). |
| `--env-file <path>` | Write the env file elsewhere (default `<repo>/.env`). |
| `--dry-run` | Generate `.env` and exit — touch no Docker. |
| `-h`, `--help` | Print usage. |

## Configuration

Runtime configuration lives in the generated `.env`. See [`.env.example`](../.env.example) for every
key and what it does. The stability secrets (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`,
`SECRETS_ENCRYPTION_KEY`, `HUB_SIGNING_KEY`, `POSTGRES_PASSWORD`) are generated once and preserved
across re-runs — regenerating them would invalidate sessions, encrypted data and the signing identity.

**arm64 control plane:** the published hub/web/updater images are amd64-only. On an arm64 host
(e.g. a Pi control plane) run `./scripts/install.sh --build` to build natively; the agent image is
multi-arch, so managed servers of any architecture are supported.

## Next steps

- [Upgrade](upgrade.md) — keep Tugra current (`git pull && ./scripts/install.sh`, or in-app updates).
- [CLI](cli.md) — drive Tugra from the terminal.
- [Architecture](architecture.md) — understand the moving parts.
