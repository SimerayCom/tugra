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
| Backup destination keys | The data key of every encrypted backup destination (stored in Postgres, encrypted under `SECRETS_ENCRYPTION_KEY`) | **Critical for offsite backups** — without the key an encrypted S3 backup cannot be read; see [Recovering destination keys](#recovering-destination-keys) |

> ⚠️ **The `.env` is part of your backup.** Secrets in Postgres are encrypted with data keys, and those data keys
> are stored in the same database **wrapped under `SECRETS_ENCRYPTION_KEY`**: a restored dump carries its
> wrapped data keys, so only the `.env` root is needed to open them (a dump on its own decrypts nothing). If
> you have rotated the `.env` passphrase, keep the previous one too — `SECRETS_ENCRYPTION_KEY_PREVIOUS` — until
> every backup taken under the old passphrase is obsolete: when restoring a pre-rotation backup under a
> post-rotation `.env`, put the old passphrase back in `SECRETS_ENCRYPTION_KEY_PREVIOUS` or restore the `.env`
> that was current at backup time; see [Rotating the secrets key](security.md#rotating-the-secrets-key). The
> pre-rotation-backup caveat now applies to the root passphrase only; rotating a data key in the panel never
> needs an old backup's key. A copied Postgres data dir still expects the original `POSTGRES_PASSWORD` — **the
> database is unusable without the same `.env`.** (`HUB_SIGNING_KEY` keeps the agent command-signing identity
> stable; agents pin the hub key per connection, so a changed one is re-pinned, not fatal, but keep it to avoid
> churn.) Store `.env` offsite and encrypted alongside every backup.

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
# While hub-api is still running it also exports destination-keys.json (plaintext backup keys, mode 600) into
# the bundle; if hub-api is down it warns and carries on (the keys are still in the Postgres volume). If some key
# cannot be decrypted the pack aborts before stopping anything, unless you pass --allow-incomplete-keys.
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
in-app backup: decrypt first (see below). The `.env` is deliberately never bundled. The schedule can be an
interval or a cron (at most hourly), and old dumps are pruned by count, age (`retentionDays`) and total size
(`maxSizeGb`, newest always kept). The dump contains your destination rows, whose data keys are protected by the same
`.env` key, so that key unlocks `.env -> hub dump -> destination keys -> S3 objects`.

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

### Restoring a pre-update snapshot

Every update (the in-app **Update now** and `git pull && ./scripts/install.sh` on a running stack) first writes
`backups/pre-update-<from>-to-<to>-<UTC>.dump` and a matching `.env` copy (see [Upgrade](upgrade.md)). An update that also replaced
the compose file or scripts keeps the previous copies in `backups/host-files-<from>-to-<to>-<UTC>/` (restored automatically when
the update fails). To go back:

1. Stop the app containers and put the **old `TUGRA_VERSION`** (the `<from>` in the file name) back in `.env`; the
   `.env` copy next to the dump is the pre-update file if you need its other values.
2. `docker compose --env-file .env -f deploy/docker-compose.yml stop hub-api web agent`
3. Restore the database, then start the stack on the old images:

   ```sh
   docker compose --env-file .env -f deploy/docker-compose.yml exec -T postgres \
     pg_restore -U tugra -d tugra --clean --if-exists < backups/pre-update-<from>-to-<to>-<stamp>.dump
   docker compose --env-file .env -f deploy/docker-compose.yml up -d
   ```

**Restoring an in-app (gpg-encrypted) backup.** The in-app backups are `tugra-hub-<ts>.dump.gz.gpg`. Decrypt
and decompress them into `pg_restore`, deriving the passphrase from the same `.env`:

```sh
PASS=$(printf %s tugra-hub-backup-v1 | openssl dgst -sha256 -hmac "$SECRETS_ENCRYPTION_KEY" | awk '{print $NF}')
gpg --batch --passphrase "$PASS" -d tugra-hub-<ts>.dump.gz.gpg | gunzip \
  | docker compose --env-file .env -f deploy/docker-compose.yml exec -T postgres \
      pg_restore -U tugra -d tugra --clean --if-exists
```

## Recovering destination keys

Encrypted backup destinations are the default for new destinations. Each has its own random data key, shown once
when the destination is created ("save this key" dialog, or the `recoveryKey` field of the create response). You
have three ways to get a key back later:

1. **Sealed export (instance owner).** Settings → Instance → Control-plane backup → **Export encryption keys**
   asks for a passphrase (12+ characters) and downloads `tugra-destination-keys-<date>.enc`. It holds every
   encrypted destination's key and the hub-backup passphrase, but no S3 credentials. Open it with:

   ```sh
   openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -in tugra-destination-keys-<date>.enc | jq
   ```

2. **The migration bundle.** `scripts/hub-migrate.sh pack` includes `destination-keys.json` (mode 600) when hub-api
   is running; `unpack` puts it next to the restored `.env` (delete it after verifying a restore).
3. **From the database.** The keys are in Postgres, encrypted under `SECRETS_ENCRYPTION_KEY`; on a running hub run
   `docker compose --env-file .env -f deploy/docker-compose.yml exec -T hub-api node dist/scripts/export-destination-keys.js`.

Treat all of these like the `.env`. To decrypt a backup by hand with a key (`$KEY`):

```sh
# S3 object (MinIO client)
mc cat <alias>/<bucket>/<prefix>/<id>/<file>.gpg | gpg --batch --passphrase "$KEY" -d | gunzip > restored.dump
# local file
gpg --batch --passphrase "$KEY" -d /etc/tugra/backups/<id>/<file>.gpg | gunzip > restored.dump
```

Deleting an encrypted destination destroys its key, so Tugra refuses (409) while it still has successful backups
unless you pass `?discardBackups=true`. The "server disk" default (no destination) is not encrypted.

## Notes

- `tugra_redis` needs no restore — the schedulers re-register their repeatable jobs on boot.
- This protects the **control plane**. Your apps' own data is covered by Tugra's per-database and volume
  backups (see the app/database backup settings in the UI). Volume backups are **file-level copies of the
  running volume** (not point-in-time snapshots); for a database prefer its per-database backup, which is
  transaction-consistent.
- A managed-Postgres deployment (external `DATABASE_URL`) shifts hub DR to your database provider's backups;
  the `.env` caveat still applies, and the volume-move path does not apply (there is no local `tugra_pg`).
