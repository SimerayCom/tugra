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

## Guided migration run (one flow for all of it)

Everything below can be driven one piece at a time, as this page describes. A **guided migration run** strings the
same pieces into one resumable, observable, abortable flow: preflight, config import, data (databases, volumes,
objects), TLS pre-issue, verification, the DNS cutover and an observe window, with a typed approval at the freeze and
at the **point of no return**, and an abort that restores Coolify as the authoritative system until that point.
Start it from the import wizard ("Run guided migration"), the panel's `/import/runs` pages, `tugra import run create`, or the `/migration-runs` API.
Always start with `--dry-run`: it projects every step and writes nothing outside its own run rows.

- Full procedure, step table, guarantees and troubleshooting: **[guided migration runbook](runbooks/guided-migration.md)**.
- **Status, stated plainly:** the run's engine and contracts are tested against in-memory fakes. **No live lab run has
  been done yet** (no real Coolify host, Cloudflare zone, migrator run or DNS flip). The manual path on this page is the
  one exercised on real hosts so far; treat the guided run as the way to *rehearse and orchestrate* it, and rehearse
  before using it on a fleet that matters.
- The golden rule is unchanged: the run **never deletes anything on Coolify**. Before the point of no return an abort
  restarts the source containers the run stopped; after it, the only way back is a lossy reverse.
- Not zero downtime for stateful apps, and not a replacement for the checks below: read the verification evidence
  (`hub-verified`, `migrator-reported`, `source-api-reported`, `host-loop-reported`, `operator-attested`) before you
  approve the cutover.
