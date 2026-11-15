# Security

An overview of Tugra's security model, with links to the authoritative details. To **report a
vulnerability**, see the [security policy](../SECURITY.md) — please don't open a public issue.

## Security model

- **Signed agent protocol.** The agent dials out to the hub over WSS (no inbound ports); the hub signs
  every command with an ed25519 key that the agent pins, and rejects anything unsigned. Each server is
  granted a capability set the agent enforces fail-closed. See [architecture](architecture.md).
- **Fail-closed secrets.** `HUB_SIGNING_KEY` is required in production (the hub won't boot without it
  outside dev/test). Stored secrets (env vars, credentials, DB connection strings) are encrypted at rest
  with `SECRETS_ENCRYPTION_KEY`; the key can be rotated without downtime (see
  [Rotating the secrets key](#rotating-the-secrets-key)).
- **API access control.** Personal access tokens are scoped; secret values are gated behind `read:secrets`.
  The instance owner can disable PAT access entirely (`apiEnabled`) or restrict it to an IP allowlist
  (`apiAllowedIps`). Details in the [API docs](api.md).
- **Source IP trust (`HUB_TRUSTED_PROXY`).** Off by default: the raw TCP peer is the source IP and cannot be
  forged. With `HUB_TRUSTED_PROXY=true` the hub reads the rightmost `X-Forwarded-For` entry **only when the TCP peer
  is a loopback / private (RFC1918, Docker bridge, CGNAT, ULA) address**, so a direct hit from the public internet
  on a raw published port cannot forge its own IP past the PAT allowlist, throttling or the observed server IP. A
  reverse proxy with a **public** egress IP (a proxy on another host) must be listed in `HUB_TRUSTED_PROXY_CIDRS`
  (comma-separated IPs/CIDRs; `0.0.0.0/0,::/0` trusts any peer — only when the proxy alone can reach the port).
  This is defense in depth next to the loopback bind the installer applies. By default private peers stay trusted,
  so a host on the same LAN/VPN that reaches the raw hub port could forge its source IP; set
  `HUB_TRUSTED_PROXY_STRICT=true` to trust **only** the `HUB_TRUSTED_PROXY_CIDRS` peers (list your proxy's subnet,
  e.g. from `docker network inspect <panel network>`; the hub refuses to boot in strict mode without
  `HUB_TRUSTED_PROXY=true` and at least one valid CIDR, and a wrong CIDR collapses observed IPs to the proxy
  address). The rightmost `X-Forwarded-For` entry must be a valid IP (a port suffix or IPv6 brackets are parsed);
  a malformed one is treated as no source IP, so it is denied by the API allowlist rather than recorded. Whether the
  web container's Next rewrites append the browser IP to `X-Forwarded-For` is not verified yet. Not yet handled: Cloudflare's orange-cloud proxy in front
  of the bundled Traefik (Traefik sees a Cloudflare edge address); allowlists are not meaningful in that mode.
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

## Rotating the secrets key

Stored secrets are encrypted with **data keys**: random keys the hub generates and keeps in Postgres, each one
wrapped (encrypted) under your `SECRETS_ENCRYPTION_KEY`. Every ciphertext records the id of the key it was
written with, so the hub can hold several keys at once, read old values through their old keys and write new
values under the new one while it keeps running. A database dump on its own holds no usable key: without the
`.env` passphrase the wrapped data keys open nothing.

### Rotate the data key (no restart, no `.env` change)

1. Settings → Instance → Security → **Secrets encryption key** → **Rotate key**. Leave **Re-encrypt everything
   now** ticked.
2. The hub makes a new random key active immediately. New writes use it; every old value stays readable.
3. The re-encrypt job rewrites each stored secret under the new key (resumable; **Re-encrypt now** runs it
   again if it was interrupted). The **Keys** list shows how many secrets each key still protects.
4. Once a replaced key protects nothing (and a minute has passed so every process has switched), **Retire** it.
   A retired key is unloaded but its wrapped copy stays in the database, so **Restore** brings it back if you
   find an old value that still needs it.

A fresh install has no data keys: the hub behaves exactly as before, with `SECRETS_ENCRYPTION_KEY` as the
encryption key, until an owner first clicks **Rotate key**.

Rotating the data key does **not** rotate `SECRETS_ENCRYPTION_KEY`. That passphrase stays the root of trust: it
unwraps the data keys at boot, signs the hub-backup `.gpg` passphrase, and is the only thing that opens a
restored database dump. Two-factor recovery codes, hub-backup `.gpg` files, file-transfer and migration-import
signatures are tied to the `.env` key and are unaffected by a data-key rotation.

**Rolling back to an older Tugra release.** After the first rotation, a release that predates the key ring
cannot read values stored under a data key. Before downgrading (or running `update.sh` recovery across such a
version), click **Back to .env key** on the same card and wait for the re-encrypt to finish; the card then shows
every secret is under the `.env` key and the downgrade is safe.

### Rotate the `.env` passphrase (root key)

Changing the root passphrase itself is still a manual, restart-based flow:

1. Generate a new passphrase (e.g. `openssl rand -base64 24`).
2. In the repo-root `.env`: move the old value to `SECRETS_ENCRYPTION_KEY_PREVIOUS` and put the new one in
   `SECRETS_ENCRYPTION_KEY`. Several previous keys may be listed, comma-separated.
3. Restart the hub (`docker compose --env-file .env -f deploy/docker-compose.yml up -d hub-api`). It boots,
   reads old secrets through the previous key and writes new ones with the current key. **If you use rotated
   data keys, the hub re-wraps them under the new passphrase automatically at boot**, so no data-key row needs
   re-encrypting.
4. Settings → Instance → Security → **Secrets encryption key** → **Re-encrypt now** moves any value that was
   written directly under the old `.env` key. The card shows how many values are still on an old key, per table.
5. When the card says every secret is under the current key, remove `SECRETS_ENCRYPTION_KEY_PREVIOUS` and
   restart once more. Keep the old passphrase in your password manager until every backup taken **before** the
   rotation is obsolete: restoring a pre-rotation backup (Postgres dump, volume bundle or in-app `.gpg`) under
   the current `.env` needs the old passphrase back in `SECRETS_ENCRYPTION_KEY_PREVIOUS`, otherwise its secrets
   are reported unreadable. In-app `.gpg` backups also derive their gpg passphrase from the key that was current
   when they were taken (see [disaster recovery](disaster-recovery.md)). A data key that you retired **before**
   changing the passphrase is wrapped under the old passphrase only: **Restore** reports `no_root` until the
   old passphrase is back in `SECRETS_ENCRYPTION_KEY_PREVIOUS`.

Three different keys protect backups; do not confuse them:

| Key | What it is | Protects | Where it lives |
|---|---|---|---|
| Master key (`SECRETS_ENCRYPTION_KEY`) | Your `.env` passphrase | Every secret stored in Postgres, including the destination data keys below | `.env` (you) |
| Destination data key | Random 256-bit key generated when an encrypted backup destination is created (on by default) | The database and volume backups written to that destination (gpg AES-256) | Postgres, encrypted under the master key; shown once at creation; exportable by the instance owner |
| Hub backup key | `HMAC-SHA256(SECRETS_ENCRYPTION_KEY, "tugra-hub-backup-v1")`, derived on demand | The in-app control-plane (hub) backup | Never stored; recomputed from `.env` |

The hub backup contains the destination rows, so the chain is `.env -> hub dump -> destination rows -> destination
keys -> S3 objects`. Losing the `.env` loses all of it, so keep it offsite (see [disaster recovery](disaster-recovery.md)).
The gpg passphrase is passed on the command line of the backup process on the backup host (visible to other root
processes there); that is unchanged.

Notes:
- Two-factor **recovery codes** are stored as keyed hashes and cannot be rewritten (the code itself is never
  stored). They keep working while the previous key is configured; users should regenerate them before it is
  removed — the card tells you how many were issued before the rotation.
- A secret written with a key that is no longer configured is reported as **unreadable** (never silently
  dropped): add that key back to `SECRETS_ENCRYPTION_KEY_PREVIOUS` and re-encrypt, or re-enter the value.
- The importer's one-time migration tokens and in-flight imports are derived from the current key: finish or
  restart an import across a rotation.

