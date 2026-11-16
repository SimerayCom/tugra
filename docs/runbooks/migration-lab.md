# Migration lab (volume stream, L0-L16)

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
**L15 and L16** are the data-plane legs for the databases the owner's `largeDbMode` `stream-logical` carries: the streamed dump lane
(PostgreSQL and MariaDB, the hub killed mid-dump) and PostgreSQL with `sslmode=require`. They, like the physical copies of L6 and L9,
prove **data integrity**, not row counts: see "Data integrity" below.

The harness was written without a docker daemon on the author's machine, so a red lab is a finding first and a harness bug second
(the scripts print the migrator log, the hub log is an artifact). "Lab history" below records what each run found and which of it was the
harness: read it before trusting or distrusting a red job.

## Lab history

| Run | What it showed |
|---|---|
| 1 and 2 (16 Nov 2026) | Every real part upload failed (`part-failed`; run 2 reported `part-failed: hub 417`). Nothing past L0 was exercised. |
| 3 (workflow run 43900939706, commit `8e5019dc`, the first with the relay fix) | The relay moves parts. Green: L0, L1a, L2, L3, L4, L7, L8 (both shapes), L9 on 17 and on 18 (the layout refusal and `dump-too-big`), L13, L14, L6 on 18. Red, with the cause: **L6 on 16, 17 and pgvector** (a harness assertion, below), **L10** (a harness bug, below), **L11** (the MinIO image could not be pulled), **L12 E** (a harness check, below) and **L1b** (not explained, below). |

**The 417 finding (product, fixed in `8e5019dc`).** The migrator's part upload (`VxPutPart`, `agent/internal/migrate/vxclient.go`) did
`req.Header.Set("Expect", "")`. Go sends a header with an empty value rather than none, and the hub (Node) answers an empty `Expect`
with `417 Expectation Failed`. So **every part PUT through the relay failed from the first byte**, in every scenario that reaches a
relay, and the unit specs could not see it because they fake the hub. The lab found it the first time a real part crossed a real hub;
the fix removes the header. L1a, L2, L8 and L9 are the scenarios that prove it on the wire.

**What run 3's red jobs were (harness unless said):**

