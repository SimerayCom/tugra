# Migrating from Coolify to Tugra

Two paths, used **together**:

- **One-click data migrator** (first section) — moves the **database contents** of six engines
  (Postgres, MySQL, MariaDB, Redis, KeyDB, Dragonfly) from your Coolify host into the Tugra databases an
  import created, with **one pasted command** on the Coolify server. No SSH, no manual dump files.
- **Manual runbook** (second section) — recreate apps, move volume data, rewrite `DATABASE_URL`, cut over
  DNS, and move the databases the one-click path does not: **MongoDB** (guided dump-and-restore below),
  **ClickHouse** (a by-hand dump — no tool yet), **LibSQL** (a volume copy), DBs larger than the artifact
  cap, and sources whose password isn't in the container env (rotated / `*_FILE` / trust-auth).

> **Golden rule:** Tugra never changes your Coolify configuration and deletes nothing on it. The one-click
> migrator only *reads* source databases via `docker exec` dumps — though Redis/KeyDB `SAVE` does refresh the
> source container's own `dump.rdb`. Keep Coolify running until you have verified the Tugra copy and switched
> DNS. Rollback is "point DNS back at Coolify" — **but only works cleanly if you did the cutover window
> below**, because once Tugra starts taking writes, the two databases diverge.

## What moves how

| What | How |
|---|---|
| App definitions, env vars, domains | Coolify **import** (`connect → plan → apply`) — creates the apps and the **empty** destination DBs |
| **Postgres / MySQL / MariaDB / Redis / KeyDB / Dragonfly** data | **One-click data migrator** (below) |
| **MongoDB** data | **Manual** runbook (one-click deferred) |
| **ClickHouse** data | **Manual** dump by hand (no tool yet) |
| **LibSQL** data | **Manual** — it's a single SQLite file; copy the volume (`tar`/`rsync`) |
| App **volume** data | **Manual** — not moved by the one-click migrator; use `tar`/`rsync` (or export a tarball and the volume `import-from-url` endpoint) |
| `DATABASE_URL` rewrite, DNS cutover | **Manual** (the migrated DB gets **fresh** Tugra credentials) |

---

# One-click data migration

You mint a one-time token for a finished Coolify **import operation**, paste a single command on the
Coolify host, and Tugra discovers each source database container, dumps it, streams the dump to the hub,
and restores it into the matching Tugra database. It is a **point-in-time logical dump per database** — not
live replication — so the cutover discipline at the end of this page still applies.

### What it does, and what it does NOT do

- **Moves:** the data of Postgres, MySQL, MariaDB, Redis, KeyDB and Dragonfly databases.
- **Does not move:** app **volume** data, the app's `DATABASE_URL` (the Tugra DB gets new credentials — you
  rewrite it), DNS, or **MongoDB / ClickHouse / LibSQL** data. For all of those, use the manual runbook.
- **Dumps one database per container** (MySQL/MariaDB need `MYSQL_DATABASE`/`MARIADB_DATABASE`; no
  `--all-databases`). Redis/KeyDB run a synchronous `SAVE`, which **blocks** the source for the whole
  snapshot (longer for bigger datasets) and rewrites its `/data/dump.rdb`; Dragonfly uses `SAVE RDB` to a
  temp file it removes afterward. Run it off-peak.
- **The hub never receives your database passwords.** They are read locally on the Coolify host (from
  `docker inspect`) and used only inside the source container; only the dump bytes (and their hub-computed
  sha256 + size) reach the hub.
- **Size cap:** each dump is gzip-compressed and must fit the hub's per-artifact cap (default **256 MiB**,
  `MIGRATION_MAX_ARTIFACT_BYTES`). Larger databases fail (`dump-too-big`/`too-large`) — use the manual path.

### Prerequisites

