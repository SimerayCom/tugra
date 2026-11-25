# Tugra documentation

Guides for installing, operating, extending and understanding Tugra — the self-hostable
control plane for your servers. New here? Start with the [project overview](../README.md).

## Step-by-step guides

Short, in-order guides with the steps, what each one changes, how to undo it and the common questions. The panel links to them with a "?" at the top right of the related screen.

- [First setup](first-setup.md) — from a fresh install to your first app.
- [Add a server](add-a-server.md) — the install command, and how to run it over SSH, a jump host or Tailscale, a provider console or cloud-init.
- [Connect GitHub](connect-github.md) — a GitHub App for private repositories and deploy on push.
- [Domains and Cloudflare](domains-and-cloudflare.md) — the panel's domain, app domains, one-click DNS and the Cloudflare settings that matter.
- [Move from Coolify](move-from-coolify.md) — to a new server, with a dry run, a freeze and a switch you can undo.
- [Move from Coolify on the same server](move-from-coolify-same-server.md) — swap the proxy in place.
- [Move off Coolify](move-off-coolify.md) — the whole move in four steps: take over in place, clean up, consolidate projects, shut Coolify down.

## Getting started

- [Install](install.md) — prerequisites, the one-line installer, and a production TLS setup.
- [Testing the beta](beta-testing.md) — a ten-minute first pass, what to try, known limitations, and how to report a bug with logs.
- [Upgrade](upgrade.md) — in-app updates, manual upgrades, and how the signed update flow works.
- [Email](email.md) — optional SMTP for password reset, verification and invites (Resend/any SMTP) and what happens without it.
- [Disaster recovery](disaster-recovery.md) — backing up + restoring the Tugra hub's own state (control plane).

## Using Tugra

- [CLI](cli.md) — the `tugra` command-line client (full reference in the [package README](../packages/cli/README.md)).
- [API](api.md) — the REST API, interactive docs, authentication and scopes.
- [Out-of-band cloud access](runbooks/out-of-band-cloud.md) — power, rescue and console for cloud-linked servers, straight from the provider, with the agent offline.
- [Log drains](log-drains.md) — ship container logs to HTTP, Loki, Datadog, syslog, GELF or fluentd, per server or per app; filters, egress policy, delivery status and guarantees.
- [Traffic Analytics geo](traffic-analytics.md) — built-in country geolocation (DB-IP Lite), optional city database, and how to refresh it.
- [Importing from Uptime Kuma](uptime-kuma-import.md) — bring monitors and alert links over from a Kuma backup file or straight from its database; preview first.
- [Migrating from Coolify](coolify-migration.md) — the full reference (start with [Move from Coolify](move-from-coolify.md)): one-command database-data migration (Postgres/MySQL/MariaDB/Redis/KeyDB/Dragonfly) plus the manual runbook for apps, volumes and the other engines.

## Understanding Tugra

- [Architecture](architecture.md) — how the hub, web, agent and data plane fit together.
- [Open-core & editions](open-core.md) — the licensing model and the Community/Pro/Cloud boundary.
- [Security](security.md) — the security model and where to report a vulnerability.

## Operating & contributing

- [Smoke test](smoke-test.md) — an end-to-end check of backup/restore, deploy and MCP against a real server.
- [Releasing](RELEASING.md) — cutting a signed release (maintainers).
- [Contributing](../CONTRIBUTING.md) · [Code of conduct](../CODE_OF_CONDUCT.md) · [CLA](../CLA.md)
- [Security policy](../SECURITY.md) · [License](../LICENSE)
