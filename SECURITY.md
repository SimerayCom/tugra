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

## Control-panel proxy and TLS (`--domain`, Panel domain)

Tugra runs its own Traefik in front of the panel: without a domain it answers on `http://<server-ip>/` (port 80,
`PANEL_IP_ROUTE=1`), with `--domain` (or **Settings → Instance → Panel domain**) it serves HTTPS with a Let's
Encrypt certificate (HTTP-01 by default; a Cloudflare token for DNS-01 is optional). Its only added outbound call is
to Let's Encrypt for the operator's **own** domain — no phone-home. The hub and web attach to a dedicated
**`tugra-panel`** Docker network that Traefik routes over, separate from the app network: a deployed (untrusted) app
container can neither reach the hub directly (bypassing the API IP-allowlist / the one-hop trusted-proxy
`X-Forwarded-For`) nor shadow the panel's route, and Postgres/Redis never join it. The host-less http routes sit at
the lowest router priority, so a deployed app's own Host rule always wins over them. With the proxy in front, a
fresh install binds the raw hub/web ports to `127.0.0.1` and trusts exactly that one proxy hop.

Changing the domain from the panel is owner-only (session, never a PAT) and audit-logged. The hub never touches
its own container or the host: it configures the proxy through the local agent (the path a deploy uses), verifies the
certificate, and hands only the `.env` switch + recreate to the update sidecar over the update queue (a flat job with
a validated hostname/IP/email, a job id and a freshness check; the sidecar re-validates every field and applies a fixed
command set). Any failure restores the previous `.env` and drops the pending routes, so the old address keeps working.
`--no-auto-tls` keeps bring-your-own-proxy, which is also chosen when another service already holds :80/:443.

## Known dependency advisories

`pnpm audit --prod` currently reports no known advisories (zod 4 and NestJS 11 closed the two that were tracked here).

Dependabot's `scope: runtime` label is not authoritative for `pnpm-lock.yaml`: the hub image currently installs dev
dependencies too (no `--prod`), which is a separate hardening follow-up. Do not enable `jest --coverage` without
first overriding `test-exclude`, which is broken under glob 9 and later.
