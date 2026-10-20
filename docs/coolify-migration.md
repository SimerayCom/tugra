# Migrating from Coolify to Tugra (manual)

This is the **manual** path that works today: you recreate each app on Tugra and move each database with a
dump-and-restore. A one-click "import your Coolify fleet" flow is on the roadmap; this runbook lets you move
real workloads now, safely.

> **Golden rule:** Tugra never touches your Coolify install. Keep Coolify running until you have verified the
> Tugra copy and switched DNS. Rollback is "point DNS back at Coolify" — **but only works cleanly if you did
> the cutover window below**, because once Tugra starts taking writes, the two databases diverge.

## What this covers / does not

- **Covers:** recreating apps (Git repo or container image), their env vars and domains, and moving
  **Postgres, MySQL, MariaDB and MongoDB** databases by logical dump + restore.
- **You do by hand:** app **volume** data (no volume-copy tool yet — use `rsync`/`tar`), and the app's
  `DATABASE_URL` rewrite (Tugra generates its own DB credentials).
- **Fiddly / verify carefully:** Redis & KeyDB (see their note).
- **Not covered by this manual runbook yet:** Dragonfly, ClickHouse, LibSQL; adopting Coolify's running
  (compose-managed) containers in place; Bitbucket sources; Caddy/Nginx custom proxy; per-DB SSL/init-scripts.

## Before you start

1. **Run Tugra on a fresh server** if you can. Coolify's proxy owns ports 80/443 on its host; same-box means
   a port conflict — use a separate server, or stop Coolify's proxy only at the final cutover.
2. Enrol that server in Tugra (install the agent).
3. Create a **personal access token with the `write`, `deploy` and `read:secrets` scopes** (or just `admin`).
   You need `write` to create apps/DBs and edit env, `deploy` to provision/import/set-domains, and
   `read:secrets` to read the new connection string. A `deploy`-only token gets **403** on create.
4. Have your Coolify host SSH access ready (for the dumps). Examples use the CLI passthrough:
   `tugra api <METHOD> <path> --data '<json>'`.

## ⚠️ The `gzip` flag (read this once)

`import-from-url` has `gzip: true` **by default**. A **raw** (non-gzipped) dump file must be imported with
`"gzip": false`, or the import fails with "not in gzip format". Only set `"gzip": true` when the file really
is gzipped (ends in `.gz`). Every example below is explicit about it.

## Move a database

Do databases **before** the apps that use them. **The dump you actually cut over with must be taken while the
source is quiesced** (see the cutover window) — any earlier dump is a rehearsal only, because writes that land
after a dump are lost at cutover.

### 1. Dump it on the Coolify host

The Coolify DB container is named by its resource UUID.

| Engine | Dump command (on the Coolify host) | Import flags |
|---|---|---|
| **Postgres** | `docker exec <uuid> pg_dump -Fc --no-owner --no-acl -U <user> <db> > db.dmp` | `"pgFormat":"custom","gzip":false` |
| **MySQL / MariaDB** | `docker exec <uuid> mysqldump --single-transaction --quick --no-tablespaces -u <user> -p<pass> <db> > db.sql` | `"gzip":false` |
| **MongoDB** | `docker exec <uuid> mongodump --archive -u <user> -p <pass> --authenticationDatabase admin > db.archive` | `"gzip":false` |

Notes:

- **Postgres:** Coolify's own `pg-dump-<db>-*.dmp` backups are already `-Fc` custom format → use them directly
  with `"pgFormat":"custom"`. Its `pg-dump-all-*.gz` (pg_dumpall) are **plain SQL, gzipped** →
  `"pgFormat":"sql","gzip":true`.
- **MySQL/MariaDB:** Coolify names these `.dmp` too, but they are **plain SQL** → no `pgFormat`, `"gzip":false`.
- **MongoDB:** dump **uncompressed** (`--archive`, no `--gzip`) — Tugra restores with `mongorestore --archive
  --drop` and cannot read `--gzip` archives, so Coolify's `*.tar.gz` Mongo backups are **not** importable as
  is. Restore uses the DB names inside the archive; name the Tugra database so its slug equals the source DB
  name (see step 3), or your data lands in a differently-named DB than the app connects to.

### 2. Put the dump at an HTTPS URL

