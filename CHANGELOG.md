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
- **Clustering** — Docker Swarm-based multi-server clusters, with fleet-wide bulk operations.
- **MCP server** — a read-only [Model Context Protocol](docs/api.md#mcp-server) server
  (`POST /api/v1/mcp`) exposing ~17 read tools over applications, servers, clusters, databases and
  monitors, for AI assistants and agents.
- **Web dashboard** — the Next.js web UI covering deployment, monitoring, backups, teams/projects and
  instance settings.
- **Public API & CLI** — a versioned REST API (OpenAPI) and the `tugra` CLI.
- **Platform** — signed hub↔agent protocol (dial-out WSS, ed25519-signed commands, capability scoping),
  teams/roles/invites, projects & environments, scheduled tasks, server patching, and signed self-update.
