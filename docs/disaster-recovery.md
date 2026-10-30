# Disaster recovery & moving the hub

Tugra backs up your **apps and databases** (scheduled backups, offsite S3, volume backups). This page is
about the **control plane itself** — the Tugra hub's own state: how to move it to a new host, and how to
keep a recovery copy if the host running the hub dies.

## What's at risk

The hub stores everything in one Docker volume plus the repo-root `.env`:

| What | Contents | Loss impact |
|---|---|---|
| Postgres volume (`tugra_pg`) | Users, teams, projects, servers, apps, deploy history, backup metadata, GitHub App connections, **encrypted** secrets/env/tokens | **Critical** — losing it loses your whole fleet's configuration |
| Redis volume (`tugra_redis`) | Job queues, live-metric cache, rate-limit counters | Rebuildable — schedules re-register on boot; safe to lose |
| `.env` (repo root) | `SECRETS_ENCRYPTION_KEY`, `POSTGRES_PASSWORD`, `HUB_SIGNING_KEY`, JWT secrets | **Critical** — the Postgres data is unusable without it (see below) |

> ⚠️ **The `.env` is part of your backup.** Secrets in Postgres are encrypted with `SECRETS_ENCRYPTION_KEY`,
> and a copied Postgres data dir still expects the original `POSTGRES_PASSWORD` — **the database is unusable
> without the same `.env`.** (`HUB_SIGNING_KEY` keeps the agent command-signing identity stable; agents pin
> the hub key per connection, so a changed one is re-pinned, not fatal, but keep it to avoid churn.) Store
> `.env` offsite and encrypted alongside every backup.

> The Docker **project name is `tugra`**, so the real volume names are `tugra_tugra_pg` / `tugra_tugra_redis`
> (the names above are the compose keys). The tooling below resolves them for you.

## Move to a new host — one command, no pg_dump

`scripts/hub-migrate.sh` packs the hub's whole state (Postgres volume + `.env` + `/etc/tugra`) into one
bundle and restores it on a fresh host. Everything — servers, apps, env, **GitHub App connections**, deploy
history — comes across and the hub continues exactly where it left off.

**On the OLD host** (from the install dir):

```sh
scripts/hub-migrate.sh pack --encrypt
# → writes tugra-hub-<date>.tar.enc (0600). Briefly stops the stack for a consistent copy, then restarts.
# (use --no-restart for a real move, to leave the old hub down and avoid two hubs commanding the same agents.)
```

Copy the bundle to the new host over a secure channel.

**On the NEW host** (install Tugra from the same release first so the compose file + images are present):

```sh
scripts/install.sh --restore-from tugra-hub-<date>.tar.enc
#   …or, on an already-installed checkout:
scripts/hub-migrate.sh unpack tugra-hub-<date>.tar.enc
```

It validates the bundle (architecture, Postgres major, per-part checksums) **before touching anything**, backs
up the old `.env`, restores the `.env` + Postgres volume, then boots Postgres and **verifies the credentials
over a password-authenticated connection** (and that the data is non-empty) before starting the rest. It ends
with a cutover checklist. The hub runs `prisma migrate deploy` on boot, so a bundle from an older schema
migrates forward automatically.

**After restore — cutover:**

1. Point your hub's DNS / `HUB_PUBLIC_URL` at the new host. If the hostname is unchanged, agents on your
   other servers reconnect on their own within ~30s (they dial out to the hub; nothing to do per server).
2. If the hostname/IP **changed**, re-run `scripts/install.sh --domain <new-host>` on the new host
   (idempotent — it keeps your secrets and rewrites the URLs), then re-run the agent install one-liner on
   each server and update your GitHub App's webhook/callback URL in GitHub.
3. If the old host served the panel over HTTPS (`PANEL_TLS=1`), re-run `scripts/install.sh` (no args) on the
   new host to re-provision the bundled TLS proxy — it is a standalone container, not part of the move.

