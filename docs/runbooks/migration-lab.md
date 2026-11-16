# Migration lab (volume stream, L0-L8)

The data-plane chain of the one-click migrator has two halves that unit specs only ever test against fakes: the Go specs
fake the hub, the hub specs fake the target agent. The lab runs the **real** chain on one Linux docker host:

```
real Go migrator (the agent image, the installer line) -> HTTP -> real hub (relay) -> signed WS command
  -> real target agent (curl) -> /etc/tugra/app-moves -> real alpine busybox apply (safeWipeExtract)
```

Source and target are separate docker volumes and containers on the same daemon. This is **Tier A**. **Tier B** (a real WAN
link, a Cloudflare body cap, real Coolify container naming, separate disks) is the last section and is not automated.

Everything below was derived from reading the code and the specs. The harness was written without a docker daemon on the
author's machine, so the first run on a runner is the first run: expect to fix harness details, and treat a red lab as a
finding first, a harness bug second (the scripts print the migrator log, the hub log is an artifact).

## Running it

**CI (the normal way).** Actions, *Migration lab (vx)*, *Run workflow*. `items` is `all` or a comma list of
`tar, core, restart, postgres, memory, seats, throttle`. It also runs nightly. Each item is its own job on a fresh
`ubuntu-latest` runner; logs (`hub.log`, `run.*.log`, `run.*.json`, `mem.*.log`, compare diffs, agent log) are uploaded as the
`vx-lab-*` artifact.

| Job | Items | What it needs |
|---|---|---|
| `tar` | L4 | docker only (no hub) |
| `core` | L0, L1a, L1b | the full lab, about 12 GiB of docker disk |
| `restart` | L2 | the full lab, about 8 GiB |
| `postgres` | L6, one job per image (`postgres:16-alpine`, `pgvector/pgvector:pg17`, `postgres:18-alpine`) | the full lab |
| `memory` | L7 | the full lab, `L7_MIB` x 3 of disk (default 3072 MiB, so about 10 GiB) |
| `seats` | L8 | the full lab, two agents |
| `throttle` | L3 mechanics | the full lab |

