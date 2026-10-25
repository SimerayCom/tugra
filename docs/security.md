# Security

An overview of Tugra's security model, with links to the authoritative details. To **report a
vulnerability**, see the [security policy](../SECURITY.md) — please don't open a public issue.

## Security model

- **Signed agent protocol.** The agent dials out to the hub over WSS (no inbound ports); the hub signs
  every command with an ed25519 key that the agent pins, and rejects anything unsigned. Each server is
  granted a capability set the agent enforces fail-closed. See [architecture](architecture.md).
- **Fail-closed secrets.** `HUB_SIGNING_KEY` is required in production (the hub won't boot without it
  outside dev/test). Stored secrets (env vars, credentials, DB connection strings) are encrypted at rest
  with `SECRETS_ENCRYPTION_KEY`.
- **API access control.** Personal access tokens are scoped; secret values are gated behind `read:secrets`.
  The instance owner can disable PAT access entirely (`apiEnabled`) or restrict it to an IP allowlist
  (`apiAllowedIps`). Details in the [API docs](api.md).
- **Two-factor auth & sessions.** TOTP 2FA with recovery codes; httpOnly session cookies with CSRF
  protection; `COOKIE_SECURE` + `HUB_TRUSTED_PROXY` for correct handling behind a TLS reverse proxy.
- **SSRF protection.** Outbound targets (notifications, registries, git sources, monitors, update checks)
  block private/loopback/link-local addresses by default; LAN targets require an explicit opt-in
  (`NOTIFY_ALLOW_PRIVATE_TARGETS`).
- **Registration gating.** After the first owner is created, sign-ups are closed unless the owner enables
  them or issues an invite.

## Outbound connections

Every connection a Tugra hub can make, with its default state and off-switch. Nothing here carries app
secrets, server names, IPs or personal data unless noted.

| Connection | Default | Off-switch / opt-in | Where in code |
| --- | --- | --- | --- |
| Agent ↔ hub (WSS, signed commands) | On (core function) | n/a — the product | `agent-gateway/`, `scripts/agent-bootstrap` |
| **Anonymous usage stats** → `TUGRA_TELEMETRY_URL` (default `telemetry.tugra.io`) | **On (opt-out)** | `TUGRA_TELEMETRY=0` / `install.sh --no-telemetry` / Settings toggle | `telemetry/telemetry.service.ts` |
| Signed update-manifest check | **Off** — opt-in; when enabled, a scheduled daily fetch (not click-only) | `UPDATE_MANIFEST_URL` + `--enable-update-checks`; interval `UPDATE_CHECK_INTERVAL_MIN` | `update/update-check.scheduler.service.ts` |
| ACME / Let's Encrypt (issue TLS certs) | Only when you enable SSL for a domain | per-app/domain | `dns/`, `deploy/` |
| Remote template catalog | Off — opt-in, signature-verified | `CATALOG_SOURCE_URL` + `CATALOG_PUBLISHER_KEY` | `catalog/` |
| AI deploy-log analysis → Anthropic | Off — opt-in | `ANTHROPIC_API_KEY` | `deploy/` |
| Notifications / registries / git / monitors | Only what you configure; SSRF-guarded | per-resource; `NOTIFY_ALLOW_PRIVATE_TARGETS` for LAN | `notifications/`, `registries/`, `git-sources/`, `monitors/` |

The telemetry payload is exactly: a random, stable instance id; the hub version, channel, edition and
OS/arch; and aggregate counts (servers, apps, databases, deploys, teams, users, clusters, monitors,
containers). No IP, hostname, domain, email, app or server name is included, and the receiver does not
store the sender's IP. The owner can preview the exact payload, send on demand, rotate the id, or opt out
in **Settings → Anonymous usage stats**.

## Self-update security

The one-click / auto self-update runs through a deliberately minimal `tugra-updater` sidecar with a fixed
command set; the hub verifies the release manifest's ed25519 signature and refuses downgrades/channel-skips
before queueing anything. The sidecar's docker-socket surface is documented in
[SECURITY.md](../SECURITY.md); the publisher/signing side (how the signed manifest is produced) is in
[Releasing](RELEASING.md).

## One-click migrator security

The [one-click Coolify data migrator](coolify-migration.md) treats the source host as **untrusted**. It is
authenticated by a **one-time token** (256-bit, 1-hour TTL, SHA-256-hashed at rest, scoped to a single
import operation, revoked on cancel/rollback). The token rides the shell environment and a bare
`-e TUGRA_MIGRATION_TOKEN` — **never a command-line argument** — and every migration destination is resolved
server-side from the operation, so the host never names a target. The migrator itself runs as a **one-shot
`--cap-drop ALL --read-only` container** with no inbound ports and the Docker socket as its only mount;
database passwords are read locally and used only inside the source container, so **no credential reaches the
hub**. The hub independently computes each artifact's sha256 + size, re-authorizes the actor on every request,
and serves the staged dump to the target agent only over a signed, sha256-bound, short-lived URL on a trusted
origin. The honest caveats (a `curl | sh` bootstrap, a root-equivalent socket mount on the source host) are
spelled out in the [migration runbook](coolify-migration.md#security-model).

## Editions & licensing boundary

The proprietary Pro/Cloud layer lives outside this repository; the edition is a build-time signal, not a
runtime toggle. See [Open-core & editions](open-core.md).

## Supported versions

Tugra is in early development — only the latest `main` receives security fixes. See the
[security policy](../SECURITY.md) for the current support statement.