1. **Finish a Coolify import first.** The one-click migrator only *fills* databases the import already
   created. Run the importer to completion so the destination DB shells exist:
   - `POST /api/v1/import/connect` → `POST /api/v1/import/plan` → `POST /api/v1/import/apply` (the web
     **Import wizard** drives these), then wait until the operation's `database` tasks are **DONE**.
   - **Do not start, restore into, or back up** those freshly-created Tugra DBs before the migrator runs —
     the migrator restores only into an untouched, as-provisioned destination and refuses a used one
     (`dest-dirty`).
   - Only a **Coolify copy-mode** import qualifies (not the local-Docker in-place adopt), it must be
     **finished and not cancelled or rolled back**, and you must mint as the **same user who ran it**, who
     still holds `apps:config` on the target server's team. A database whose import task failed is not a
     target.
2. A **personal access token with `deploy` and `read:secrets`** — minting/reissuing needs both (the response
   carries a live credential). The import steps before it need `write` (connect), `read:secrets` (plan) and
   `deploy` (apply), so a token with `write` + `deploy` + `read:secrets` (or `admin`) covers the whole flow.
3. **On each Coolify server that holds databases:** Docker with a local socket at `/var/run/docker.sock`
   (override with `TUGRA_DOCKER_SOCK`; rootless/remote Docker is not supported). The source DB containers
   must be **running**.
4. The hub must be reachable from the Coolify host at a **public `https://` URL**. Set `HUB_PUBLIC_URL`
   (recommended) so the minted command embeds it; otherwise the hub URL is derived from the mint request's
   forwarded host/proto and must still come out `https://` and reachable from the source host (if your proxy
   doesn't send `X-Forwarded-Proto: https`, the command gets an `http://` hub and the migrator refuses it).
   The migrator runs in a default-bridge container, so a `localhost` hub is unreachable, and a plain
   `http://` hub is refused unless loopback or you pass `--allow-insecure-http`. For the compose-hosted
   agent, also set `MIGRATION_AGENT_HUB_URL` so the target agent can fetch the staged artifact.

### Step 1 — mint a one-time migration token

There is **no web-UI button for this yet**; use the API (or the `tugra api` CLI passthrough). `<opId>` is the
import operation id from `apply`:

```bash
tugra api POST /import/operations/<opId>/migration-token
```

The response is `{ opId, token, expiresAt, command }`. The `command` is the exact one-liner to paste, and it
is **shown only once** — the token is hashed at rest and unrecoverable afterward. The token is valid for
**1 hour**. Calling mint again while a token is still live returns **409** — use `reissue` to rotate (it
also works as a first mint; an already-expired token can be re-minted directly):

```bash
tugra api POST /import/operations/<opId>/migration-token/reissue
# check whether a token is active + see the command shape (never the live token):
tugra api GET /import/operations/<opId>/migrate-command   # -> { opId, active, expiresAt, commandTemplate (<TOKEN>) }
```

### Step 2 — run it on the Coolify host

Paste the printed `command` into a shell **on the Coolify server** (prefix it with a space, with
`HISTCONTROL=ignorespace`, so the token stays out of your shell history):

```bash
curl -fsSL <hub>/install/migrator.sh | TUGRA_MIGRATION_TOKEN=<token> sh -s -- --hub <hub>
```

The token rides the shell's environment — it is **never** placed on a command line (the script forwards it
to the container with a bare `-e TUGRA_MIGRATION_TOKEN`). Extra flags after `--hub` are forwarded to the
migrator:

- `--dry-run` — print the per-item plan and exit without dumping. **Run this first.** It checks only the
  token, the hub contract and per-engine support (items show `planned`); it does **not** inspect source
  containers or credentials, so a clean dry-run does not guarantee the real run won't skip a database.
- `--only <itemRef>` (repeatable) — restrict to specific databases. The `<itemRef>` is the full
  `database:<server>:<uuid>` string from the import status, or from the migrator's own JSON output.
- `--map <itemRef>=<container>` (repeatable) — when the source container is **not** named by its Coolify
  UUID (renamed / compose-managed), point the itemRef at a container name or id. The engine must still match.
- `--resync` — re-dump and overwrite an already-restored destination (use for the final cutover dump).
- `--allow-insecure-http` — permit a non-loopback `http://` hub (cleartext; avoid).

If some databases live on a **different Coolify server**, run the same command (same token, within the hour)
on that server too — the migrator only sees containers on the host it runs on.

### Step 3 — read the result (a green exit is not proof on its own)