**On a Linux box with docker, node 22 and pnpm** (not macOS: the target agent bind-mounts the host's `/etc/tugra`):

```bash
scripts/lab/up.sh                      # registry:2, agent image, postgres+redis, hub, target agent ONLINE
scripts/lab/l0-dry-run.sh              # any scenario; each starts from a fresh op, app and source volume
scripts/lab/l1a-stream.sh
scripts/lab/down.sh                    # tears everything down, removes $LAB_DIR
```

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
| `compare.sh` | `ARCHIVE-IDENTICAL` (sha256 of the same GNU tar stream over both volumes) or a field-level busybox `stat` plus content-hash diff naming the exact entry and field. A difference only in directory mtimes prints `DIR-MTIME-ONLY` (the extractor decides those; `COMPARE_STRICT=1` makes it fail). |
| `manifest.sh` | The per-entry manifest `compare.sh` and the Go test both use. |
| `throttle-proxy.mjs` | Node `net` only. `--listen 4001 --target 127.0.0.1:3000 --rate 10` throttles the upload direction to 10 MB/s by backpressure, shared by all connections like one link. Verified on loopback: 5, 20 MB/s configured gave 5.0 and 20.0 MB/s measured. |
| `jget.mjs` | A 30-line JSON path reader (no jq needed on a dev box). |
| `lib.sh` | Shared helpers (`lab_scenario_begin`, `lab_run`, `lab_run_bg`, `lab_expect_item`, `lab_no_leftovers`, ...). |

The migrator source is a **stopped container named after the sourceRef** (`labsrc`, created with `docker create`, never started)
mounting the source volume, so no Coolify is needed. The hub derives the destination volume (`tugra_appv_<appId>_data`,
`tugra_dbv_<dbId>`) itself.

## Scenarios

Every scenario fails with a message naming the check. "Expected" below is what the code says should happen; a mismatch is the
finding.

### L0 dry-run (`l0-dry-run.sh`)
`--arms all --dry-run` on 256 MiB: state `planned`, `disk: ok`, entries and raw bytes reported; `docker ps -a` identical before and
after, source untouched, nothing staged, no hub transfer row, the stored inventory visible at
`GET /import/operations/<op>/volumes`. Negatives: a started source gives `volume-skipped-running` and is not stopped; a disk
check for twice the free space (within the hub's 256 GiB limit) is `ok: false, unknown: false`; a device node in the source gives
`volume-special-files`.

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
(A) 32 MiB parts at 2 MB/s; when a `p.NNNNN.tmp` is on the target the hub gets SIGKILL, waits 20 s and restarts. The migrator rides
the outage (`--hub-outage-wait 10m`): either `vx-part-lost` and a re-send, or the part-stat shortcut; the run ends `volume-applied`
and identical with no operator action. (B) With 1.5 GiB the hub is killed while the transfer is `APPLYING`; `vx-recovery` must settle
it from the target's markers: `DONE`, still attempt 1 (no second copy), identical, no rollback snapshot left. If the apply finishes
before the kill the scenario fails with "window missed" (raise `L2B_MIB`).

### L3 throttled link, mechanics only (`l3-throttle.sh`)
`--speedtest-mib 256 --dry-run` behind the proxy at 100, 25 and 10 MB/s: a speed is measured, it never exceeds 1.5x the link, it is at
least 0.35x for links up to 25 MB/s, and `estimateSeconds` follows `size / rate + 15 min` within 40 %. Then a single ~30 MiB part at
0.25 MB/s (about 2 minutes, longer than the relay's 120 s idle limit, which must apply to a stalled socket and not a slow one)
must complete. **These are loopback mechanics.** The real numbers (WAN, body caps) are Tier B; the docs' and the UI's estimate
text should be updated from measured Tier B numbers, not from this.

### L4 tar fidelity (`vx-tar-fidelity.sh`, and the `dockerit` Go test)
The migrator's stream is applied with the **pinned alpine busybox tar** the target really uses, with the exact validate / wipe /
`tar -xf -` sequence of `safeWipeExtract` (drain mode, no `--no-same-owner`). Pass: owners 999/70/1000, modes, hard link, symlinks,
long and unicode names, FIFO and every content hash survive; the wipe removes old content; a truncated archive fails. Recorded, not
failed: a lost setuid bit and the **sparse limit** (GNU tar without `-S` stores holes as zeros: content identical, the target uses the
apparent size). A failure here is a format decision, not a patch: re-test `--format=posix` only after re-testing busybox pax handling.
The same extraction runs as `agent/internal/migrate/busybox_dockerit_test.go` inside the existing `agent-docker-it` CI job (it reads
the helper-image pin from `volume-backup-script.ts`, and fails if `safeWipeExtract`'s drain extract is edited without updating it).

### L5 single file over 8 GiB (manual, not in the nightly: needs about 20 GB free)
```bash
docker run --rm -v lab-src:/data alpine:3.21 sh -c 'truncate -s 9G /data/huge.bin && echo marker >> /data/huge.bin'
scripts/lab/migrate.sh --arms all
```
GNU tar writes sizes over 8 GiB in base-256, busybox must read them. Pass: apply succeeds and `stat -c %s` matches. The right failure,
if it does not: the apply's validate step exits 72 "invalid archive" with the destination untouched; the fallback is refuse-with-reason
or re-testing `posix`.

### L6 PostgreSQL 16 / 17 / 18 (`l6-postgres.sh`, `L6_IMAGE=...`)
A real cluster (`POSTGRES_USER=tugra`, about 200 MiB of rows) is **SIGKILLed** (exit 137, no checkpoint). 16 and 17 (PGDATA mounted at
`/var/lib/postgresql/data`): the gates pass, the copy applies, `postmaster.pid` is not copied, the database is provisioned on the target,
logs show WAL replay, and the row count and `pg_total_relation_size` equal the values frozen before the kill. On 16 the negatives run
first: a running source (`volume-skipped-running`), an Alpine source against a Debian target image, a major mismatch, a started
destination; each must be refused with the gate's own text. 18 (volume mounted at `/var/lib/postgresql`, PGDATA one level down): the
`layout` gate must fail with exactly "PostgreSQL 18 data layout is not supported by Tugra database volumes yet", no transfer starts, and
the database stays on the logical dump path.

### L7 memory (`l7-memory.sh`)
The migrator runs under the installer's `--memory=768m --memory-swap=768m` (asserted from `docker inspect`) on incompressible data
(every member is about 128 MiB, the worst case) and on zeros. `docker stats` is sampled every second and `docker events` watched for
`oom`. Pass: exit 0 (not 137), no OOM event, peak under 700 MiB (flagged above 640). `L7_MIB` (default 3072) sets the size; the peak
is per slice, so the size only needs enough parts to show steady state. The fix this lab exists to verify is below.

### L8 relay seats (`l8-relay-seats.sh`)
The hub runs with `MIGRATION_RELAY_CONCURRENCY=1` and `MOVE_MAX_CONCURRENT_RELAYS=1`. (A) Two migrator runs (two ops, two source
volumes, one target server) race for the one migration seat: the loser sees `busy` (an uncounted, jittered backoff), both end
`volume-applied`, and no part failure is logged. (B) While they stream, a deployed app with 256 MiB of data is moved to a second agent.
**This leg is observational**: both "servers" are one docker host sharing `/etc/tugra` and the docker daemon, so the move itself may fail
for topology reasons; the summary prints `MOVE: <phase>`. Only a move that makes no progress for five minutes after both migrations ended
(`STUCK-*`, starvation across pools) fails the lab. `L8_MOVE=0` skips the leg. The `busy` path itself is silent in the migrator log; read
it from the two runs' wall times.

## The two risks the runbook found, and what changed

1. **Migrator memory.** `produce()` held a 128 MiB raw slice plus two member `bytes.Buffer`s that were never pre-sized. On
   incompressible data a member is about 128 MiB and a buffer that grows by doubling reaches about 256 MiB capacity with the old
   and new arrays both alive; with no Go memory limit the GC lets the heap run to about twice the live set, against a 768 MiB cgroup
   with no swap (an OOM kill, exit 137, with no message). `memberWriter.compress` now `Grow`s the output buffer once to a worst-case
   bound (`memberBound`: n + n/256 + 1 KiB) and `Reset` keeps the capacity, so the two pooled buffers never reallocate after the first
   slice; `StreamVolume` installs `debug.SetMemoryLimit(600 MiB)` once per process (unless the operator exported `GOMEMLIMIT`), so
   the collector works before the cgroup limit. The live set is about three slices plus a few MiB. Unit tests: pre-sizing and reuse of
   the member buffer, the bound against real members, the limit installation and its `GOMEMLIMIT` precedence, and an end-to-end
   incompressible 6 x 16 MiB stream whose live-heap growth stays under 3 slices + 4 MiB (it was 54 MiB with the doubling buffers, 50 MiB now;
   the buffer-capacity test is the strict one). L7 is the proof at the real 128 MiB size.
2. **Busybox apply.** `safeWipeExtract` extracts with `alpine:3.21` busybox `tar`; the unit specs stub docker and the old `dockerit`
   test extracted with GNU tar. L4 above closes it, in CI through `agent-docker-it` and as a standalone script.

## Not covered here

- **Tier B**, on demo.tugra.io (hub and target) with a throwaway Hetzner VM as source: `--dry-run` first (L0, the real same-device
  `Disk: ok` question), `--speedtest-mib 512` (L3 real number), `--stop-source` with 2 GiB then a 30 GB synthetic Postgres volume, then
  `compare.sh`; behind Cloudflare try the default 128 MiB part and watch for a 413 (the documented answer is
  `MIGRATION_VX_PART_MIB=32`). Use a fresh test team. The import op comes either from a real Coolify on the VM through the wizard (most
  real, tests container naming) or from `seed.mjs` run inside the hub container.
- The owner's real Coolify fleet: a read-only `--dry-run` there needs the owner's explicit go.
- A sparse-file-preserving copy (the spec's documented limit), xattrs, ACLs, file capabilities, sockets and sub-second mtimes.
