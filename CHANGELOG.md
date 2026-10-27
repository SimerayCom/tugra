# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- **Automatic HTTPS for the control panel (opt-in).** `install.sh --domain <host> --auto-tls --acme-email
  <you@domain>` now provisions the panel's TLS itself — the bundled Traefik gets a Let's Encrypt certificate
  and path-routes the single origin, with no hand-written reverse-proxy config. Works behind Cloudflare (a
  grey DNS record, SSL mode Full, or a DNS-01 token). Opt-in: plain `--domain` stays bring-your-own-proxy and
  the only outbound call is to Let's Encrypt for your own domain (no phone-home). The hub and web join a
  dedicated `tugra-panel` Docker network that Traefik routes over, isolated from deployed apps. Check or
  re-apply from **Settings → Panel domain** (`GET`/`POST /instance/panel-tls`). See
  [docs/install.md](docs/install.md).
- **Turnkey add-server:** the agent installer now auto-installs Docker (via get.docker.com) when it's
  missing and the script runs as root — matching the hub installer, so adding a second/remote server is a
  single pasted command. Opt out with `TUGRA_SKIP_DOCKER_INSTALL=1`; a non-root run still prints the manual
  install hint (nothing half-installs).
- One-click Coolify database migration: after importing a Coolify fleet, mint a one-time migration
  token for the import operation and paste the printed one-liner on the Coolify host. It dumps each
  Postgres, MySQL, MariaDB, Redis, KeyDB and Dragonfly database and restores it into the matching
  Tugra database — cross-host, with the token only ever in the environment and no database password
  ever reaching the hub. MongoDB, ClickHouse, LibSQL and app volumes stay on the manual runbook.
  See [docs/coolify-migration.md](docs/coolify-migration.md).
- Coolify import env-remap: a read-only preview, then a confirm-gated apply, rewrites each migrated
  app's environment to point at its new Tugra database (secret-masked diff, a `planHash` the apply must
  match, and a one-call undo). Cross-host/swarm/compose apps are shown as needs-manual, never half-wired.
- Managed-DB network link: an app can opt into the node-local `tugra-net` so a migrated (or native)
  co-located app reaches its database by container name; the env-remap apply wires eligible apps in.
- OS patching now patches the **host**, not the agent's own container. It runs the package manager in
  the host namespaces via a one-shot privileged helper launched from the agent's image, and fails
  closed (a clear error, never a silent container-only patch) if it cannot enter the host.
- **Anonymous usage stats (on by default, opt-out).** The hub now sends a once-a-day anonymous ping:
  aggregate counts (servers, apps, databases, deploys, teams, users, clusters, monitors, containers)
  plus its version, edition and OS/arch, keyed by a random, stable instance id. The payload carries no
  IP, hostname, domain, email, app or server name, and the receiver does not store the sender's IP. See
  the exact payload — and opt out — in **Settings → Anonymous usage stats**, or set `TUGRA_TELEMETRY=0`
  (a hard off that the installer's `--no-telemetry` writes). Every outbound connection Tugra can make is
  inventoried in [docs/security.md](docs/security.md).
  **⚠️ Upgrading from a pre-telemetry release (0.1.x):** earlier versions made no such call. This upgrade
  turns the stats **on** — if you want to stay off, set `TUGRA_TELEMETRY=0` (or flip the Settings toggle)
  after upgrading.
- **No update ping, IP probe or version checks by default.** A fresh install makes no update ping, no
  public-IP probe, no Prisma version check and no Traefik version check (anonymous usage stats above are
  the one deliberate default-on call) — otherwise it contacts only the registries it pulls images from.
  Update checks are opt-in (`install.sh --enable-update-checks`, or `UPDATE_MANIFEST_URL`/`_PUBLISHER_KEY`
  in `.env`); public-IP detection is opt-in (`--detect-public-ip`, or pin one with `--public-ip <ip>`).
  **Existing installs:** your `.env` keeps `UPDATE_MANIFEST_URL`, `UPDATE_PUBLISHER_KEY` and
  `LOCAL_SERVER_PUBLIC_IP` from the previous installer (values are written once). To stop update checks,
  blank those three keys and restart hub-api; leave them to keep update checks on.

## [0.1.3] - 2026-10-20

- Database live logs: stream and download a database container's logs from a new Logs
  tab, the same viewer applications already use.
- Fleet-wide OS updates: check and apply OS package updates across many servers at once
  from the servers bulk bar; reboots are never automatic.
- Smoother navigation: clicking anywhere on a server, project or cluster-member row opens
  it, and database and project lists now show the engine's brand icon.
- Clearer wording: database actions now read Deploy / Redeploy (was Provision).
- Releases now publish GitHub release notes from this changelog.

## [0.1.2] - 2026-10-20

- Smoother create to deploy flow: new apps and databases start right away (opt-out
  per resource), with live deploy output, status-aware actions and clearer empty states.
- Panel polish: team badges in the all-teams project list, a reveal toggle for secret
  connection fields, and a clearer message when a shell target is not running yet.

## [0.1.1] - 2026-10-20

- Turnkey quick start: a one-command installer (`scripts/bootstrap.sh`) that installs
  prerequisites, sets up Docker automatically, and shows a startup banner, a requirements
  check and step-by-step progress.
- The bundled single-box agent connects automatically after owner setup; the web UI,
  terminal and webhooks resolve the hub's public address at runtime.
- Agent resilience (re-enrollment, a larger message limit, process-group command timeouts)
  and a safer self-update (post-update health check with automatic rollback).

## [0.1.0] - 2026-10-20

Initial public release. Tugra is a self-hostable control plane for deploying, monitoring, backing up
and orchestrating servers — from a single Raspberry Pi to a fleet.

**2026-10-05**

- **One-click Cloudflare DNS setup** — store a Cloudflare API token as a team DNS credential, then set up a
  custom domain in one step: Tugra creates the apex `A`/`AAAA` records (one per cluster-ingress node for
  failover) plus an optional `www` `CNAME` and wires the app's HTTPS (`POST /apps/:id/domain/auto-setup`,
  with dry-run preview and an explicit `overwrite`). Copy-paste records for any other DNS provider
  (`GET /apps/:id/domain/manual-records`), propagation check (`POST /apps/:id/domain/verify`) and teardown
  (`DELETE /apps/:id/domain/dns`) are included, as is the `tugra apps domain` CLI command and the
  `setup_app_domain` / `verify_app_domain` MCP tools. Cloudflare only in this release; records are created
  DNS-only (never proxied) to avoid the Flexible-SSL redirect loop; a record that points elsewhere is
  replaced only with `overwrite`, and `TXT`/`MX` records are never touched.
- **Personal-access-token API parity** — teams, notification channels, registries, Git sources, cloud
  credentials, the audit log and saved views are now reachable with scope-checked PATs (and the CLI), not
  only a browser session; the same team-permission checks still apply. Token management stays session-only.
  Hardened audit-log redaction and team-permission checks.
- **Per-token API rate limits** — each personal-access-token request is counted against its own budget (default
  300 req / 60s, `API_RATE_LIMIT` / `API_RATE_WINDOW_SEC`) on top of the global per-IP throttle; responses carry
  `X-RateLimit-Limit`/`-Remaining`/`-Reset` and an over-budget call returns `429` with `Retry-After`. Browser
  sessions are unaffected, and a Redis outage fails open. (Pagination and a richer CLI/SDK are still planned.)

### Added

- **Deploy** — from Git (Nixpacks / Dockerfile / static-site), Docker Compose, or a container image;
  preview deployments per pull request; rollbacks, resource limits and health checks.
- **Domains & TLS** — custom domains behind an automatic reverse proxy (Traefik), with Let's Encrypt
  certificates via HTTP-01 and DNS-01 (wildcard) challenges.
- **Databases** — managed databases across 9 engines (PostgreSQL, MySQL, MariaDB, MongoDB, Redis, KeyDB,
  Dragonfly, ClickHouse, LibSQL), with backups to local storage or S3/R2-compatible off-site storage,
  and one-click restore.
- **Monitoring & notifications** — uptime monitors (HTTP/TCP/metric checks) with configurable
  notification channels.
- **Clustering** — Docker Swarm-based multi-server clusters, with fleet-wide bulk operations. The overlay
  network is now **encrypted by default** (VXLAN + IPsec) for inter-node traffic; a background health check
  alerts (`swarm_degraded` notification) when a cluster drops from healthy to degraded; per-app soft resource
  reservations (`--reserve-memory`/`--reserve-cpu`) are supported for swarm scheduling; and stop/start now
  waits for the service to actually converge.
- **MCP server** — a built-in [Model Context Protocol](docs/api.md#mcp-server) server
  (`POST /api/v1/mcp`) with 46 tools for AI assistants and agents: 25 read tools (applications,
  servers, clusters, databases, monitors, fleet rollups, a read-only volume file browser) + guided
  prompts, plus 21 PAT-scoped mutate/ops tools (app lifecycle +
  live scale, env config, swarm operations, one-click domain DNS setup/verify, and a preview-then-confirm
  fleet action). Irreversible tools (dissolve a swarm, remove an app) require echoing the resource name;
  OAuth for third-party clients is still planned.
- **Web dashboard** — the Next.js web UI covering deployment, monitoring, backups, teams/projects and
  instance settings.
- **Public API & CLI** — a versioned REST API (OpenAPI) and the `tugra` CLI.
- **Platform** — signed hub↔agent protocol (dial-out WSS, ed25519-signed commands, capability scoping),
  teams/roles/invites, projects & environments, scheduled tasks, server patching, and signed self-update.