The migrator prints **one JSON line** on stdout (a scrubbed human log goes to stderr):

```json
{"tool":"tugra-migrate","schema":1,"ok":true,"exit":0,"code":"ok","opId":"...",
 "counts":{"restored":3,"alreadyRestored":0,"failed":0,"skipped":0,"unsupported":0,"unconfirmed":0},
 "items":[{"itemRef":"database:_:<uuid>","engine":"POSTGRES","state":"restored","bytes":12345,"sha256":"..."}]}
```

`ok:true` (exit 0) means every in-scope database is **restored or already-restored** — or nothing was in
scope (`noTargets`) or it was a `--dry-run`, both of which restore nothing, so check `counts.restored` /
`alreadyRestored` and the `dryRun` / `noTargets` flags before trusting exit 0. `ok:false` is either a
**partial** run (exit 1 — some item `failed` / `skipped` / `unsupported` / `restore-unconfirmed`; the item
is **not a crash**, just a database the one-click path couldn't move) or an **abort** (exits 2–6, 130 — see
the table). Read `code`, `items[].state` and `reason`, and always re-verify counts as in the manual
[Verify](#5-verify-before-you-trust-it) step — a clean exit code alone does not prove the data matches.

Re-running is **idempotent**: already-restored items come back `already-restored` (use `--resync` to force a
fresh dump).

#### Exit codes

| Code | Meaning |
|---|---|
| `0` | ok — every in-scope database restored (or none in scope: `noTargets`) |
| `1` | partial — at least one item `failed` / `skipped` / `unsupported` / `restore-unconfirmed`. Read `items[].reason`. |
| `2` | usage — bad flag, malformed/absent `TUGRA_MIGRATION_TOKEN`, or an unsafe/non-`https` `--hub`. No network call made. |
| `3` | auth — token invalid/expired/revoked, or under 5 min left **at start**. **Reissue the token.** (Running out of time *mid-run* is not exit 3 — see `token-expiring` below.) |
| `4` | unreachable — hub down, 5xx / rate-limited after retries, a redirect (not followed — set `--hub` to the final origin), or a hub-side misconfiguration. |
| `5` | skew — the migrator doesn't match this hub's recipe contract. Re-download via this hub's `migrator.sh`. |
| `6` | precondition — Docker missing, no daemon socket, or the agent image failed to pull. |
| `130` | interrupted — Ctrl-C; remaining items `skipped:interrupted`, the container is reaped. |

#### Common skip/fail reasons

- `unresolved` — no container on this host is named by that Coolify DB UUID → pass `--map`, or the DB is on
  another server (run there too).
- `not-running` — the source DB container is stopped; start it, then re-run.
- `password-not-discoverable` / `credentials-not-discoverable` / `secret-file-unsupported` /
  `acl-user-unsupported` / `db-not-discoverable` — the credentials aren't readable from the container's env
  (e.g. the password was rotated after start, lives in a `*_FILE`/Docker secret, trust-auth, a non-default
  Redis ACL user, or MySQL/MariaDB with no `*_DATABASE`). Use the manual dump for these.
- `token-expiring` — fewer than 2 minutes of token life left mid-run; the remaining items are skipped and
  the run exits 1. Reissue and re-run (already-restored items are skipped). A long run spans one token hour.
- `dump-too-big` / `too-large` — over the artifact cap; manual path.
- `dest-dirty` — the Tugra destination was already started/used; it must be a fresh, just-provisioned DB.
- `restored-differs` — a different dump is already restored; pass `--resync` to overwrite.
- `restore-timeout` / `restore-unconfirmed` — the hub restore outran the client wait; it may still finish —
  re-run to re-check its status.
- state `unsupported` (reason `requires-S4b` / `no-logical-dump`) — ClickHouse / MongoDB / LibSQL; manual path.

### Security model

- **Token:** 256-bit, single-operation-scoped, valid 1 hour, hashed at rest (SHA-256; the raw value is shown
  once). It rides the shell environment and the container's `-e TUGRA_MIGRATION_TOKEN` — **never an argv**
  (`--token`/`--token-file` are hard-rejected by the script). Every destination is resolved server-side from
  the operation's tasks, so the untrusted host never names a target. Cancel/rollback revokes it.
- **Container:** a one-shot `docker run --rm` with `--cap-drop ALL --read-only --security-opt
  no-new-privileges`, writable only on two tmpfs mounts (so dumps never touch the host disk), **no inbound
  ports**, and the Docker socket as its **only** mount.
- **The hub trusts nothing from the source host:** it computes the artifact's sha256 and size itself (the
  migrator cross-checks), resolves every destination from the operation, re-authorizes the actor on every
  request, and serves the staged artifact to the target agent only over a signed, sha256-bound, short-lived
  URL on a trusted origin.