Tugra imports from a URL. Use Coolify's **S3** backup object's pre-signed GET URL if you have one, or serve
the dump over a short-lived HTTPS URL (S3 pre-signed GET, or a temporary file server). Delete it afterward.

### 3. Create the matching DB on Tugra and provision it

Same engine and **same major version** as Coolify's — do not restore a v15 dump into a v13. Tugra generates
its own `username` (`tugra`), password and database name (`slug(<name>)`), so **name the DB so that its slug
matches the source database name** where that matters (MongoDB especially).

```bash
tugra api POST /databases --data '{"name":"mydb","serverId":"<srv>","engine":"POSTGRES","version":"16"}'
tugra api POST /databases/<id>/provision        # starts it empty
```

### 4. Import the dump (overwrites the empty target)

The import **overwrites** the target (`pg_restore --clean`, `mongorestore --drop`, etc.), so **only ever
import into the fresh, just-provisioned DB** — never an existing one.

```bash
# Postgres custom-format dump, not gzipped:
tugra api POST /databases/<id>/backups/import-from-url \
  --data '{"url":"https://.../db.dmp","gzip":false,"pgFormat":"custom"}'

# MySQL/MariaDB plain-SQL dump, not gzipped:
tugra api POST /databases/<id>/backups/import-from-url \
  --data '{"url":"https://.../db.sql","gzip":false}'
```

**Redis / KeyDB:** `BGSAVE` on the source, copy its `dump.rdb`, import with `"gzip":false`, then confirm
with `DBSIZE`.

### 5. Verify before you trust it

Compare row/collection counts to the source (`SELECT count(*)` on key tables, `DBSIZE` for Redis,
`db.coll.countDocuments()` for Mongo). Do not cut over until they match.

## Move an app

1. **Recreate it on Tugra** from the same Git repo (Nixpacks / Dockerfile / static) or container image, and
   create it **stopped**.
2. **Copy its env vars** from Coolify. Rewrite `DATABASE_URL` (and friends) to the Tugra DB — its host and the
   **new** credentials Tugra generated (user is always `tugra`, DB name is `slug(<name>)`, so it's a full
   rewrite, not a host swap):

   ```bash
   tugra api GET /databases/<id>    # connectionUri / host / username / password
   ```

   If `connectionUri`/`password` come back `null`, your token is missing `read:secrets`.
3. **App volumes:** copy by hand while the app is stopped on both sides (`docker run --rm -v <vol>:/data alpine
   tar czf - -C /data .` on the source, untar into the Tugra volume).
4. **Deploy** on Tugra and smoke-test on its temporary `*.sslip.io` URL before touching DNS.

## The cutover window (do not skip — this is where data is lost otherwise)

Everything above can be rehearsed with the source live. The real cutover must be a short planned window so no
writes are lost:

1. Lower the domain's DNS TTL a day ahead.
2. **Quiesce the source:** put the Coolify app in maintenance mode or stop it (at minimum stop its workers /
   writers) so its database takes no more writes.
3. Take the **final** dump now (step 1 above), import into the fresh Tugra DB, and verify counts.
4. Point DNS at Tugra:

   ```bash
   tugra apps domain <appId> <your-domain> --dry-run      # preview the DNS plan
   tugra apps domain <appId> <your-domain> --overwrite     # apex A/AAAA + www; repoints records that
                                                            # currently point at Coolify; issues HTTPS
   ```

   This needs a Cloudflare DNS credential stored in Tugra (add `--credential <id>` if the team has more than
   one). For any other DNS provider, get the copy-paste records instead:
   `tugra api GET "/apps/<appId>/domain/manual-records?domain=<your-domain>"`.
5. Verify the domain resolves and serves correctly, then **keep the Coolify app stopped** (not just
   DNS-switched) so stale-DNS clients can't keep writing to the old database and diverge.

## Rollback & order

- **Rollback** (before Tugra has taken real writes): point DNS back and restart the Coolify app — its copy is
  untouched. **After** Tugra has taken writes, rolling back means dumping Tugra back to Coolify first, or you
  lose those writes.
- Stateless apps first, then small DBs, then large/critical DBs last. One app + its DB at a time; verify each.
- Keep Coolify around for at least a few clean days. Never delete anything on Coolify until the Tugra copy has
  served real traffic and backed up successfully.
