# Migration lab (volume stream, L0-L14)

The data-plane chain of the one-click migrator has two halves that unit specs only ever test against fakes: the Go specs
fake the hub, the hub specs fake the target agent. The lab runs the **real** chain on one Linux docker host:

```
real Go migrator (the agent image, the installer line) -> HTTP -> real hub (relay) -> signed WS command
  -> real target agent (curl) -> /etc/tugra/app-moves -> real alpine busybox apply (safeWipeExtract)
```

Source and target are separate docker volumes and containers on the same daemon. This is **Tier A**. **Tier B** (a real WAN
link, a Cloudflare body cap, real Coolify container naming, separate disks) is the last section and is not automated.

L0-L8 were written against one stopped container with 256 MiB to 6 GiB of urandom. **L9-L14 and the fleet-shaped fixtures
(`fleet.sh`)** model the estate the guided migration has to move: running sources with Coolify's uuid names, a multi-GB
time-series PostgreSQL, a MariaDB over the logical cap, a 12-bucket MinIO on a bind mount, Coolify 4.1.2 discovery and an Ubuntu 26.04
userland. They are described in "Fleet-shaped lab" below; their data is **generated on the runner, never kept in git**.

Everything below was derived from reading the code and the specs. The harness was written without a docker daemon on the
author's machine, so the first run on a runner is the first run: expect to fix harness details, and treat a red lab as a
finding first, a harness bug second (the scripts print the migrator log, the hub log is an artifact).

## Running it

**CI (the normal way).** Actions, *Migration lab (vx)*, *Run workflow*. `items` is `all` or a comma list of
`tar, core, restart, postgres, memory, seats, throttle, fleetpg, fleetdb, fleetminio, fleethosts, fleetcoolify, ubuntu`, or `fleet` for
the last six. It also runs nightly (all of them). Each item is its own job on a fresh `ubuntu-latest` runner; logs (`hub.log`,
`run.*.log`, `run.*.json`, `mem.*.log`, `*.summary`, compare diffs, agent log) are uploaded as the `vx-lab-*` artifact. Two dispatch
inputs size the big fixtures: `pg_gib` (L9, default 4) and `minio_div` (L11, default 4).

| Job | Items | What it needs |
|---|---|---|
| `tar` | L4 | docker only (no hub) |
| `core` | L0, L1a, L1b | the full lab, about 12 GiB of docker disk |
| `restart` | L2 | the full lab, about 8 GiB |
| `postgres` | L6, one job per image (`postgres:16-alpine`, `postgres:17-alpine`, `pgvector/pgvector:pg17`, `postgres:18-alpine`) | the full lab |
| `memory` | L7 (random, zeros and a real PostgreSQL heap) | the full lab, `L7_MIB` x 3 of disk (default 3072 MiB, so about 10 GiB) |
| `seats` | L8, two shapes: 2 migrators on 1 seat, 4 migrators on 2 seats | the full lab, two to four agents and sources |
| `throttle` | L3 mechanics | the full lab |
| `fleetpg` | L9, one job per image (`postgres:17-alpine`, `postgres:18-alpine`) | the full lab, about 3.5 x `pg_gib` of disk (source, staged parts, destination): 15 GiB at the default 4 |
| `fleetdb` | L10 | the full lab, about 4 GiB |
| `fleetminio` | L11 | the full lab, about 3 x the bucket total on `/mnt` and `/` (about 7 GiB at the default `minio_div` 4) |
| `fleethosts` | L12 | the full lab, about 3 GiB, 25 containers |
| `fleetcoolify` | L13 | the full lab (hub only; the mock is a node process) |
| `ubuntu` | L14 | the full lab, the `ubuntu:26.04` and `docker:27-cli` images |

