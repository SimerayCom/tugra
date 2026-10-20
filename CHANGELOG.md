# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - unreleased

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
