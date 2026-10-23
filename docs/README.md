# Tugra documentation

Guides for installing, operating, extending and understanding Tugra — the self-hostable
control plane for your servers. New here? Start with the [project overview](../README.md).

## Getting started

- [Install](install.md) — prerequisites, the one-line installer, and a production TLS setup.
- [Upgrade](upgrade.md) — in-app updates, manual upgrades, and how the signed update flow works.
- [Disaster recovery](disaster-recovery.md) — backing up + restoring the Tugra hub's own state (control plane).

## Using Tugra

- [CLI](cli.md) — the `tugra` command-line client (full reference in the [package README](../packages/cli/README.md)).
- [API](api.md) — the REST API, interactive docs, authentication and scopes.
- [Migrating from Coolify](coolify-migration.md) — one-command database-data migration (Postgres/MySQL/MariaDB/Redis/KeyDB/Dragonfly) plus the manual runbook for apps, volumes and the other engines.

## Understanding Tugra

- [Architecture](architecture.md) — how the hub, web, agent and data plane fit together.
- [Open-core & editions](open-core.md) — the licensing model and the Community/Pro/Cloud boundary.
- [Security](security.md) — the security model and where to report a vulnerability.

## Operating & contributing

- [Smoke test](smoke-test.md) — an end-to-end check of backup/restore, deploy and MCP against a real server.
- [Releasing](RELEASING.md) — cutting a signed release (maintainers).
- [Contributing](../CONTRIBUTING.md) · [Code of conduct](../CODE_OF_CONDUCT.md) · [CLA](../CLA.md)
- [Security policy](../SECURITY.md) · [License](../LICENSE)