- **Honest caveats.** This is still `curl … | sh`, and the container mounts the Docker socket, which is
  **root-equivalent on the source host** — so only run the command from a hub you trust. The one-liner and
  its token land in your shell history unless you prefix it with a space. If you override `AGENT_IMAGE` to a
  mirror, it must be an image that ships the `migrate` subcommand (an older image would exit 0 without
  migrating — another reason to check the JSON result, not just the exit code).

---

# Manual migration (apps, volumes, and other databases)

This is the hand-driven path: recreate each app on Tugra and move data with a dump-and-restore. Use it for
apps and volumes, for **MongoDB**, and whenever the one-click migrator skips a database. (ClickHouse has no
documented dump procedure here yet; LibSQL is a plain volume copy.)

## What this covers / does not

- **Covers:** recreating apps (Git repo or container image), their env vars and domains, and moving
  **Postgres, MySQL, MariaDB and MongoDB** databases by logical dump + restore.
- **You do by hand:** app **volume** data (no automated Coolify→Tugra volume copy yet — use `rsync`/`tar`,
  or a tarball + the volume `import-from-url` endpoint), and the app's `DATABASE_URL` rewrite (Tugra
  generates its own DB credentials). These are manual in **both** paths.
- **Prefer the one-click migrator** for Postgres, MySQL, MariaDB, Redis, KeyDB and Dragonfly data; the manual
  Redis/KeyDB `BGSAVE`/`dump.rdb` dance below is only needed when the one-click path can't be used.
- **Not covered by either path yet:** ClickHouse and LibSQL data (ClickHouse + MongoDB are one-click-deferred;
  LibSQL has no logical dump — copy its volume); adopting Coolify's running (compose-managed) containers in
  place; Bitbucket sources; Caddy/Nginx custom proxy; per-DB SSL/init-scripts.

## Before you start

1. **Run Tugra on a fresh server** if you can. Coolify's proxy owns ports 80/443 on its host; same-box means
   a port conflict — use a separate server, or stop Coolify's proxy only at the final cutover.
2. Enrol that server in Tugra (install the agent).
3. Create a **personal access token with the `write`, `deploy` and `read:secrets` scopes** (or just `admin`).
   You need `write` to create apps/DBs and edit env, `deploy` to provision/import/set-domains, and
   `read:secrets` to read the new connection string. A `deploy`-only token gets **403** on create.
4. Have your Coolify host SSH access ready (for the **manual** dumps). Examples use the CLI passthrough:
   `tugra api <METHOD> <path> --data '<json>'`.

## ⚠️ The `gzip` flag (read this once)

`import-from-url` has `gzip: true` **by default**. A **raw** (non-gzipped) dump file must be imported with
`"gzip": false`, or the import fails with "not in gzip format". Only set `"gzip": true` when the file really
is gzipped (ends in `.gz`). Every example below is explicit about it.

## Move a database

Do databases **before** the apps that use them. **The dump you actually cut over with must be taken while the
source is quiesced** (see the cutover window) — any earlier dump is a rehearsal only, because writes that land
after a dump are lost at cutover. (The one-click migrator is no different: a first run is a rehearsal; take
the final dump with `--resync` after quiescing.)

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
`db.coll.countDocuments()` for Mongo). Do not cut over until they match. This applies to the one-click
migrator too — read its JSON result **and** compare counts.

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
3. Take the **final** dump now (step 1 above, or re-run the one-click migrator with `--resync`), import into
   the fresh Tugra DB, and verify counts.
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