- **L6 on 16, 17, pgvector: `pg_total_relation_size equals the source`.** The copy, the WAL replay, the row count and the pgvector table
  all passed; the size was 234553344 B on the source and 234627072 B on every copy (nine 8 KiB pages: hint bits, visibility-map and
  free-space pages written by crash recovery and by the destination's own start). A byte size after a SIGKILL is not an invariant. The
  assertion is replaced by a fingerprint: the row count plus a checksum over every column of every row, the extensions, sequences,
  collation, roles, ownership and grants (below). The size is logged.
- **L10: `run over: item state is 'already-restored'`.** The first op (`under`) restored its database (the hub starts the destination
  and restores into it), and the `over` run reused that op, so the hub answered `already-restored` before any dump. The over-cap case
  now runs on a fresh op, and the `under` restore is asserted (rows and fingerprint), which the old comment said could not be done.
- **L11: `pull access denied for minio/minio`.** Docker Hub no longer serves `minio/minio` or `minio/mc`. The server is the same
  release (`2025.4.22`) from the frozen `bitnamilegacy/minio` archive, pinned by digest and run with its own `minio` binary as
  entrypoint as root; the `mc` client is the one the agent image vendors (`--entrypoint mc <lab image>`), so there is no second image.
  `FLEET_MINIO_IMAGE` and `FLEET_MC_IMAGE` override both, and a pull that cannot succeed now names the image (`fleet_pull`). The new
  image has not been pulled by the author (no docker daemon): the next run is its first.
- **L12 E: `nothing else on the host was stopped, started or removed`.** The real logical run of a redis restores into a destination
  database the hub starts (`tugra_db_<id>`), which the snapshot saw as a change. E now names those containers as the case's own.
  (The check still fails for any source container that changed.)
- **L1b: `run first did not finish within 120s`** after `docker kill --signal KILL` of the migrator at part 4 of 8. The proxy log shows
  the kill landed (one connection ended at about 640 MiB uploaded). **The cause is not established**: the log has no error, and no
  docker was available to reproduce. Two changes bound the possible suspects: `migrate.sh` no longer ends with an unbounded `wait` (it
  waited for the stderr tee, which any stray descendant holding the pipe would keep alive; it now waits at most 5 s for the log to
  drain), and a `lab_run_wait` timeout prints the live processes (`migrate.sh`, the installer, `docker run/kill/rm`, the tee) and the
  containers. If L1b is red again, those two blocks in the job log name the holder. `lab_kill9_migrator` also kills by name, waits a bounded time (`LAB_KILL_REAP_TICKS`, 20 s) for the run's installer-side `docker run` client to exit, kills a client that does not, and removes the container by name, logging whatever it had to force, so a stuck client is visible and can no longer be what the scenario waits on.

**A product bug seen in run 3's hub log (not a lab failure).** `container-health.runner.service.ts` line 235 builds
`containerName: { notIn: liveNames.length ? liveNames : ["\u0000"] }`: when a server reports no containers the sentinel is a NUL
character, which PostgreSQL rejects (`invalid byte sequence for encoding "UTF8": 0x00`), so the container-health check of that server
fails every minute for as long as it has no containers (a freshly enrolled host, or one with every container removed).

## Running it

**CI (the normal way).** Actions, *Migration lab (vx)*, *Run workflow*. `items` is `all` or a comma list of
`tar, core, restart, postgres, memory, seats, throttle, fleetpg, fleetdb, fleetminio, fleethosts, fleetcoolify, ubuntu, streamdump, pgtls`,
or `fleet` for the six fleet-shaped ones (`fleetpg` to `ubuntu`) or `stream` for `streamdump` and `pgtls`. It also runs nightly (all of
them). Each item is its own job on a fresh `ubuntu-latest` runner; logs (`hub.log`, `run.*.log`, `run.*.json`, `mem.*.log`, `*.summary`,
the integrity fingerprints `*.fp.*`, compare diffs, agent log) are uploaded as the `vx-lab-*` artifact. Two dispatch
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
| `fleetpg` | L9, one job per image (`postgres:17-alpine`, `postgres:18-alpine`) | the full lab, about 3.5 x `pg_gib` of disk (source, staged parts, destination): 15 GiB at the default 4; the 18 job adds a streamed copy of the same source (about 4 GiB more) |
| `fleetdb` | L10 | the full lab, about 4 GiB, and about 4 GiB more for the streamed copy of the 1.8 GB database |
| `fleetminio` | L11 | the full lab, about 3 x the bucket total on `/mnt` and `/` (about 7 GiB at the default `minio_div` 4) |
| `fleethosts` | L12 | the full lab, about 3 GiB, 25 containers |
| `fleetcoolify` | L13 | the full lab (hub only; the mock is a node process) |
| `ubuntu` | L14 | the full lab, the `ubuntu:26.04` and `docker:27-cli` images |
| `streamdump` | L15, one job per image (`postgres:17-alpine`, `pgvector/pgvector:pg17`, `postgres:18-alpine`, `mariadb:11`) | the full lab, about 3 x `L15_MIB` (default 384) of disk |
| `pgtls` | L16, one job per image (`postgres:16-alpine`, `postgres:17-alpine`, `postgres:18-alpine`, `pgvector/pgvector:pg17`) | the full lab, a few hundred MiB |

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
| `compare.sh` | `ARCHIVE-IDENTICAL` (sha256 of the same GNU tar stream over both volumes) or a field-level busybox `stat` plus content-hash diff naming the exact entry and field. A difference only in directory mtimes prints `DIR-MTIME-ONLY` (the extractor decides those; `COMPARE_STRICT=1` makes it fail). That verdict is taken from the `tar -tv` listing with only directory and symlink mtimes masked (`tarlist.sh`), never from the manifest being empty, so a wrong volume-root owner or mode, a lost setuid bit, or a changed FIFO mtime is `ARCHIVE-DIFFERS`. Symlink mtimes are a documented non-copy: the first lab run (16 Nov 2026) showed busybox tar sets a restored symlink's mtime to the extraction time (it has no `lutimes`), and no application reads a symlink's own mtime. |
| `manifest.sh` | The per-entry manifest `compare.sh` uses: the volume root `.`, full 4-digit modes, owner, size, link count, content hash, file and special-file mtimes (symlink mtimes are a documented non-copy); directory mtimes only with `DIR_MTIME=1`. |
| `tarlist.sh` | The masked tar listing behind `DIR-MTIME-ONLY`. |
| `scope.mjs`, `seed.mjs ids` | Which volumes and staging dirs the lab owns (ids in the lab hub's database), used by `down.sh` and scenario cleanup. |
| `http-tap.mjs` | Pass-through to the hub that counts `{"busy":true}` answers to part registrations (L8). |
| `integrity.sh` | Data-integrity fixtures and fingerprints for PostgreSQL and MariaDB (below), sourced by L6, L9, L10, L15 and L16. |
| `stream.sh` | The streamed dump lane as the lab drives it: the measuring dry run, the `volume-applied` expectation (a refused PostgreSQL 18 destination is named as a product finding), the destination the hub started. Sourced by L9, L10, L15, L16. |
| `fleet.sh` | The fleet-shaped fixtures, sourced by L9-L16. Coolify-style names (`fleet_uuid`: 24 characters, `fleet_stamp`: the 13 digit deploy suffix), a running PostgreSQL with a multi-GB append-only time-series table (`fleet_pg_load_ticks`), a running MariaDB (`fleet_mariadb_load`), a MinIO with the 12 real bucket size classes on a host bind (`fleet_minio_plan`, `fleet_minio_fill`), redis with a password on its command line and a custom conf, orphan volumes, `fleet_snapshot_others` (the blast-radius check), `fleet_pull` (a pull with retries that names the image it could not get) and `fleet_cleanup`. Everything it creates carries the docker label `tugra.lab.fleet=1` and `down.sh` removes exactly that. |
| `units.mjs` | Docker's decimal human sizes (`2.147GB`) as bytes, to compare `docker system df` with what is really on disk. |
| `seed-mode.mjs` | The engine and data lane a seeded op uses: `--kind db` is a PostgreSQL physical copy by default, `--data-mode dump` is the logical arm (its ITEMREF is the database ref), `--data-mode stream` puts the database on the streamed dump lane through `BulkOperation.meta.vxStream` (what DATA_SEED writes; its ITEMREF is `volume:_:<ref>:dump`; PostgreSQL, MariaDB and MySQL), and every engine but PostgreSQL is logical only. `seed.mjs op --ssl` makes the destination PostgreSQL serve TLS. |
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
A real cluster (`POSTGRES_USER=tugra`, about 200 MiB of rows) is **SIGKILLed** (exit 137, no shutdown checkpoint: the data directory is "not properly shut down" and the destination runs crash recovery). One explicit `CHECKPOINT` runs after the source fingerprint and just before the kill, so no WAL newer than the last checkpoint exists to be redone: PostgreSQL logs a serial's value 32 ahead in the WAL, and redoing such a record moves `last_value` (250 to 264 on a plain 15) with no row changed, which a sequence comparison would read as a loss. 16 and 17 (PGDATA mounted at
`/var/lib/postgresql/data`): the gates pass, the copy applies, and the database the **hub itself starts** as the last step of the apply
(`postApply` provisions it and waits for `RUNNING` before the transfer is `DONE`) shows WAL replay in its logs, with the **fingerprint**
(row count plus a checksum over every column of every row, the extensions, the sequences' `last_value`, the collation, and, because a
physical copy carries the whole cluster, the roles, the table ownership and the grants) equal to the one taken before the kill.
`pg_total_relation_size` is logged, not compared: crash recovery legitimately moves it (lab run 3). The script does not provision a second time (that recreates the
container with `docker rm -f`, a SIGKILL of its own, and the replay after it would prove nothing about the copy) and it does not run
the physical `compare.sh` on the destination (a running server owns the volume by then: byte identity of the stream is L1a's check).
The stale `postmaster.pid` the killed source leaves is asserted to exist; that the stream excludes it is the unit-tested tar argument. On 16 the negatives run
first: a running source (`volume-skipped-running`), an Alpine source against a Debian target image, a major mismatch, a started
destination; each must be refused (`refused: <the gate's own text>`, and `dest-dirty` for the started destination). 18 (volume mounted at `/var/lib/postgresql`, PGDATA one level down): the
`layout` gate must fail with exactly "PostgreSQL 18 data layout is not supported by Tugra database volumes yet", no transfer starts, and
the database stays on the logical dump path (or the streamed lane, L15).

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
source hosts against one hub, so several migrators from different sources race for the seats (here they share one docker host, there
each has its own). The migrators are all started **together**: the tap holds each one's `GET targets` (its last hub call before its
start-up removes helper containers) until all of them asked, then releases them at once. A stagger would be wrong, see finding 2.
In the default shape the hub runs with `MIGRATION_RELAY_CONCURRENCY=1` and `MOVE_MAX_CONCURRENT_RELAYS=1`. (A) Two migrator runs (two ops, two source
volumes, one target server) race for the one migration seat. Every migrator removes ALL `tugra.vx=1` helper containers on its docker
host when it starts, so the barrier makes every removal run before any migrator has created a helper; that narrows the window to the
spread between the removals and does not close it (finding 2). A run that ends with `tar-failed` or `inventory helper failed` is
reported as a probable collision with finding 2, not as a seat problem. All of them go through `http-tap.mjs`, which counts the hub's `busy`
answers: at least one is required (none would mean the pool was never contended), both runs end `volume-applied`, and no part failure
is logged. (B) While they stream, a deployed app with 256 MiB of data is moved to a second agent.
**This leg is observational**: both "servers" are one docker host sharing `/etc/tugra` and the docker daemon, so the move itself may fail
for topology reasons; the summary prints `MOVE: <phase>`. Only a move that makes no progress for five minutes after both migrations ended
(`STUCK-*`, starvation across pools) fails the lab. `L8_MOVE=0` skips the leg. Pool separation is recorded in `l8.summary` as
`L8_SEPARATION=shown` when the move had committed parts while the migrators were already being told `busy` (the move draws from its own
free pool), otherwise `inconclusive` (for example when the move fails for topology reasons before it copies): an observation, not a gate.

## Fleet-shaped lab (L9-L16)

The first fixture does not model the estate the guided migration must move. These scenarios and `fleet.sh` do, from facts of the real
fleet (scrubbed here: sizes, counts and shapes, no names, hosts or addresses). The data is generated on the runner; nothing big is in
git. Every row says where the fact is exercised.

| Real fact | Fixture | Where |
|---|---|---|
| The biggest database: about 32 GB, of which about 29 GB is one append-only time-series table, likely `postgres:18-alpine` | A running PostgreSQL with a generated time-series table of `pg_gib` GiB (default 4) on `postgres:17-alpine` (physical path) and `postgres:18-alpine` (layout refusal, the capped artifact route under the default policy, then the streamed lane) | L9, and Tier B step 4 at the real size |
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
  the fingerprint of the 4 GiB table and of the integrity objects (a checksum over every column, extensions, sequences, collation, roles,
  ownership and grants; the size is logged and no longer compared), no other container on the host changed (bar that database), no helper
  or staged part is left. The copy time
  goes to `l9.summary` (`L9_COPY_SECONDS`): the first real measurement of stop, stream, apply and start together. `L9_RATE=<MB/s>` sends
  it through the throttle proxy: the "L1c" run of the big database on a slow link.
- **18**: the `layout` gate refuses with its exact text **after** the migrator stopped the source, and the migrator **restarts** it (asserted:
  the source is running again). The lane the gate leaves is the logical dump: a second op in `--data-mode dump` runs `--arms databases` and
  fails `dump-too-big` (the hub's artifact cap is 256 MiB of gzip): **that is the DEFAULT policy (`largeDbMode` `refuse`), and it stays the
  expectation.** The lane for exactly this database is `stream-logical`: a fresh op in `--data-mode stream` on the same running source
  (never stopped, asserted by its `StartedAt`) runs `--arms volumes`, with a measuring dry run first. The destination the hub starts is
  compared by fingerprint (`L9_STREAM=0` skips the leg; the copy time is `L9_STREAM_SECONDS`). **Until the hub keeps a PostgreSQL 18
  destination (`vx-dest-gate.ts` `dumpDestLayout` refuses it), this leg fails with a `PRODUCT FINDING` line naming that gate**: the
  lab does not work around it.

Size. The data is loaded in 1M-row batches (about 10-15 minutes for 4 GiB). Disk is about 3.5 times the data (source, staged parts,
destination), so a standard runner holds about 4-6 GiB. The real size (about 31 GiB) needs a larger runner or Tier B step 4: set `pg_gib`
to 30 on a runner with 120 GB of free docker disk.

### L10 MariaDB against the cap (`l10-fleet-mariadb.sh`, `L10_UNDER_MIB`, `L10_OVER_MIB`)
MariaDB has no physical lane, so every MariaDB is the logical dump, capped at 256 MiB of gzip. A running, uuid-named `mariadb:11` on
`--arms databases` (which never stops the source): a small database is planned by `--dry-run`; the same data with `--max-gz-bytes 32 MiB`
is `dump-too-big`; with the default cap the dump and the upload go through and the hub restores into the database it starts, which is
compared by fingerprint (rows with a column checksum, AUTO_INCREMENT, charset and collation); then the database grows to the real 1.8 GB
class and the default cap refuses it on a **fresh op** (`dump-too-big`, nothing uploaded, source untouched; the first op is restored, and a
second run on it would answer `already-restored`). The point it pins: **the dump size decides, the volume size does not** (several real
MariaDBs sit just under 256 MiB by volume size and have a smaller dump), and the 1.8 GB one has no automatic lane **under the default
policy**. With `stream-logical` it has one: the same running database on the streamed lane (`--data-mode stream`) is dumped in parts,
restored, and compared by fingerprint, the source never stopped (`L10_STREAM=0` skips the leg).

### L11 MinIO on a bind mount (`l11-fleet-minio.sh`, `FLEET_MINIO_DIV`)
A running MinIO whose `/data` is a host directory, with the 12 real bucket size classes. The image is `bitnamilegacy/minio:2025.4.22`
pinned by digest (the same release as the real estate's `RELEASE.2025-04-22`; `minio/minio` is no longer pullable) and the client is the
agent image's `mc` (see "Lab history"). (1) `docker system df` does not grow with the
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
two kinds of redis: a dry run only plans them (it never touches docker); the real logical run finds the password on the command line,
dumps the running instance and uploads it (bytes above zero, no credentials skip), and `DBSIZE` is unchanged; the destination redis the hub
starts for that restore is named as the case's own container, nothing else on the host may change. **F** Meilisearch pinned to an old version and `latest`: the
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

### L15 the streamed dump lane (`l15-stream-dump.sh`, `L15_IMAGE`, `L15_MIB`, `L15_RATE`)
`L15_IMAGE` is `postgres:17-alpine`, `pgvector/pgvector:pg17`, `postgres:18-alpine` or `mariadb:11`. A running, uuid-named source with
`L15_MIB` (default 384) of data and the integrity objects is moved by the lane the owner's `largeDbMode` `stream-logical` selects (the op
is put on it through `meta.vxStream`, as DATA_SEED does): the measuring dry run plans `would-stream-dump`, then the migrator runs the pinned
dump recipe inside the source (never stopped) and relays 32 MiB parts behind the throttle proxy, so a part in flight is a window. **The hub
is killed (SIGKILL) while the dump is in flight**, stays down 15 s and is started again with a stale window that outlives the outage; the
migrator rides it (`--hub-outage-wait`) and the run ends `volume-applied`. The destination the hub started must hold the same rows and the
same strict fingerprint; the access objects are compared and recorded (below). The source is asserted untouched (same `StartedAt`), no
helper or migrator container is left, and nothing else on the host changed. The summary carries the copy time, the parts and the staged
parts left after the restore.
**The 18 leg is expected red today** with a `PRODUCT FINDING` line: the hub refuses a streamed dump into a PostgreSQL 18 destination, because
Tugra mounts the database volume at the pre-18 data path (`database-script.ts`), so the restored cluster would sit outside the named volume.
The gate is `importer/volume-stream/vx-dest-gate.ts` `dumpDestLayout`, called from `vx.service.ts` `begin` and `vx-apply.service.ts`
`runDumpApply`. When provisioning keeps the cluster and the gate is lifted, this job and L9's streamed leg turn green with no change.

### L16 PostgreSQL TLS (`l16-pg-tls.sh`, `L16_IMAGE`)
`L16_IMAGE` is 16, 17, 18 or pgvector 17. **A**: a fresh destination with `Database.ssl` (what the importer sets from a `sslmode=require`
source), provisioned through the hub's own route. The server reports `ssl = on`, the self-signed pair exists on the host (key 0600,
directory 0700), a client with `sslmode=require` connects from inside the container **and from a second container on the destination's
docker network**, `pg_stat_ssl` says both sessions are encrypted and carry a TLS version, rows written over TLS read back, and
`sslmode=verify-ca` is refused (the pair is self-signed: a CA the client trusts is a manual step). A pgvector image also creates its
extension and answers a nearest-neighbour query over TLS. **B**: the same kind of destination receives a database through the streamed lane
(L15's source and checks) and is read back over `sslmode=require`: the strict fingerprint is equal. B is skipped on 18 for the reason in L15
and the skip is written to `l16.summary` (`L16_RESTORE=skipped-pg18-destination-refused`), not hidden.

### Data integrity (`integrity.sh`)
A row count proves rows arrived, not that the database means the same on the target. L6, L9, L10, L15 and L16 compare a **fingerprint**
read with the same queries from the source and the destination: **strict** facts must be equal (the row count and a checksum over every
column of every row, the extensions, the sequences' `last_value`, the collation of the database and of an explicitly collated column,
MariaDB's AUTO_INCREMENT, charset and collation, the pgvector table and its HNSW index) and **access** facts (PostgreSQL roles, the owner of
a table and its ACL; MariaDB users, schema grants and stored routines) which a physical copy must carry (L6, L9: strict) and which the
dump lanes are recorded to drop. The fixtures seed `lab_app` (a login role that owns a table), `lab_ro` (selected on it), a sequence
moved to 7777, a serial at 250, a `COLLATE "C"` column, and for MariaDB two users with grants, a `latin1_bin` column and a stored function.
Run against a real PostgreSQL 15 with the recipe's own `pg_dump -Fc -Z0 --no-owner --no-acl`, the strict facts are equal and the owner
and ACL of `lab_own` are not: **that is a product finding, the dump lanes do not carry them**. `L_INTEGRITY_ACCESS=require` makes it a failure.

### What the fleet-shaped lab pins for the guided migration
1. **The biggest database has an automatic physical lane only on PostgreSQL 16 and 17** (L9). On 18 the layout gate refuses the copy and
   the artifact route is over the cap; the lane for it is `stream-logical` (L9, L15), which today refuses a PostgreSQL 18 destination
   (see L15). Which version it runs is an owner fact, asked before the wave that contains it.
2. **A MariaDB over 256 MiB of dump has no automatic lane under the default policy** (L10), and the 1.8 GB one is over it; `stream-logical`
   carries it (L10, L15).
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

0. **The relay answered every part PUT with `417` (fixed in `8e5019dc`)**: see "Lab history".

1. **A long part PUT does not renew the transfer's lease.** The hub bumps `lastBeatAt` on `begin`, on a part `commit`, on `finish` and on
   a beat; `registerPart` and the relay PUT never touch it, and the migrator beats only while it is skipping an already-committed prefix
   (`ResumeFromPart > 0`). `VxRecoveryService.sweep()` runs at boot and every 60 s and fails every `COPYING` transfer whose
   `lastBeatAt` is older than `MIGRATION_VX_STALE_MS` (default 300 s, minimum 30 s), cancelling the part in flight. So a single part must
   transfer in under the stale window: with the default, a 32 MiB part is lost on a link slower than about 0.11 MB/s (a 5.3 minute PUT),
   a 128 MiB part below about 0.45 MB/s. The part sizes are chosen against that, but nothing enforces it. Candidate fix, for the owner: renew
   the lease from `registerPart` and from the relay's byte progress. The lab does not hide it: L3's boundary run sets a 15 minute window
   explicitly.
2. **`reapStaleHelpers` was not run-scoped (fixed).** Every migrator used to remove all containers labelled `tugra.vx=1` when it
   started, including the live inventory and tar helpers of another migrator on the same docker host. Helpers now carry
   `tugra.vx.owner=<migrator container id>` and the reaper skips any helper whose owner container is still running; helpers of a dead
   or unlabelled owner are still removed. L8 keeps its start barrier, which is now belt and braces rather than the only guard.

3. **The dump lanes drop roles, ownership, grants, users and stored routines** (L15, L10, L16, `integrity.sh`): `pg_dump` runs with
   `--no-owner --no-acl` (`agent/internal/migrate/recipe.go`) and `mariadb-dump` without `--routines`/`--events`, and neither carries
   roles or users. Rows, extensions, sequences and collation are carried. An estate whose application connects as the database owner is
   unaffected; one with a read-only role, a second owner or a stored function loses them silently, and the owner has to be told per database.
4. **A source with no containers breaks the container-health check** (hub log of run 3; see "Lab history").

## Not covered here

- **`migrate --certs` (the ACME seed)** has no lab scenario yet.
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