> **What the move does and does not carry.** It carries the whole **control plane** — every server, app,
> env value, GitHub App connection and deploy-history row. It does **not** carry app **containers or their
> volume data**: apps on your remote servers keep running and reconnect untouched, but any app on the hub's
> own "This machine" server must be moved with Tugra's per-app/volume backups or redeployed on the new host
> (`pack` warns you if any exist). The TLS proxy, host firewall and DNS are also not carried.

> **Constraints of the no-pg_dump path:** a raw Postgres data dir is only portable to the **same CPU
> architecture** and the **same Postgres major version** (both ends share the pinned `postgres:16-alpine`).
> `unpack` checks both and refuses a mismatch — use the dump path below instead if you are changing arch.
> Redis is excluded by default (rebuildable); add `--include-redis` to carry it.

## Keep a recovery copy (scheduled)

**In-app (recommended):** Settings → Instance → **Control-plane backup** schedules a dump of Tugra's own
database to a destination (this server's disk, or an S3 bucket) and prunes to a retention count. It runs on
the local agent and is **always gpg-encrypted** with a key derived from `SECRETS_ENCRYPTION_KEY` — so the
dump is safe to ship to S3, but it **can only be decrypted with your `.env`** (keep it offsite). Restoring an
in-app backup: decrypt first (see below). The `.env` is deliberately never bundled.

Or do it yourself with a plain `pg_dump` (version/arch independent, smaller), from the install directory
without stopping Tugra:

```sh
docker compose --env-file .env -f deploy/docker-compose.yml exec -T postgres \
  pg_dump -U tugra -Fc tugra > "tugra-hub-$(date +%F).dump"
```

Automate with cron (daily, keep 14 days) and **copy each dump + your `.env` offsite** (S3/rsync/another host)
— a backup on the same dying disk is not a backup:

```cron
0 3 * * *  cd /opt/tugra && docker compose --env-file .env -f deploy/docker-compose.yml exec -T postgres pg_dump -U tugra -Fc tugra > /var/backups/tugra/hub-$(date +\%F).dump && find /var/backups/tugra -name 'hub-*.dump' -mtime +14 -delete
# then ship /var/backups/tugra + /opt/tugra/.env offsite (rclone/aws s3 sync/borg …)
```

## Restore from a dump (fresh host, or arch/version change)

1. Install Tugra normally (`scripts/install.sh`), then **replace the generated `.env` with your backed-up
   `.env`** (so `SECRETS_ENCRYPTION_KEY`, `HUB_SIGNING_KEY`, `POSTGRES_PASSWORD` match the dump).
2. Bring up only the database, then restore the dump into it:

   ```sh
   docker compose --env-file .env -f deploy/docker-compose.yml up -d postgres
   docker compose --env-file .env -f deploy/docker-compose.yml exec -T postgres \
     pg_restore -U tugra -d tugra --clean --if-exists < tugra-hub-YYYY-MM-DD.dump
   ```
3. Start the rest (`… up -d`). `prisma migrate deploy` runs on boot, so an older-schema dump is migrated
   forward automatically.
4. Cut over DNS / agents as in the move checklist above.

**Restoring an in-app (gpg-encrypted) backup.** The in-app backups are `tugra-hub-<ts>.dump.gz.gpg`. Decrypt
and decompress them into `pg_restore`, deriving the passphrase from the same `.env`:

```sh
PASS=$(printf %s tugra-hub-backup-v1 | openssl dgst -sha256 -hmac "$SECRETS_ENCRYPTION_KEY" | awk '{print $NF}')
gpg --batch --passphrase "$PASS" -d tugra-hub-<ts>.dump.gz.gpg | gunzip \
  | docker compose --env-file .env -f deploy/docker-compose.yml exec -T postgres \
      pg_restore -U tugra -d tugra --clean --if-exists
```

## Notes

- `tugra_redis` needs no restore — the schedulers re-register their repeatable jobs on boot.
- This protects the **control plane**. Your apps' own data is covered by Tugra's per-database and volume
  backups (see the app/database backup settings in the UI).
- A managed-Postgres deployment (external `DATABASE_URL`) shifts hub DR to your database provider's backups;
  the `.env` caveat still applies, and the volume-move path does not apply (there is no local `tugra_pg`).
