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

The latest release and `main` receive security fixes; older releases should upgrade
to the latest.

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

## Control-panel TLS (`--auto-tls`)

Opt-in auto-HTTPS for the panel (`install.sh --auto-tls`) runs a bundled Traefik that gets a Let's Encrypt
certificate. Its only added outbound call is to Let's Encrypt for the operator's **own** domain — no
phone-home. The hub and web attach to a dedicated **`tugra-panel`** Docker network that Traefik routes over,
separate from the app network: a deployed (untrusted) app container can neither reach the hub directly
(bypassing the API IP-allowlist / the one-hop trusted-proxy `X-Forwarded-For`) nor shadow the panel's route,
and Postgres/Redis never join it. Panel TLS stays **off** unless the operator opts in; plain `--domain`
remains bring-your-own-proxy.
