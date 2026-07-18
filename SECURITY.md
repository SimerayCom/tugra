# Security Policy

## Reporting a vulnerability

**Please do not open public issues for security problems.**

If you find a vulnerability, email **security@tugra.io** with:

- a description of the issue and its impact,
- steps to reproduce or a proof of concept,
- any relevant logs, versions, or configuration.

You'll get an acknowledgement as soon as possible. Please give us a reasonable
window to investigate and ship a fix before any public disclosure. We're happy to
credit reporters who want to be named.

## Supported versions

Tugra is in early development. Until a stable release, only the latest `main` is
supported for security fixes.

## Self-update sidecar (`tugra-updater`)

The one-click / auto self-update is applied by a small **`tugra-updater`** sidecar (in
`deploy/docker-compose.yml`) because the hub can't recreate its own container. It mounts the host
Docker socket — a root-equivalent surface — so it is deliberately minimal:

- It runs **only** `scripts/update.sh`, whose command set is fixed: `docker compose pull` + `up -d
  --no-deps hub-api web`. There is **no arbitrary exec** path.
- It reaches Redis only on the internal compose network (no external port).
- The hub verifies the release manifest's **ed25519 signature** before queueing any update, refuses any
  **downgrade** and any **channel-skip**, and auto-update applies **patch releases only** (a minor/major
  always waits for an explicit owner click). The sidecar re-checks "strictly newer" as defense-in-depth.

