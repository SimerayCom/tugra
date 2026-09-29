# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - unreleased

Initial public release. Tugra is a self-hostable control plane for deploying, monitoring, backing up
and orchestrating servers — from a single Raspberry Pi to a fleet.

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
  (`POST /api/v1/mcp`) with 34 tools for AI assistants and agents: 17 read tools over applications,
  servers, clusters, databases and monitors, plus 17 PAT-scoped mutate/ops tools (app lifecycle +
  live scale, env config, swarm operations, and a preview-then-confirm fleet action). Irreversible
  tools (dissolve a swarm, remove an app) require echoing the resource name; OAuth for third-party
  clients is still planned.
- **Web dashboard** — the Next.js web UI covering deployment, monitoring, backups, teams/projects and
  instance settings.
- **Public API & CLI** — a versioned REST API (OpenAPI) and the `tugra` CLI.
- **Platform** — signed hub↔agent protocol (dial-out WSS, ed25519-signed commands, capability scoping),
  teams/roles/invites, projects & environments, scheduled tasks, server patching, and signed self-update.
