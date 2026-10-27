# Install

Tugra runs as a small Docker Compose stack — hub (API), web UI, PostgreSQL, Redis, and an
update sidecar — that you bring up with a single script. This page is the authoritative
install reference; the [project README](../README.md) has the short version.

## Prerequisites

- A **Linux host** you control (amd64; arm64 works but builds from source — see below).
- **Docker** + the **Compose v2** plugin. The installer installs Docker for you if it's missing.
- `curl` (present on virtually every host); `git` is fetched by the installer if needed.

## Quick start

One line on the host:

```bash
curl -fsSL https://raw.githubusercontent.com/SimerayCom/tugra/main/scripts/bootstrap.sh | sh
```

(or clone first, then run the installer directly — same result:)

```bash
git clone https://github.com/SimerayCom/tugra.git && cd tugra && ./scripts/install.sh
```

It prompts once to share anonymous usage stats (`[Y/n]`, default yes; opt out with `--no-telemetry`).
Run `./scripts/install.sh --help` for all flags (`--domain`, `--home`, `--no-telemetry`, `--public-ip`, …).

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

Published images (`ghcr.io/simeraycom/tugra-*`) are public and pulled automatically, so a normal install
is fast. If a pull can't be satisfied — an **arm64** host (the images are amd64-only) or an offline/mirror
environment — the installer builds from your checkout instead (same command; it takes several minutes and
wants ~2 GB RAM). Force either path with `--pull` or `--build`.

## Production: TLS + a domain

The quick start serves plain HTTP on the host's ports. For a public domain over HTTPS you have two
options — automatic, or bring your own proxy.

### Option A — automatic HTTPS (opt-in)

```bash
./scripts/install.sh --domain tugra.example.com --auto-tls --acme-email you@example.com
```

Tugra provisions the control panel's HTTPS for you: a bundled Traefik reverse proxy gets a Let's Encrypt
certificate and path-routes the single origin (table below). This is **opt-in** (the trust-wedge: the only
outbound call is to Let's Encrypt for *your* domain — no phone-home), so plain `--domain` stays
bring-your-own-proxy. `--acme-email` is required (expiry notices; a placeholder like `example.com` is
rejected). Point the domain's DNS at this host first; the certificate issues on the first reachable request.

**Behind Cloudflare (orange cloud):** HTTP-01 can't validate through the proxy, so pass a Cloudflare API
token and Tugra uses **DNS-01** instead — a real certificate while the record stays proxied and your origin
IP stays hidden:

```bash
./scripts/install.sh --domain panel.example.com --auto-tls --acme-email you@example.com \
  --acme-dns-cloudflare <cf-dns-api-token>
```

(The token is stored only in the `0600` `.env` and handed to Traefik via a `0600` env-file, never on the
command line.) Alternatives without a token: keep the record **DNS-only (grey)** so HTTP-01 issues directly,
or set Cloudflare SSL/TLS to **Full** (Cloudflare serves its own edge cert; the origin serves Traefik's).
Flip the panel on/off or re-apply anytime from **Settings → Panel domain** (`GET`/`POST /instance/panel-tls`).

### Option B — bring your own reverse proxy

Run `--domain` without `--auto-tls` and front the stack with your own TLS proxy (Caddy, Traefik, nginx, …).

Either way, `--domain` sets `COOKIE_SECURE=true` and `HUB_TRUSTED_PROXY=true`. Route most traffic to the
**web** service (`:3001`); send only the paths the web can't handle to the **hub** (`:3000`):

| Path prefix | Route to |
|---|---|
| `/agent`, `/terminal` (WebSocket), `/install`, `/webhooks`, `/auth/oauth`, `/auth/oidc`, `/health`, `/version` | hub `:3000` |
| everything else (`/`, `/api/*`) | web `:3001` |

"Sign in with GitHub" works only in this single-origin proxy deployment (the hub and web share one
public origin so the session cookie is visible to the SPA); it isn't available in the two-port quick start.

## Installer flags

| Flag | Effect |
|---|---|
| `--domain <host>` | Serve `https://<host>` (sets `COOKIE_SECURE` + `HUB_TRUSTED_PROXY`). Bring your own proxy unless `--auto-tls`. |
| `--auto-tls` | With `--domain`: auto-provision the panel's HTTPS (bundled Traefik + Let's Encrypt). Needs `--acme-email`. Opt-in. |
| `--no-auto-tls` | With `--domain`: keep bring-your-own-proxy (no bundled TLS). |
| `--acme-email <addr>` | Let's Encrypt contact email (required by `--auto-tls`; providing it implies `--auto-tls`). |
| `--acme-dns-cloudflare <token>` | DNS-01 via a Cloudflare API token — a real panel cert while the record stays proxied (IP hidden). Implies `--auto-tls`. |
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