- **A fleet.** A project that spans several source servers is one run with a placement map (each source server mapped to a
  Tugra server), the migrator can be started on every source host by one script on the Coolify host
  (`coolify-host-loop`), a host inventory compares `docker ps` with what the source API lists, and a database too large
  for a dump artifact can stream. These are opt-in, designed from a real fleet, and **not yet run against one**; see
  [fleet runs](runbooks/guided-migration.md#fleet-runs-several-source-hosts-one-run). The manual path on this page needs
  none of it: run the migrator on each source host yourself.

## The Coolify API token

Create the token in Coolify under **Keys & Tokens, API tokens**. What it needs depends on how far you take the migration:

| Use | Ability | Notes |
|---|---|---|
| Connect and preview (discover) | `read` | Sees apps, databases, services, servers and non-secret settings. |
| Import with full fidelity | `read` **and `read:sensitive`** | Coolify 4.7 hides build/install/start and pre/post-deploy commands, the health-check command and response text, custom docker run options, Dockerfile text, custom labels, compose text and database `*_conf` from a token without it, along with passwords and variable values. The import plan warns when a row arrives without them. |
| Guided run with the `api` source controller | `deploy` (plus the two above) | Start and stop need the literal `deploy` ability. A token that only has `write` gets a 403; `root` covers everything. |

Rules that trip people up:

- `read:sensitive` only takes effect when the person who created the token is an **admin or owner** of the team. A member's token silently reads like a plain `read` token.
- The token must cover the **whole team**. A token limited to selected projects or environments cannot read `/servers` and the other team-wide endpoints, so connecting fails with a 403.
- A token whose creator now has less access in the team than the token grants is refused ("API token has more access than you have in this team"): create a new one.
- A 403 for every request also means the API is switched off in Coolify's settings, or **Allowed IPs** is on and does not include this hub's address.
- **Rate limits (Coolify 4.7+).** Coolify allows 200 requests a minute per user (every token of that user shares the budget) and blocks a token for 60 s, then 300 s, then 900 s after 30 failed (401/403) requests in a minute. Tugra paces its requests to about 150 a minute per Coolify URL, honours `Retry-After` on a 429 for a bounded time, and stops sending requests from a token that keeps failing authorization. A rate-limited import fails with a `rate-limited` error that is safe to retry a minute later. Older Coolify releases have no such limits and are unaffected.
- **Start and stop.** The `api` controller stops the source with `POST /{applications|services|databases}/{uuid}/stop` (always with `docker_cleanup=false`, so Coolify does not prune the source host) and restarts it on an abort with the matching `start`. A database or service that is already stopped or running counts as done. For an **application**, Coolify's `start` is a **deploy**: an abort rebuilds and redeploys the app rather than just starting its old container. Older Coolify releases that only expose these as `GET` are still supported.

## What moves how

| What | How |
|---|---|
| App definitions, env vars, domains | Coolify **import** (`connect → plan → apply`) — creates the apps and the **empty** destination DBs |
| **Postgres / MySQL / MariaDB / Redis / KeyDB / Dragonfly** data | **One-click data migrator** (below) |
| **MongoDB** data | **Manual** runbook (one-click deferred) |
| **ClickHouse** data | **Manual** dump by hand (no tool yet) |
| **LibSQL** data | **Manual** — it's a single SQLite file; copy the volume (`tar`/`rsync`) |
| Coolify **services** (Meilisearch, MinIO, Gotenberg, SigNoz, Beszel, cloudflared, your own compose stacks) | **Import** creates ONE **stopped** compose app per service from the service's own compose file (nothing is deployed). Secrets are carried, never regenerated; named volumes are declared (a host folder bind becomes a named volume); `container_name`, published ports and `coolify.*` / `traefik.*` labels are stripped (reported); members that need the Docker socket, privileged mode or host namespaces are dropped (a standalone Beszel agent is skipped; SigNoz imports without its ClickHouse data); config files kept next to the compose (SigNoz) become config mounts when the token can read them. An internal-only service joins a private network under a stable alias instead of a public domain. A floating `:latest` can be pinned to the version the source runs in the review screen. cloudflared is always created stopped: stop the source connector and repoint the Cloudflare routes by hand first. Service **data** is copied by hand (stop the source first); the review screen and the post-import checklist say what is left to do. |
| App **volume** data | **Streamed volume copy** — the migrator (run on the source server) copies each declared app volume of a **stopped** container to the target in resumable parts through the hub's memory relay: no size cap, owner/group/mode kept, no hub disk, resumable after an interruption ([details below](#streamed-volume-copy)). A small volume can still be uploaded by hand to the hub (`tar` + `curl -T`, up to ~256 MiB gzip, ownership **not** preserved). |
| `DATABASE_URL` rewrite (apps → new Tugra DB) | **Env remap** step — a preview then a confirm-gated apply (API/CLI: `GET/POST /import/operations/:opId/remap-env`), since the migrated DB gets **fresh** Tugra credentials. Compose/swarm/cross-host apps are flagged needs-manual. |
| Environment variables | Strict: a variable the import cannot carry (unresolved shared, magic, invalid name, or an API token without `read:sensitive`) is a plan blocker; acknowledge it to create the app without it (see "Strict environment variables" below) |
| Private git repositories | Linked at apply to the connected GitHub/Gitea source that can see the repo (see "Git links" below) |
| **MinIO / S3 object data** | **Object migration** (below): `mc mirror` run by the target agent, bucket by bucket |
| SSL + DNS cutover | **Cutover panel** / `tugra import cutover` (certificate pre-issue, paced Cloudflare flip, ledger revert; [runbook](runbooks/cutover.md)), or the same step inside a [guided run](runbooks/guided-migration.md). A zone Tugra cannot write to stays manual: the panel prints the records. |

---

# One-click data migration

You mint a one-time token for a finished Coolify **import operation**, paste a single command on the
Coolify host, and Tugra discovers each source database container, dumps it, streams the dump to the hub,
and restores it into the matching Tugra database. It is a **point-in-time logical dump per database** — not
live replication — so the cutover discipline at the end of this page still applies.

### What it does, and what it does NOT do

- **Moves:** the data of Postgres, MySQL, MariaDB, Redis, KeyDB and Dragonfly databases.
- **Does not move:** DNS, or **MongoDB / ClickHouse / LibSQL** data — use the manual runbook for those. App
  **volume** data is moved by the migrator's **volume arm** ([Streamed volume copy](#streamed-volume-copy)),
  done before the first deploy and gated so a started app's volume is never wiped; a tiny volume can still use
  the hub-staged upload (tar the declared volume and `curl -T` it to
  `PUT /import/migration/artifacts/:itemRef/volumes/:name`, then `POST …/restore`). The app's `DATABASE_URL`
  (the Tugra DB gets new credentials) is rewritten by the separate **env remap** step (preview +
  confirm-gated apply), not by this data migrator.
- **Dumps one database per container** (MySQL/MariaDB need `MYSQL_DATABASE`/`MARIADB_DATABASE`; no
  `--all-databases`). Redis/KeyDB run a synchronous `SAVE`, which **blocks** the source for the whole
  snapshot (longer for bigger datasets) and rewrites its `/data/dump.rdb`; Dragonfly uses `SAVE RDB` to a
  temp file it removes afterward. Run it off-peak.
- **The hub never receives your database passwords.** They are read locally on the Coolify host (from
  `docker inspect`) and used only inside the source container; only the dump bytes (and their hub-computed
  sha256 + size) reach the hub.
- **Size cap:** each dump is gzip-compressed and must fit the hub's per-artifact cap (default **256 MiB**,
  `MIGRATION_MAX_ARTIFACT_BYTES`). Larger databases fail (`dump-too-big`/`too-large`) — use the manual path, or,
  for a PostgreSQL database, the **volume copy** data mode of the [streamed volume
  copy](#streamed-volume-copy) (a physical copy with no size cap, under strict conditions).

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
- `--certs` — **opt-in, off by default.** Also copy the Coolify proxy's Let's Encrypt certificates for the
  hostnames of this import, for zones where Tugra cannot pre-issue a DNS-01 certificate (a non-Cloudflare
  zone). **The certificates' private keys travel to your hub** (they are encrypted at rest and purged once
  applied; the ACME account key is never sent). See [`runbooks/cutover.md`](runbooks/cutover.md#seeding-source-certificates-optional).
  `--proxy-container <name>` names the Coolify proxy container (default `coolify-proxy`).

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

# Streamed volume copy

The migrator has a second arm, **`--arms volumes`** (the Move data step's commands use **`--arms all`**: databases
first, then volumes). It copies the declared volumes of **stopped** source containers straight to the Tugra
target in **resumable parts**, so a 30 GB volume is not blocked by the hub's 256 MiB staging cap. There is no
hub-side disk use: every part crosses the hub in memory only.

### How it works

1. The migrator inspects each volume (size, entries, running state, special files; for PostgreSQL the image, the
   major version, the data layout and the mount) and tells the hub. **`--dry-run` does only this** and asks the
   hub to check the **target's free space**: run it first, before you choose a window. Nothing is stopped or
   moved.
2. The **source container must be stopped.** The migrator refuses a running one (`volume-skipped-running`) unless
   you pass **`--stop-source`**, which stops **only that container** (`docker stop`, never `docker rm`) and
   **restarts it if the copy does not complete**; after a complete copy it stays stopped, because the target now
   owns the cutover. Quiescence is checked before the first byte and again after the last (the container did
   not start again, no other container uses the volume); the hub stores the begin-time state and refuses to apply
   a copy whose source changed. The UI labels this evidence **"reported by the migrator"**: the hub cannot verify
   it.
3. The migrator runs GNU `tar` with its **own image** as the helper (**nothing is ever pulled onto your source
   host**), read-only on the volume, with no network and only `DAC_READ_SEARCH` added (to read files other users
   own). The archive is cut into independent gzip parts of about **128 MiB raw** (`--part-mib`, 32 to 512, must
   equal the hub's `MIGRATION_VX_PART_MIB`) and each part goes **register → PUT → commit**: the hub verifies the
   part's sha256 and exact length in its memory relay, the target verifies them again before it stores the part.
4. After the last part the hub checks totals and the source state, re-checks the destination and the target's
   free space, and the **target applies** the parts: it empties the (never-started) destination volume,
   extracts with a rollback snapshot (a failed extract restores the old content), keeps **numeric owner and
   group, mode and times**, and compares the entry count with the source's.
5. **Resume:** run the same command again. Parts the hub already holds are re-read from the source and compared
   by **raw hash** (no network), then sending continues. A mismatch (`volume-diverged`) means the source changed;
   it is never overwritten automatically: use **`--reset-volume <itemRef>`** (or the UI's Reset) to start over.
   A hub restart mid-part is waited out (`--hub-outage-wait`, default 15 min).

### Flags

| Flag | Meaning |
|---|---|
| `--arms databases\|volumes\|all` | what to migrate; default `databases` (today's behaviour) |
| `--dry-run` | inventory + the target's free-space check only |
| `--stop-source`, `--stop-timeout S` | stop each running source container for the copy (default wait 120 s) |
| `--allow-bind` | also stream host bind mounts (system, Docker and Coolify-secret paths stay refused) |
| `--part-mib N` | raw MiB per part, 32..512, must equal the hub policy |
| `--reset-volume <itemRef>` | discard a volume's staged parts and start it over (repeatable) |
| `--hub-outage-wait D` | how long to wait for a restarting hub (default 15m, up to 1h) |
| `--speedtest-mib N` | measure the real link before you stop anything: streams the first N MiB (1 to 1024) of the volume through the relay to a throwaway directory on the target, discards it and prints the measured MB/s and the window it implies (an **estimate**) |
| `--dump-spool-mib N` | cap in MiB of the streamed database dump's on-disk backlog (default 8192, 1 to 4194304). The dump client is drained into a scratch volume (`/dump-spool`) as fast as it writes, so a hub restart or a slow link cannot make the source server cut the dump at its `net_write_timeout`; consumed segments are deleted at once, and the drain pauses at the cap or when the scratch volume's free space is short. The result reports the peak backlog as `spoolPeakBytes` |
| `--restart-on-failure=false` | leave a container this run stopped stopped when the copy fails |

Result states per volume: `volume-applied`, `volume-copied` (copied, apply not confirmed), `volume-skipped-running`,
`volume-diverged`, `volume-source-missing`, `volume-bind-refused`, `volume-special-files`,
`volume-disk-insufficient`, `volume-aborted`, and **`volume-not-migrated`** (a volume you explicitly excluded in
the UI after a confirmation: never skipped silently). Anything but `volume-applied` makes the exit code 1.

### PostgreSQL volume copy (physical)

A PostgreSQL database can opt into **Volume copy** in the plan review (data mode *Logical dump | Volume copy*).
It copies the data **directory**, so there is no dump to size and no replay. It is offered only when every gate
passes, each shown in the UI with its evidence: the credentials were carried from the source (the copied cluster
holds the source's passwords), the same image runs on both sides (`postgres:16-alpine` is **not** replaced by a
Debian image), the same major, PGDATA at the volume root mounted at `/var/lib/postgresql/data` (the PostgreSQL 18
image keeps it one level down and is refused: *PostgreSQL 18 data layout is not supported by Tugra database
volumes yet*), the destination was never started, and the source is stopped. If any gate fails you get the exact
reason, and the database stays on the logical dump. After the extract the hub starts the database through the
normal start path and waits for it (crash recovery of an unclean stop can take minutes). MariaDB/MySQL and
Redis-family databases stay logical. If the source was stopped uncleanly (exit code 137), expect WAL replay on
the first start.

### What is and is not copied

Copied: files, directories, symlinks, hard links, **numeric owner and group, mode, modification time** (whole
seconds). **Not** copied: extended attributes, ACLs, file capabilities, sockets (counted per volume), sub-second
times; **device nodes refuse the copy**. A mounted volume of another container stays untouched. Setuid bits and
numeric ids are preserved on purpose; the source is your own host.

### Downtime, space and limits (read before choosing a window)

- **Downtime** is source stop → end of copy → apply → target start (DNS is yours). For about 30 GB expect 20 to 60
  minutes depending on the link; **that is an estimate, not a promise**: the dry run measures size and space, and
  `--speedtest-mib 512` measures the real end-to-end rate (the result reports `speedMBps` and `estimateSeconds`:
  size divided by the rate, plus about 15 minutes to extract) before you stop anything. A block-level pre-seed (near-zero downtime) is a separate, later feature.
- **Target disk:** the compressed parts are staged on the target (about 1x) and the apply needs about 1.05x the
  data again; with staging and Docker on one filesystem both add up, so a 30 GB volume wants about **65 GB free**.
  The hub checks this (`vx-disk-insufficient` names the numbers) before and after the copy.
- **One hub.** The relay is in-process memory, so a streamed copy needs the single-hub topology; every byte
  crosses the hub's network twice. Migration parts use their **own relay seats** (`MIGRATION_RELAY_CONCURRENCY`,
  default 2), separate from app moves. The migrator container is capped at **768 MiB**.
- **A proxy in front of the hub** that caps request bodies (for example Cloudflare's 100 MB limit on a proxied
  hostname) also caps a part: already-compressed data does not shrink, so lower `MIGRATION_VX_PART_MIB` (32 is the
  minimum) or point the migrator at an unproxied hub address.
- **The token renews itself** while a copy runs (1 hour at a time, **72 hours** in total, `MIGRATION_TOKEN_MAX_LIFE_HOURS`).
- Each hub-side limit is an env var: `MIGRATION_VX_ENABLED` (kill switch), `MIGRATION_VX_PART_MIB`,
  `MIGRATION_VX_MAX_BYTES` (256 GiB per volume by default), `MIGRATION_VX_STALE_MS`.
- A rollback of the import is refused while a copy runs (abort it first), and never removes an app or database
  whose streamed data was applied.
- Not part of this path: compose/service volumes (MinIO data, Meilisearch), SSH pivot servers, the Coolify
  control plane.

### Commands

The Move data step shows three commands (dry run, copy, resume) with toggles for `--stop-source` and
`--allow-bind`; the same data is on the API (`GET /import/operations/<opId>/volumes`) and the CLI:

```bash
tugra import volumes <opId>                       # progress of every volume
tugra import volumes <opId> --abort <itemRef>     # stop one copy (staged parts are kept)
tugra import volumes <opId> --reset <itemRef>     # discard its parts and start over
```

---

# Manual migration (apps, volumes, and other databases)

This is the hand-driven path: recreate each app on Tugra and move data with a dump-and-restore. Use it for
apps and volumes, for **MongoDB**, and whenever the one-click migrator skips a database. (ClickHouse has no
documented dump procedure here yet; LibSQL is a plain volume copy.)

## What this covers / does not

- **Covers:** recreating apps (Git repo or container image), their env vars and domains, and moving
  **Postgres, MySQL, MariaDB and MongoDB** databases by logical dump + restore.
- **You do by hand:** the app's `DATABASE_URL` rewrite (Tugra generates its own DB credentials — or use the
  **env remap** step), and any volume the streamed copy does not cover (compose-managed volumes, services such
  as a 58 GB ClickHouse — those you copy with `rsync`/`tar`, or a tarball + the volume `import-from-url`
  endpoint). **App volume data** has an automated path: the [streamed volume copy](#streamed-volume-copy).
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
3. **App volumes:** use the [streamed volume copy](#streamed-volume-copy) (the migrator's volume arm). Only a
   volume it cannot reach (compose-managed, a service volume) is copied by hand while the app is stopped on both
   sides (`docker run --rm -v <vol>:/data alpine tar czf - -C /data .` on the source, untar into the Tugra volume).
4. **Deploy** on Tugra and smoke-test through the Tugra proxy before touching DNS. An imported app has no
   temporary `sslip.io` hostname (it is created with its real domain), so use the cutover panel's check (it
   handshakes with the Tugra server's IP using your hostname as SNI and fetches the health path with your
   `Host` header) or do the same by hand: `curl --resolve <your-domain>:443:<tugra-server-ip> https://<your-domain>/`.

## The cutover window (do not skip — this is where data is lost otherwise)

Everything above can be rehearsed with the source live. The real cutover must be a short planned window so no
writes are lost:

1. Lower the domain's DNS TTL a day ahead.
2. **Quiesce the source:** put the Coolify app in maintenance mode or stop it (at minimum stop its workers /
   writers) so its database takes no more writes.
3. Take the **final** dump now (step 1 above, or re-run the one-click migrator with `--resync`), import into
   the fresh Tugra DB, and verify counts.
4. **Cut over SSL and DNS with the cutover panel** (import wizard, once the import has settled), or the CLI
   `tugra import cutover <opId> ...`. It tracks every hostname through *certificate ready, DNS at source,
   switched, verified*, pre-issues the certificate on Tugra before DNS moves where it can, and switches
   Cloudflare records in paced batches. Follow the order in the [cutover runbook](runbooks/cutover.md).
   For a host you switch by hand (any non-Cloudflare DNS), the panel prints the exact records and the TTL
   guidance; `tugra apps domain <appId> <your-domain> --dry-run` remains available for single native apps.
5. Verify the domain resolves and serves correctly, then **stop the Coolify app** (not just DNS-switch it)
   so stale-DNS clients can't keep writing to the old database and diverge. Tugra's Coolify token is
   read-only, so the panel **prints the steps** for stopping the source and never does it for you.

What this does and does not promise: with a Cloudflare zone and DNS-01 the certificate is valid on the first
request after the switch; stale resolvers keep reaching Coolify for at most the old TTL (or 60 s if you lowered
it in time). It is **not zero downtime**: a stateful app is down for the data move, and a zone Tugra cannot
write to has a bounded gap while the certificate is issued after the switch.

## Rollback & order

- **Rollback** (before Tugra has taken real writes): in the cutover panel, *Revert* restores each DNS record
  exactly as it was (it refuses to overwrite a record changed since the flip unless you force it), then restart
  the Coolify app — its copy is untouched. Auto-revert is **off**: the panel never reverts on its own. **After** Tugra has taken writes, rolling back means dumping Tugra back to Coolify first, or you
  lose those writes. A guided run draws the same line explicitly: `abort` is refused after the point of no return
  and `reverse` is the lossy path (it requires an acknowledgement that data Tugra wrote is not restored).
- Stateless apps first, then small DBs, then large/critical DBs last. One app + its DB at a time; verify each.
- Keep Coolify around for at least a few clean days. Never delete anything on Coolify until the Tugra copy has
  served real traffic and backed up successfully.

---

# Strict environment variables

Coolify imports no longer drop variables silently. The plan lists, per app and **by name only** (values never appear in
the plan, task output, audit or logs), every variable it cannot carry, with a reason:

| Reason | Meaning |
|---|---|
| `NO_VALUE` | the API returned no value for the variable |
| `SHARED_UNEXPANDED` | a shared (`{{team.X}}` / `{{project.X}}` / `{{environment.X}}`) variable that Coolify did not expand |
| `MAGIC` | a Coolify `SERVICE_*` magic variable |
| invalid name | not a valid environment key (for example it contains `=` or a space); such a key is skipped |

Each is a **blocker you can acknowledge** (per app, or "Acknowledge all") to create the app **without** those variables; a
deploy may then fail or misbehave. Preview-environment variables are counted and not imported. If the API token cannot read
variable values at all (it lacks the `read:sensitive` ability) the plan shows one **non-acknowledgeable** row per app:
create a token with `read:sensitive` and reconnect. Over the API, `POST /import/apply` takes an optional
`acks: [{ code: "app.env.unresolved" | "app.env.key.invalid", itemRef? }]` (omitting `itemRef` acknowledges every item
carrying the code); the applied set is recorded in the operation. Dokploy and local imports are unchanged.

An env value that still points at an old Coolify service host (for example the MinIO service) is listed under
"review" in the env-remap preview; it is never rewritten automatically. Set the new endpoint after you have migrated that
service's data.

# Git links

At apply, each git app is linked to the connected source that can actually see its repository (a GitHub App installation, or
a Gitea / Forgejo / Codeberg token on the same host). The old "exactly one installed source" rule is gone. Use
`POST /import/git-links` (or the panel before Apply, or `tugra import git-links`) to see the result per owner: **linked**,
**public** (clones without a source), **needs a source** (connect a GitHub App installed on it, then Re-check), **ambiguous**
(several sources see it; pick one after import), **SSH deploy key** and **unsupported host**. An SSH GitHub URL that a
connected App covers is created as its https twin; other SSH repositories keep a generated deploy key and the timeline shows
its public key. GitLab and Bitbucket are not supported yet: those repositories are created unlinked and the preflight
`git.hosts` list tells you which hosts your fleet uses. After import, "Link now"
(`POST /import/operations/:opId/git-links/relink`) links every created app that a source now covers.

# Object migration (MinIO / S3)

A Coolify import does not copy object data. Use **Object migration** (Import page, or `tugra objects`):

1. **Create** with the source endpoint and keys (a read-only key is enough), the destination endpoint and keys, and the
   target server whose agent runs the copy. For a MinIO on the same host as that agent use
   `http://host.docker.internal:9100` (its published port). The agent must be able to reach both endpoints. Secret keys are
   encrypted at rest and never shown again. The agent needs the `backup` capability (the same grant as S3 backups) and an
   agent image that ships `mc` (update the agent if the preflight says it does not).
2. **Preflight** lists every source bucket with its real object count and size and exports each bucket's anonymous policy,
   lifecycle rules and tags. **Nothing is pre-selected**: choose the buckets (a large bucket may just hold backups), optionally
   rename a destination bucket or add exclude globs.
3. **Seed** copies live; it never overwrites an existing destination object. At most two helpers run per target server at once.
4. Stop the writers to the bucket on the old side (Tugra cannot stop Coolify apps), then run the **final pass**: it copies the
   changes and overwrites objects that differ. Deleting extra destination objects (`mc --remove`) is a separate, off-by-default
   acknowledgement.
5. **Verify** runs `mc diff` per selected bucket and compares **keys and sizes**; it is not a content-hash check. The
   migration is **Done** only when every selected bucket verified clean after a final pass.
6. Optionally **apply the exported bucket settings** (policy, lifecycle, tags) to the destination.
7. Set the new endpoint in the apps (the env-remap preview lists values that still point at the old service) and start them.

**Not carried:** object versions, IAM users and access keys, replication, event notifications, SSE keys and object lock.
Writes made to the source after the final pass are not copied. The copy runs in a detached helper container
(`--cap-drop ALL`, read-only root, no docker socket or host mount); the credentials live only in its environment, which is
visible to `docker inspect` on the target host until the helper is removed, exactly like any Tugra app's environment there.