**On a Linux box with docker, node 22 and pnpm** (not macOS: the target agent bind-mounts the host's `/etc/tugra`):

```bash
scripts/lab/up.sh                      # registry:2, agent image, postgres+redis, hub, target agent ONLINE
scripts/lab/l0-dry-run.sh              # any scenario; each starts from a fresh op, app and source volume
scripts/lab/l1a-stream.sh
scripts/lab/down.sh                    # tears everything down, removes $LAB_DIR
```

**The lab is destructive on its host.** `up.sh`, `down.sh` and every scenario refuse to run unless `CI=true` (GitHub Actions sets it) or
`LAB_I_UNDERSTAND_DESTRUCTIVE=1`: the target agent mounts the host's `docker.sock` and `/etc/tugra`, and scenario cleanup removes helper
containers and staging. What gets removed is scoped to the lab: fixed lab container and volume names, and the production-shaped
volumes (`tugra_appv_<appId>_*`, `tugra_dbv_<dbId>`, `tugra_restore_rb_vx<transferId>`) and `/etc/tugra/app-moves/<id>` dirs whose ids
are in the **lab hub's own database** (`seed.mjs ids`, `scope.mjs`). On a box that also runs real Tugra none of its volumes match, but
use a disposable host anyway.

`LAB_DIR` (default `$TMPDIR/tugra-lab`) holds `lab.env`, `hub.env`, `hub.log`, `run.<tag>.{json,log}` and the per-op
env files (they contain a migration token: ephemeral, but do not upload them). The hub is a plain node process,
`scripts/lab/hub.sh start|stop|kill|restart|status [KEY=VALUE]`; `KEY=VALUE` pairs persist across restarts
(`hub.sh restart MIGRATION_VX_PART_MIB=32`, `hub.sh reset-extra`). A scenario can also be driven by hand:

```bash
scripts/lab/fixture.sh lab-src 2048 random && scripts/lab/migrate.sh --arms all --part-mib 128   # after sourcing op env
scripts/lab/compare.sh lab-src "$DEST_VOLUME"
```

## What the harness does (scripts/lab)

| File | Role |
|---|---|
| `up.sh` / `down.sh` | Local `registry:2` on `localhost:5000` (the installer **always** `docker pull`s its image, so the real line `curl .../install/migrator.sh \| sh -s -- --image localhost:5000/tugra-agent:lab` only works with a registry); builds `deploy/Dockerfile.agent`; `docker-compose.dev.yml` for the hub's postgres and redis; builds and migrates the hub; starts it with a **stable** `HUB_SIGNING_KEY` (an ephemeral one would make the enrolled agent distrust a restarted hub); enrolls the target agent with `backup` and `deploy` capabilities (without `backup` the agent never gets `TUGRA_HUB_ORIGIN` and the receive script fails). |
| `hub.sh` | The hub as a restartable process (L2 kills it with SIGKILL). |
| `seed.mjs` | Node 22 stdlib plus the hub's own `@prisma/client`. Through the REST API: user, team, server, app, database. Through prisma, the only thing no API creates without a real Coolify source: the import `BulkOperation`, its DONE provisioning task and the migration token (exactly what the hub specs insert). Prints `KEY=VALUE` lines (`OP_ID`, `MIG_TOKEN`, `ITEMREF`, `DEST_VOLUME`). |
| `fixture.sh` | Deterministic data: one big file (random or zeros), owners 999/70/1000, modes 0600/0700/0750, hard link, symlink, dangling symlink, FIFO, unicode and spaced names, a 3 x 61 character path, a 200 character file name. Generated once per scenario so the tar stream is identical across attempts (resume compares raw slice hashes). |
| `migrate.sh` | The real installer line against the lab hub. Passes every other flag to the migrator. Writes the JSON result and the log per run tag. |
| `compare.sh` | `ARCHIVE-IDENTICAL` (sha256 of the same GNU tar stream over both volumes) or a field-level busybox `stat` plus content-hash diff naming the exact entry and field. A difference only in directory mtimes prints `DIR-MTIME-ONLY` (the extractor decides those; `COMPARE_STRICT=1` makes it fail). That verdict is taken from the `tar -tv` listing with only directory mtimes masked (`tarlist.sh`), never from the manifest being empty, so a wrong volume-root owner or mode, a lost setuid bit, or a changed symlink or FIFO mtime is `ARCHIVE-DIFFERS`. If busybox turns out not to restore symlink mtimes, that shows up here as a finding to document with evidence, not to hide. |
| `manifest.sh` | The per-entry manifest `compare.sh` uses: the volume root `.`, full 4-digit modes, owner, size, link count, content hash, file/symlink/special mtimes; directory mtimes only with `DIR_MTIME=1`. |
| `tarlist.sh` | The masked tar listing behind `DIR-MTIME-ONLY`. |
| `scope.mjs`, `seed.mjs ids` | Which volumes and staging dirs the lab owns (ids in the lab hub's database), used by `down.sh` and scenario cleanup. |
| `http-tap.mjs` | Pass-through to the hub that counts `{"busy":true}` answers to part registrations (L8). |
| `fleet.sh` | The fleet-shaped fixtures, sourced by L9-L14. Coolify-style names (`fleet_uuid`: 24 characters, `fleet_stamp`: the 13 digit deploy suffix), a running PostgreSQL with a multi-GB append-only time-series table (`fleet_pg_load_ticks`), a running MariaDB (`fleet_mariadb_load`), a MinIO with the 12 real bucket size classes on a host bind (`fleet_minio_plan`, `fleet_minio_fill`), redis with a password on its command line and a custom conf, orphan volumes, `fleet_snapshot_others` (the blast-radius check) and `fleet_cleanup`. Everything it creates carries the docker label `tugra.lab.fleet=1` and `down.sh` removes exactly that. |
| `units.mjs` | Docker's decimal human sizes (`2.147GB`) as bytes, to compare `docker system df` with what is really on disk. |
| `seed-mode.mjs` | The engine and data lane a seeded op uses: `--kind db` is a PostgreSQL physical copy by default, `--data-mode dump` is the logical arm (its ITEMREF is the database ref), and every engine but PostgreSQL is logical only. |
| `coolify-fleet.mjs`, `coolify-mock.mjs` | A Coolify 4.1.2 API with invented names: 8 team tokens (read-only, scoped by token), an unfiltered `/teams`, 78 apps, 29 databases, 19 services, 24 servers, comma-list `fqdn`s with both schemes, service sub-apps on `:8080`. L13 serves it to the hub. |
| `ubuntu-pick.sh` | Pulls `ubuntu:26.04`, else falls back to `ubuntu:24.04` and says `fallback` (L14 turns that into a workflow warning). |
| `selftest.mjs` | `node --test scripts/lab/selftest.mjs`: the harness's own decisions (workflow job selection, the destructive guard, ownership scoping, the L0 snapshot, manifest and tar listing, the tap, the timing of L2/L3/L6/L8) without docker. Runs in the `tar` job. |
| `throttle-proxy.mjs` | Node `net` only. `--listen 4001 --target 127.0.0.1:3000 --rate 10` throttles the upload direction to 10 MB/s by backpressure, shared by all connections like one link. Verified on loopback: 5, 20 MB/s configured gave 5.0 and 20.0 MB/s measured. |
| `jget.mjs` | A 30-line JSON path reader (no jq needed on a dev box). |
| `lib.sh` | Shared helpers (`lab_scenario_begin`, `lab_run`, `lab_run_bg`, `lab_expect_item`, `lab_no_leftovers`, ...). |

The migrator source of L0-L8 is a **stopped container named after the sourceRef** (`labsrc`, created with `docker create`, never
started) mounting the source volume, so no Coolify is needed. The hub derives the destination volume (`tugra_appv_<appId>_data`,
`tugra_dbv_<dbId>`) itself. **The real estate's sources are not like that**: they are RUNNING containers whose names are 24 character
uuids (a database) or `<uuid>-<13 digit deploy stamp>` (an application, which the migrator matches by the suffix), on hosts that also
run other things. For a running source `volume-skipped-running` is the normal answer to a plain dry run, and `--stop-source` is the real
path. L9-L14 use that shape; L0 also checks that `--dry-run --stop-source` says `would-stop-source` and stops nothing.

## Scenarios

Every scenario fails with a message naming the check. "Expected" below is what the code says should happen; a mismatch is the
finding.

### L0 dry-run (`l0-dry-run.sh`)
`--arms all --dry-run` on 256 MiB: state `planned`, `disk: ok`, entries and raw bytes reported; `docker ps -a` identical before and
after (name, full id and state: docker's relative `Status` text changes by itself), source untouched, nothing staged, no hub transfer row, the stored inventory visible at
`GET /import/operations/<op>/volumes`. Negatives: a started source gives `volume-skipped-running` and is not stopped; a disk
check for twice the free space (within the hub's 256 GiB limit) is `ok: false, unknown: false`; a device node in the source gives
`volume-special-files`. A started source with `--dry-run --stop-source` is `planned` / `would-stop-source`, and the dry run still does not stop it.

### L1a streaming (`l1a-stream.sh`)
`L1A_MIB` (default 2048) incompressible MiB, 128 MiB parts: `volume-applied`, exit 0, at least size/128 parts, a rate logged per
part, the hub transfer `DONE`, no `tugra-vx-*` helper, no rollback snapshot volume, no staged parts, the source never started,
`compare.sh` identical.

### L1b interrupt and resume (`l1b-resume.sh`)
First runs go through the throttle proxy so "half way" is a window. (1) `kill -9` the migrator container: the immediate rerun is
refused with reason `another-run-active` (a UX finding if a user would not understand it), then after `MIGRATION_VX_STALE_MS`
(30 s here) the rerun takes over, **skips** the committed parts (the resumed run's first reported part is where the dead run
stopped, and no index is sent twice), ends `volume-applied` and compares identical. (2) `docker stop` (SIGTERM) releases the
lease: the rerun is accepted at once and the source container was never started. (3) A changed source gives `volume-diverged`
with no part sent; `--reset-volume` recovers.

### L2 hub restart (`l2-hub-restart.sh`)
(A) 32 MiB parts at 2 MB/s with `MIGRATION_VX_STALE_MS=300000` (the lab's 30 s default would let the boot sweep declare the run dead
after the 20 s outage plus boot, a harness artifact); when a `p.NNNNN.tmp` is on the target the hub gets SIGKILL, waits 20 s and restarts. The migrator rides
the outage (`--hub-outage-wait 10m`): either `vx-part-lost` and a re-send, or the part-stat shortcut; the run ends `volume-applied`
and identical with no operator action. (B) With 1.5 GiB the hub is killed while the transfer is `APPLYING`; `vx-recovery` must settle
it from the target's markers: `DONE`, still attempt 1 (no second copy), identical, no rollback snapshot left. If the apply finishes
before the kill the scenario fails with "window missed" (raise `L2B_MIB`).

### L3 throttled link, mechanics only (`l3-throttle.sh`)
`--speedtest-mib 256 --dry-run` behind the proxy at 100, 25 and 10 MB/s: a speed is measured, it never exceeds 1.5x the link, it is at
least 0.35x for links up to 25 MB/s, and `estimateSeconds` follows `size / rate + 15 min` within 40 %. Then a single ~30 MiB part at
0.25 MB/s (about 2 minutes, longer than the relay's 120 s idle limit, which must apply to a stalled socket and not a slow one)
must complete. It runs with `MIGRATION_VX_STALE_MS=900000`: see finding 1 below, a long PUT does not renew the lease. **These are loopback mechanics.** The real numbers (WAN, body caps) are Tier B; the docs' and the UI's estimate
text should be updated from measured Tier B numbers, not from this.

### L4 tar fidelity (`vx-tar-fidelity.sh`, and the `dockerit` Go test)
The migrator's stream is applied with the **pinned alpine busybox tar** the target really uses, with the exact validate / wipe /
`tar -xf -` sequence of `safeWipeExtract` (drain mode, no `--no-same-owner`). Pass: owners 999/70/1000, modes, hard link, symlinks,
long and unicode names, FIFO and every content hash survive; the wipe removes old content; a truncated archive fails. Recorded, not
failed: a lost setuid bit and the **sparse limit** (GNU tar without `-S` stores holes as zeros: content identical, the target uses the
apparent size). A failure here is a format decision, not a patch: re-test `--format=posix` only after re-testing busybox pax handling.
The same extraction runs as `agent/internal/migrate/busybox_dockerit_test.go` inside the existing `agent-docker-it` CI job (it reads
the helper-image pin from `volume-backup-script.ts`, and fails if `safeWipeExtract`'s drain extract is edited without updating it).

### L5 single file over 8 GiB (manual, not in the nightly: needs about 20 GB free; low priority for the real estate)
No file in the real data is that large: the biggest database is one volume of many files (PostgreSQL segments are 1 GiB by default), so
the real estate is not gated on L5.
```bash
docker run --rm -v lab-src:/data alpine:3.21 sh -c 'truncate -s 9G /data/huge.bin && echo marker >> /data/huge.bin'
scripts/lab/migrate.sh --arms all
```
GNU tar writes sizes over 8 GiB in base-256, busybox must read them. Pass: apply succeeds and `stat -c %s` matches. The right failure,
if it does not: the apply's validate step exits 72 "invalid archive" with the destination untouched; the fallback is refuse-with-reason
or re-testing `posix`.

### L6 PostgreSQL 16 / 17 / pgvector / 18 (`l6-postgres.sh`, `L6_IMAGE=...`)
The central gate. The images are the four the real estate runs (`postgres:16-alpine`, `postgres:17-alpine`, `pgvector/pgvector:pg17`,
`postgres:18-alpine`); a pgvector image also carries a vector table with an HNSW index, and the copied database must hold it and answer a
nearest-neighbour query. **PostgreSQL 18 stays on the logical path, where the biggest database cannot go** (L9 shows the 256 MiB cap).
A real cluster (`POSTGRES_USER=tugra`, about 200 MiB of rows) is **SIGKILLed** (exit 137, no checkpoint). 16 and 17 (PGDATA mounted at
`/var/lib/postgresql/data`): the gates pass, the copy applies, and the database the **hub itself starts** as the last step of the apply
(`postApply` provisions it and waits for `RUNNING` before the transfer is `DONE`) shows WAL replay in its logs, with the row count and
`pg_total_relation_size` equal to the values frozen before the kill. The script does not provision a second time (that recreates the
container with `docker rm -f`, a SIGKILL of its own, and the replay after it would prove nothing about the copy) and it does not run
the physical `compare.sh` on the destination (a running server owns the volume by then: byte identity of the stream is L1a's check).
The stale `postmaster.pid` the killed source leaves is asserted to exist; that the stream excludes it is the unit-tested tar argument. On 16 the negatives run
first: a running source (`volume-skipped-running`), an Alpine source against a Debian target image, a major mismatch, a started
destination; each must be refused (`refused: <the gate's own text>`, and `dest-dirty` for the started destination). 18 (volume mounted at `/var/lib/postgresql`, PGDATA one level down): the
`layout` gate must fail with exactly "PostgreSQL 18 data layout is not supported by Tugra database volumes yet", no transfer starts, and
the database stays on the logical dump path.

### L7 memory (`l7-memory.sh`)
The migrator runs under the installer's `--memory=768m --memory-swap=768m` (asserted from `docker inspect`) on incompressible data
(every member is about 128 MiB, the worst case), on zeros, and on a **real PostgreSQL heap** (`pgheap`, `L7_PGHEAP_MIB` default 1536: a
cleanly stopped data directory of an append-only time-series table, compressible pages like the biggest real database's). The real hosts
of that class have 2 CPUs and 4 GB of memory; the installer line gives the migrator no CPU limit, so that class is a Tier B run, the
memory cap being the same. `docker stats` is sampled every second and `docker events` watched for
`oom`. Pass: exit 0 (not 137), no OOM event, peak under 700 MiB (flagged above 640). `L7_MIB` (default 3072) sets the size; the peak
is per slice, so the size only needs enough parts to show steady state. The fix this lab exists to verify is below.

### L8 relay seats (`l8-relay-seats.sh`)
`L8_MIGRATORS` (2 to 4, default 2) and `L8_SEATS` (default 1) shape it; the workflow runs 2 on 1 and **4 on 2**: the real estate has 23
source hosts against one hub, so several migrators from different sources race for the seats. Each later migrator starts once the one
before it committed a part. In the default shape the hub runs with `MIGRATION_RELAY_CONCURRENCY=1` and `MOVE_MAX_CONCURRENT_RELAYS=1`. (A) Two migrator runs (two ops, two source
volumes, one target server) race for the one migration seat; the second starts only after the first committed a part (every migrator
removes all `tugra.vx=1` helper containers at its start, see finding 2). Both go through `http-tap.mjs`, which counts the hub's `busy`
answers: at least one is required (none would mean the pool was never contended), both runs end `volume-applied`, and no part failure
is logged. (B) While they stream, a deployed app with 256 MiB of data is moved to a second agent.
**This leg is observational**: both "servers" are one docker host sharing `/etc/tugra` and the docker daemon, so the move itself may fail
for topology reasons; the summary prints `MOVE: <phase>`. Only a move that makes no progress for five minutes after both migrations ended
(`STUCK-*`, starvation across pools) fails the lab. `L8_MOVE=0` skips the leg. Pool separation is recorded in `l8.summary` as
`L8_SEPARATION=shown` when the move had committed parts while the migrators were already being told `busy` (the move draws from its own
free pool), otherwise `inconclusive` (for example when the move fails for topology reasons before it copies): an observation, not a gate.

## Fleet-shaped lab (L9-L14)

The first fixture does not model the estate the guided migration must move. These scenarios and `fleet.sh` do, from facts of the real
fleet (scrubbed here: sizes, counts and shapes, no names, hosts or addresses). The data is generated on the runner; nothing big is in
git. Every row says where the fact is exercised.

| Real fact | Fixture | Where |
|---|---|---|
| The biggest database: about 32 GB, of which about 29 GB is one append-only time-series table, likely `postgres:18-alpine` | A running PostgreSQL with a generated time-series table of `pg_gib` GiB (default 4) on `postgres:17-alpine` (physical path) and `postgres:18-alpine` (layout refusal, then the capped logical dump) | L9, and Tier B step 4 at the real size |
| PostgreSQL images: 16-alpine, 17-alpine, `pgvector` 17, 18-alpine | The four-image matrix, pgvector with a vector index | L6 |
| A 1.8 GB MariaDB, and several of 250-270 MB by volume size | `mariadb:11` loaded to 120 MiB and to 1800 MiB of incompressible text | L10 |
| 14 redis 7.2, one with a custom conf | 14 redis with the password on the command line, one with a conf file; `DBSIZE` checked | L12 E |
| MinIO: 12 buckets of 3.9 GB down to a few MB, 8.8 GB in all | The same 12 size classes (`minio_div` 1 is the real shape, 4 is the default) of incompressible 32 MiB objects | L11 |
| Five of six MinIO instances on `/mnt/<attached volume>` binds, invisible to `docker system df -v` | A MinIO on a bind below `/mnt/tugra-lab-binds`; `docker system df` is asserted blind to it | L11 |
| Three hosts naming one attached-volume path | A configuration fact, only visible across hosts | Tier B (check the three mounts first) |
| Meilisearch: `latest` on six, one pinned old | A volume copy of the pinned version served by the pinned image, and `latest` opening a copy of it (recorded, not a gate) | L12 F |
| Three database containers the API does not list | A running PostgreSQL 17 no op names; every case asserts the run left it alone | L12 (the detection itself is a hub feature) |
| Volumes of removed services, no container uses them | Three orphan volumes | L12 |
| Volume owners 999, 70, 65534, 1000 | The fixture's file set | L4, every scenario |
| Sources are running containers, 24 character uuid names, `--stop-source` is the real path | `fleet_uuid`, `fleet_stamp`, running sources | L9, L11, L12, L14 |
| Two deploys of one application, an exited container with a restart history, a crash-looping one, no health checks anywhere | Cases B, C, D | L12 |
| Coolify 4.1.2: per-team read-only tokens, an unfiltered `/teams`, comma-list `fqdn` with both schemes, service sub-apps on `:8080` | The mock API | L13 (CI), Tier B step 1 (real) |
| Cloudflare: proxied, DNS-only, tunnel CNAME, a generated host, a zone outside Cloudflare | A real zone and a token | Tier B step 5 only |
| Three source hosts on Ubuntu 26.04 | The 26.04 userland | L14 (CI), Tier B (a real 26.04 VM) |

### L9 the biggest database (`l9-fleet-pg.sh`, `L9_IMAGE`, `L9_GIB`, `L9_RATE`)
A **running**, uuid-named PostgreSQL with `L9_GIB` GiB (default 4) of an append-only table (a monotonic timestamp, a symbol, two prices, a
venue and a 128 byte payload, about 190 bytes a row, a BRIN index) and two unrelated redis next to it. A plain dry run is
`volume-skipped-running`; with `--stop-source` it is `planned` / `would-stop-source` with the whole data directory in `rawBytes`, and still
nothing is stopped.
- **17**: `--arms all --stop-source` stops only the source, applies the volume, the database the hub starts holds the frozen row count and
  `pg_total_relation_size`, no other container on the host changed (bar that database), no helper or staged part is left. The copy time
  goes to `l9.summary` (`L9_COPY_SECONDS`): the first real measurement of stop, stream, apply and start together. `L9_RATE=<MB/s>` sends
  it through the throttle proxy: the "L1c" run of the big database on a slow link.
- **18**: the `layout` gate refuses with its exact text **after** the migrator stopped the source, and the migrator **restarts** it (asserted:
  the source is running again). The lane the gate leaves is the logical dump: a second op in `--data-mode dump` runs `--arms databases` and
  fails `dump-too-big` (the hub's artifact cap is 256 MiB of gzip). **That is a finding, not a bug in the lab: a PostgreSQL 18 database
  over the cap has no automatic lane.** When the physical gate learns the 18 layout, this case turns green by changing its expectation, in
  the same commit.

Size. The data is loaded in 1M-row batches (about 10-15 minutes for 4 GiB). Disk is about 3.5 times the data (source, staged parts,
destination), so a standard runner holds about 4-6 GiB. The real size (about 31 GiB) needs a larger runner or Tier B step 4: set `pg_gib`
to 30 on a runner with 120 GB of free docker disk.

### L10 MariaDB against the cap (`l10-fleet-mariadb.sh`, `L10_UNDER_MIB`, `L10_OVER_MIB`)
MariaDB has no physical lane, so every MariaDB is the logical dump, capped at 256 MiB of gzip. A running, uuid-named `mariadb:11` on
`--arms databases` (which never stops the source): a small database is planned by `--dry-run`; the same data with `--max-gz-bytes 32 MiB`
is `dump-too-big`; with the default cap the dump and the upload go through (the restore leg needs a provisioned target database, which
the lab seeds without a container, so only the upload is asserted); then the database grows to the real 1.8 GB class and the default cap
refuses it, `dump-too-big`, nothing uploaded, source untouched. The point it pins: **the dump size decides, the volume size does not**
(several real MariaDBs sit just under 256 MiB by volume size and have a smaller dump), and the 1.8 GB one has no automatic lane.

### L11 MinIO on a bind mount (`l11-fleet-minio.sh`, `FLEET_MINIO_DIV`)
A running MinIO whose `/data` is a host directory, with the 12 real bucket size classes. (1) `docker system df` does not grow with the
bind data (asserted: under a tenth of it); a plain dry run is `volume-bind-refused` with no size; a bind of a system path stays refused
even under `--allow-bind`. (2) `--dry-run --allow-bind` on the running source is `volume-skipped-running`; with `--stop-source` it plans
and reports the real bytes: **the size of a bind-mounted volume only becomes known with `--allow-bind`**, which is why a sizing step
cannot use the plain inventory. (3) `--allow-bind --stop-source` copies it; `compare.sh` against the bind is identical; and a second
MinIO on the **destination volume** lists all 12 buckets with the object counts the source has and an empty `mc diff` per bucket.

### L12 source hosts (`l12-fleet-hosts.sh`)
The host around the sources: 3 unrelated application containers, 14 redis (13 plain and one with a custom conf file), an unlisted
PostgreSQL 17 with rows, and 3 orphan volumes. Then, each asserting that **nothing else on the host was stopped, started or removed**:
**A** an application `<uuid>-<13 digits>` that is running (owners 999/70/65534/1000 in its volume): `volume-skipped-running`,
`would-stop-source`, then the real `--stop-source` run applies the volume identically and leaves that one container stopped.
**B** two deploys of one application: `failed` / `ambiguous`, neither is stopped. **C** an exited container with a restart history (a
crashed service that never came back): copied without starting or stopping anything. **D** a crash-looping `restart: always` container:
`volume-skipped-running`, then applied with `--stop-source`, and it stays stopped (the restart policy does not undo the stop). **E** the
two kinds of redis: the dry run discovers both, `DBSIZE` is unchanged. **F** Meilisearch pinned to an old version and `latest`: the
pinned image serves the copied volume (500 documents); whether `latest` opens a copy of it is recorded in `l12.summary`
(`L12_MEILI_LATEST_OPENS`), because version drift between instances is a finding, not a pass/fail. `L12_MEILI=0` skips F.

### L13 discovery against Coolify 4.1.2 (`l13-fleet-coolify.sh`)
The mock API on the docker host address (the hub's SSRF guard refuses loopback). For each of the 8 team tokens the hub connects and
plans, and the plan counts exactly that team's applications and databases, with every item named after the team: a token's scope is the
token, **never `/teams`**, which is unfiltered. An unknown token is refused. This does not prove what a real 4.1.2 does; it proves the
hub reads the shape the owner's inventory shows. The real instance is Tier B step 1.

### L14 Ubuntu 26.04 (`l14-ubuntu-source.sh`)
The job runs on `ubuntu-latest` (24.04 at the time of writing): a runner label for 26.04 is not assumed to exist, and a job on a label
that does not exist never starts. So it runs the **26.04 userland**: the two installers run inside `ubuntu:26.04` (its sh, its
coreutils, which recent Ubuntu releases take from the Rust rewrite, its curl) plus a static docker client, against the runner's docker
socket (`LAB_INSTALLER_IMAGE` in `migrate.sh`). When a 26.04 runner label exists, pointing the job's `runs-on` at it makes the same
script a real-host test. It asserts that both installer scripts parse under that sh,
that the agent installer brings a real agent ONLINE, and that the migrator the installer starts moves a volume (a stopped source, then a
running uuid-named one with `--stop-source`). `l14.summary` records the OS, `/bin/sh`, coreutils, curl and docker client versions. If
`ubuntu:26.04` cannot be pulled the job falls back to `ubuntu:24.04`, says so in a workflow warning, and writes `L14_UBUNTU=fallback`:
R31 is then still open. **What it cannot prove**: the 26.04 kernel and its docker engine and cgroup defaults; that is a real 26.04 VM
(Tier B, below).

### What the fleet-shaped lab pins for the guided migration
1. **The biggest database has an automatic lane only on PostgreSQL 16 and 17** (L9). On 18 the layout gate refuses and the logical dump is
   over the cap. Which version it runs is an owner fact, asked before the wave that contains it.
2. **A MariaDB over 256 MiB of dump has no automatic lane** (L10), and the 1.8 GB one is over it.
3. **Volume size is not dump size** (L10): decide on the dump.
4. **Bind-mounted data is invisible to docker's inventory** (L11) and only `--allow-bind` measures it. Its size feeds the downtime window.
5. **A running source is the normal case** (L12): `--stop-source` stops exactly one container, an ambiguous pair is refused untouched, a
   crash-looping one is stopped for good by the stop, and the restart of a source the migrator stopped for a refused copy is asserted
   (L9, 18).
6. **A token is a scope, `/teams` is not** (L13).
7. **Ubuntu 26.04** (L14): the userland is tested in CI, the kernel and engine are Tier B.

## The two risks the runbook found, and what changed

1. **Migrator memory.** `produce()` held a 128 MiB raw slice plus two member `bytes.Buffer`s that were never pre-sized. On
   incompressible data a member is about 128 MiB; an unsized buffer fills by repeated append growth (measured about 1.1x: a 128 MiB
   member ended at a ~144 MiB capacity, an 8 MiB one at 9 MiB), with the old and the new backing array alive together at every step.
   The pre-size is a modest saving. The real overrun risk is the Go GC overshoot: with no memory limit the heap is allowed to
   run to about twice the live set, against a 768 MiB cgroup with no swap (an OOM kill, exit 137, with no message).
   `StreamVolume` therefore installs `debug.SetMemoryLimit(600 MiB)` once per process (unless the operator exported `GOMEMLIMIT`), so
   the collector works before the cgroup limit; that is the change that matters, and `memberWriter.compress` additionally `Grow`s the
   output buffer once to a worst-case bound (`memberBound`: n + n/256 + 1 KiB), `Reset` keeping the capacity, so the two pooled buffers
   are one allocation each and never reallocate after the first slice. The live set is about three slices plus a few MiB. Unit tests:
   `TestCompressPreSizesTheMemberBuffer` and `TestCompressGrowsALargerSliceInOneStep` are the strict ones (they fail without the `Grow`
   line: capacity 9 MiB instead of the bound for an 8 MiB member), the bound against real members, the limit installation and its
   `GOMEMLIMIT` precedence, and an end-to-end incompressible 6 x 16 MiB stream whose live-heap growth must stay under 3 slices + 8 MiB.
   That heap test is only a gross-regression guard (about 50 MiB with the change, about 54 MiB without, inside GC timing noise).
   L7 is the proof at the real 128 MiB size, under the real 768 MiB limit.
2. **Busybox apply.** `safeWipeExtract` extracts with `alpine:3.21` busybox `tar`; the unit specs stub docker and the old `dockerit`
   test extracted with GNU tar. L4 above closes it, in CI through `agent-docker-it` and as a standalone script.

## Findings the lab surfaced (product, not harness)

1. **A long part PUT does not renew the transfer's lease.** The hub bumps `lastBeatAt` on `begin`, on a part `commit`, on `finish` and on
   a beat; `registerPart` and the relay PUT never touch it, and the migrator beats only while it is skipping an already-committed prefix
   (`ResumeFromPart > 0`). `VxRecoveryService.sweep()` runs at boot and every 60 s and fails every `COPYING` transfer whose
   `lastBeatAt` is older than `MIGRATION_VX_STALE_MS` (default 300 s, minimum 30 s), cancelling the part in flight. So a single part must
   transfer in under the stale window: with the default, a 32 MiB part is lost on a link slower than about 0.11 MB/s (a 5.3 minute PUT),
   a 128 MiB part below about 0.45 MB/s. The part sizes are chosen against that, but nothing enforces it. Candidate fix, for the owner: renew
   the lease from `registerPart` and from the relay's byte progress. The lab does not hide it: L3's boundary run sets a 15 minute window
   explicitly.
2. **`reapStaleHelpers` is not run-scoped.** Every migrator removes all containers labelled `tugra.vx=1` when it starts, including the
   live inventory and tar helpers of another migrator on the same docker host, which ends that run as `inventory helper failed` or a tar
   failure. Two concurrent migrators on one host (one per volume, or two operators) can hit it. A run-id label is not enough on its own: a
   dead run's helper and a live one both carry a foreign run id, so a fix needs a liveness test (for example the owning migrator
   container still running). L8 staggers its second migrator to stay out of it.

## Not covered here

- **Tier B for this fleet** (below): the parts no single docker host can show.
- **Cloudflare**: proxied, DNS-only, tunnel CNAME and generated-host records, and a zone outside Cloudflare, need a real zone and a token.
- The owner's real fleet: a read-only `--dry-run` there needs the owner's explicit go (it is the first step of the first real wave, and
  the prerequisite for the unlisted-database cross-check and the per-host capability matrix).
- A sparse-file-preserving copy (the spec's documented limit), xattrs, ACLs, file capabilities, sockets and sub-second mtimes.

## Tier B rehearsal for this fleet

Hub and target: the public demo hub (beta.17 or later), a fresh test team, `MIGRATION_VX_PART_MIB=32` if a body cap appears. Every step
uses throwaway machines; nothing touches the real fleet. On every rehearsal source the sequence is: `--dry-run` first (L0, the real
same-device `Disk: ok` question), `--speedtest-mib 512` (the real L3 number), `--stop-source` with 2 GiB, then the big volume, then
`compare.sh`; behind Cloudflare try the default 128 MiB part and watch for a 413 (the documented answer is `MIGRATION_VX_PART_MIB=32`).
The import op comes from the real Coolify through the wizard (most real: it tests container naming), or from `seed.mjs` run inside the
hub container.

1. **A real Coolify 4.1.2 on a throwaway VM**, pinned (pass the version to the installer and confirm it in the settings page), managing two
   more VMs: a backend (an api, PostgreSQL, redis, Meilisearch, a MinIO on a bind mount) and a frontend. That is the shape of the
   smallest teams (three hosts). It brings real container naming, per-team read-only tokens and the access model where **SSH works only
   from the Coolify host**, so the one script that loops over the source hosts from that host is exercised too.
2. Run a full `copy` with the `two-box` coexistence twice. Chaos: kill the hub at each step boundary, kill the migrator mid-volume,
   throttle the link.
3. Abort at every step before the point of no return with a loop that records Coolify's availability; then one reverse after it.
4. Add a VM with an attached volume. Run a **30 GB PostgreSQL 17 volume** (physical) and a **30 GB PostgreSQL 18 volume** (the
   refusal), a 1.8 GB MariaDB, and a 12-bucket MinIO of about 8.8 GB on a bind (`pg_gib=30`, `minio_div=1`, on a runner with 120 GB of
   disk if one is available). Record, per volume: stop, transfer, apply, start. **The estimates of the downtime window disagree by up to
   six times** (about 15 minutes per 30 GB of extract against an apply of two hours for 29 GiB in the specs): the measured numbers
   replace them, and the L3 throttle numbers (`L9_RATE`) are only mechanics.
5. DNS: a Cloudflare test zone with a proxied record, a DNS-only record, a tunnel CNAME and a Coolify-generated host, and a second zone
   outside Cloudflare to exercise the acknowledged HTTP-01 gap. Check the three hosts that name one attached-volume path first.
6. Capture the measured transfer, apply, build, certificate-issue and verify times.
7. A 26.04 VM as a source (L14's kernel and engine half), and a 2 CPU / 4 GB source for L7's CPU class.
8. **Dokploy** is a separate rehearsal, after its importer exists: a swarm VM with MySQL 8.4 and `--mysql-native-password=ON`, a compose
   project with a `network_mode: host` service, and five different volume owners.

The first real wave starts with the read-only `--dry-run` on every host, then the smallest team (a stateless frontend host first, which
exercises the flip machinery with the least data risk), and ends with the biggest database last.
