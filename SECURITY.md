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
  --no-deps hub-api web` (then the local agent, and — only when a release changed the compose file — a one-shot
  helper that recreates the updater service itself). There is **no arbitrary exec** path.
- When a release changes the compose file or the installer scripts, the sidecar replaces them only after verifying them
  **itself**: an ed25519 signature (the publisher key that signs the release manifest, over a version-bound list of
  per-file sha256 hashes whose own hash the signed manifest commits to), a strict path allowlist (the compose file and
  `scripts/**/*.sh`; never `.env`), `bash -n` / `docker compose config` validation, then a backup, atomic renames and an
  automatic rollback. File content never travels through the hub or Redis, so a compromised hub cannot inject it.
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

## Known dependency advisories

`pnpm audit --prod` currently lists two advisories that we have reviewed and are not reachable in Tugra:

- **zod 3.25.76, GHSA-mrhx-c7xc-m3w5** (high; patched only in zod 4.6.6+). All hub schemas use the zod v3 API; the
  vulnerable array validator lives in the bundled v4 core, which is never imported. Request bodies are size-capped
  and the endpoints are authenticated. Revisit with the zod v4 migration.
- **@nestjs/core 10.4.22, GHSA-36xv-jgw5-4q75** (moderate; patched only in 11.x). Every `@Sse` endpoint in hub-api
  emits only `{ data: JSON.stringify(event) }`, so the event `type` / `id` fields the advisory depends on are never
  set. Revisit with the NestJS 10 to 11 migration.

Dependabot's `scope: runtime` label is not authoritative for `pnpm-lock.yaml`: the hub image currently installs dev
dependencies too (no `--prod`), which is a separate hardening follow-up. Do not enable `jest --coverage` without
first overriding `test-exclude`, which is broken under glob 9 and later.
