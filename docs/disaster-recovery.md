# Disaster recovery — backing up the Tugra control plane

Tugra backs up your **apps and databases** (scheduled backups, offsite S3, volume backups). This page is
about the **control plane itself** — the Tugra hub's own state. If the host running the hub dies, this is
what you need to have copied elsewhere to bring Tugra back.

## What's at risk

The hub stores everything in two Docker volumes (see `deploy/docker-compose.yml`):

| Volume | Contents | Loss impact |
|---|---|---|
| `tugra_pg` (Postgres) | Users, teams, projects, servers, apps, deploy history, backup metadata, **encrypted** secrets/env/tokens | **Critical** — losing it loses your whole fleet's configuration |
| `tugra_redis` (Redis) | Job queues, live-metric cache, rate-limit counters | Rebuildable — schedules re-register on boot; safe to lose |

So control-plane DR = **back up `tugra_pg` + keep your `.env` safe.**

> ⚠️ **The `.env` is part of your backup.** Secrets in `tugra_pg` are encrypted with `SECRETS_ENCRYPTION_KEY`,
> and the agent command-signing identity is `HUB_SIGNING_KEY` — both live in the repo-root `.env`. A Postgres
> dump **cannot be used without the same `.env`**: restore it and you'll have rows you can't decrypt and
> agents that reject the hub. Store `.env` (offsite, encrypted) alongside every dump.

## Back up (scheduled)

Dump the hub Postgres without stopping Tugra. Run this from the install directory (where `.env` lives):

```sh
docker compose --env-file .env -f deploy/docker-compose.yml exec -T postgres \
  pg_dump -U tugra -Fc tugra > "tugra-hub-$(date +%F).dump"
```

Automate it with cron (daily, keep 14 days) and **copy each dump + your `.env` offsite** (S3/rsync/another
host) — a backup on the same dying disk is not a backup:

```cron
0 3 * * *  cd /opt/tugra && docker compose --env-file .env -f deploy/docker-compose.yml exec -T postgres pg_dump -U tugra -Fc tugra > /var/backups/tugra/hub-$(date +\%F).dump && find /var/backups/tugra -name 'hub-*.dump' -mtime +14 -delete
# then ship /var/backups/tugra + /opt/tugra/.env offsite (rclone/aws s3 sync/borg …)
```

## Restore (on a fresh host)

1. Install Tugra normally (`scripts/install.sh`), then **replace the generated `.env` with your backed-up
   `.env`** (so `SECRETS_ENCRYPTION_KEY`, `HUB_SIGNING_KEY`, `POSTGRES_PASSWORD` match the dump).
2. Bring up only the database, then restore the dump into it:

   ```sh
   docker compose --env-file .env -f deploy/docker-compose.yml up -d postgres
   docker compose --env-file .env -f deploy/docker-compose.yml exec -T postgres \
     pg_restore -U tugra -d tugra --clean --if-exists < tugra-hub-YYYY-MM-DD.dump
   ```
3. Start the rest (`… up -d`). The hub runs `prisma migrate deploy` on boot, so a dump from an older schema
   is migrated forward automatically.
4. Agents reconnect on their own (they dial back to the hub); because `HUB_SIGNING_KEY` matches, their
   trust is intact. If you changed the hub's public URL, re-point agents accordingly.

## Notes

- `tugra_redis` needs no restore — the schedulers re-register their repeatable jobs on boot.
- This protects the **control plane**. Your apps' own data is covered by Tugra's per-database and volume
  backups (see the app/database backup settings in the UI).
- A managed-Postgres deployment (external `DATABASE_URL`) shifts hub DR to your database provider's
  backups; the `.env` caveat still applies.
