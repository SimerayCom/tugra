# Guided migration runbook (Coolify / Dokploy to Tugra)

One resumable, observable, abortable run that drives a whole migration: preflight, config import, data copy, TLS
pre-issue, verification and the cutover. It sits **above** the pieces described in
[Migrating from Coolify](../coolify-migration.md) and the [SSL/DNS cutover runbook](cutover.md); it does not replace
them. Those manual paths keep working and remain the way to do anything a run does not cover.

Where it lives: the API under `/migration-runs`, the CLI `tugra import run ...`, the `migration_run_*` MCP tools and the panel pages
under `/import/runs` (or "Run guided migration" in the import wizard).

A project that spans several source servers, large databases, a proxy that caps uploads and workers that must not start
early is covered by the [fleet runs](#fleet-runs-several-source-hosts-one-run) section below. Everything in it is opt-in
and every default is the safe one: a run created without those options behaves as it always did.

## Verification status (read this first)

Be clear about what has and has not been proven before you point this at a fleet you care about.

- **Verified by automated tests:** the run engine, state machine, gates, approvals, abort/pause/resume, crash recovery
  and the request/response contracts are covered by specs that run the whole flow against **in-memory fakes** (a fake
  clock, store, importer, data plane and cutover). The CLI request builders and the MCP tools are spec-tested the same
  way.
- **Verified by the migration lab (the data plane, on generated data):** the [migration lab](migration-lab.md) runs the real
  migrator against a real hub, a real target agent and the real busybox apply on one docker host. Its third run (16 Nov 2026)
  was the first to move a real part through the relay (the first two failed at the first part upload: finding "417" in the lab
  history), and it showed a streamed 2 GiB volume, a hub killed mid-part and mid-apply, the migrator under its 768 MiB cap,
  concurrent migrators on one relay seat, a 4 GiB PostgreSQL 17 copied physically from a running source with `--stop-source`, the
  PostgreSQL 18 layout refusal (with the stopped source restarted), Coolify 4.1.2 discovery, source-host cases A to D (running uuid-named
  containers, an ambiguous pair, an exited and a crash-looping one) and an Ubuntu 26.04 userland. **The lab drives the data plane (migrator, relay, apply), not this run engine**: it seeds the import operation
  directly, so none of the run's steps, gates or approvals has been exercised against real containers.
- **Not verified:** **no real fleet has been migrated, and no real Coolify host, Cloudflare zone, DNS flip or same-host proxy
  swap has been driven end to end by this feature.** Every number in this document that is a time or a rate is an
  **estimate**, not a measurement (the lab's copy times are for generated data on one CI host). The measured downtime of your
  own run is in its report.
- **Fleet-fit changes (multi-host placement, the Coolify-host loop runner, the host inventory, streamed large
  databases, the safety rules, the per-host cutover, and the panel, CLI and MCP surfaces for them):** covered by unit
  and in-memory specs. They were designed from an analysis of a real fleet, but **no real fleet has been migrated with
  them.** What the lab has since shown, and what it has not (see its history for the current state of each job):
  - *Shown:* the physical lane, the logical artifact route and its 256 MiB cap, the 18 layout gate, `--stop-source` on running
    uuid-named sources, the inventory and Coolify discovery shapes.
  - *Not yet green when this was written:* the **streamed dump lane** (L15: PostgreSQL and MariaDB, the hub killed mid-dump,
    compared by checksum), **PostgreSQL TLS** (L16), the bind-mounted MinIO copy (L11, whose image had to be replaced) and
    the L12 host cases; their harness bugs were fixed after run 3 and the fixed jobs had not run yet. The streamed lane has
    never run at the real size.
  - *Cannot be shown on one host:* Cloudflare record types, a real Coolify 4.1.2, a real Ubuntu 26.04 kernel, real WAN rates and
    real multi-GB sizes; the lab lists them as manual rehearsal steps (Tier B).
  Where a specific part is unproven, the section that describes it says so.
- **Unverified assumptions** (to be settled in the lab, not here): whether Coolify restarts its own stopped proxy on a
  same-host swap; whether proxy restart policies survive a host reboot; whether the dark probe against the Tugra proxy
  container works while Coolify holds :80/:443; per-engine row-count cost on very large tables.
- **Build coverage:** a hub only starts a **real** run when every step of the flow has a registered handler. A dry run
  always works (it projects, it writes nothing outside its own rows). If a real `start` is refused for a missing step,
  your build predates that part of the flow: use the manual runbooks for it.

Start with a **dry run on a rehearsal copy**, then a real run on a non-critical team, before the fleet that matters.

## What it guarantees, and what it does not

- **Before the point of no return (PONR) you can always go back.** `abort` makes the source authoritative again:
  it cancels in-flight copies, revokes the migrator token, restarts the source containers the run itself stopped (or
  prints the list when the source is controlled by hand), restores DNS TTLs, stops the Tugra copies and undoes the env
  remap. **It never deletes data** on either side. `cleanup` is a separate, optional step.
- **The PONR is set, persisted and monotonic** immediately before the first command that can route production traffic
  of a *stateful* app to Tugra (a DNS flip write, or the proxy swap). It is pessimistic: if that command then fails
  before writing anything, the PONR stays set. A run whose hosts are all stateless does not set it for those flips.
- **The freeze is not the PONR.** It stops the source writers (service-affecting) but Tugra has taken no writes, so an
  abort before the PONR restarts exactly the containers that were recorded.
- **After the PONR the only way back is a lossy `reverse`.** It restores DNS from the ledger (or reverses the proxy
  swap). Data Tugra wrote after the cutover is **not** restored; nothing syncs backwards. Dump Tugra back to the source
  yourself first if that matters.
- **The run never deletes anything on the source.** It only stops containers it recorded and verified, never
  `docker rm`s them. `decommission` (takeover only) stops the source containers and **prints** the removal commands;
  you run those.
- **Not zero downtime** for stateful apps. The window is "freeze, final data copy, deploy, flip". It is estimated
  before the freeze (from sizes and a measured link speed) and measured during the run; the report compares the two.
- **One live real run per target server.** A second real run on the same server is refused (`server-has-live-run`).
  A run that places resources on several servers holds **every** one of them (the default and each mapped target), so a
  second run cannot start on any of them until the first finishes or is aborted. A fleet is a campaign of runs, one per
  source team (give them one `campaign` label to list them together). Dry runs are unlimited and hold no lock.
- **A single hub.** The streamed copy relays through the hub's memory, so a multi-hub deployment is not supported for
  this flow.

## Prerequisites

- A **target server** with an online Tugra agent (the `deploy` and `database` capabilities). For a same-host takeover
  the agent is enrolled on the Coolify host itself.
- A **read-only Coolify/Dokploy API token**, connected through the import wizard, `POST /import/connect` or the
  `import_connect` MCP tool. The connection (an *import session*) lives **one hour**. Only IMPORT and the source-drift
  check need it; a later step that does goes to *waiting* and asks you to re-enter the token
  (`tugra import run source-session`).
- A **real ACME contact email** for the target proxy (Let's Encrypt rejects placeholders). Without it, steps up to
  DEPLOY_DARK still run; TLS and the cutover block.
- For a DNS flip: a team **DNS credential** covering your zones (Cloudflare), or manual DNS (the run prints the records).
  The same rules as the [cutover runbook](cutover.md) apply, including the Cloudflare SSL mode check.
- The **source host must be able to reach the hub** over HTTPS; the migrator runs on the source host and pulls from the
  hub (the hub cannot start it unless you enrol an agent there, or use the Coolify-host loop, see the runner option
  below). A proxy in front of the hub that caps request bodies also caps the migrator's upload parts: the host
  inventory measures that per source host (see [fleet runs](#fleet-runs-several-source-hosts-one-run)).
- A **supported Coolify version** on the source: at least 4.1.2, tested up to 4.7.5 (see
  [safety rules](#safety-rules-before-the-cutover)). Dokploy has no version range.
- Enough disk on the target: a physical volume copy needs roughly 2x the volume (the preflight shows the verdict).

## Choose the shape of the run

`mode` and `topology` are independent and neither changes the importer's plan hash.

| | `two-box` (default) | `swap-proxy` (same host) |
|---|---|---|
| **`copy`** (default) | Tugra on its own server, DNS flip. The first, simplest cut and the recommended start. | Tugra beside Coolify on one host; the Tugra proxy takes over :80/:443 at cutover. |
| **`takeover`** | As copy, and the Coolify box may be decommissioned later (an armed, separate action). | As above, plus decommission. |

- `swap-proxy` has no DNS write, needs certificates **before** the cutover (DNS-01 or seeded; HTTP-01 cannot work while
  Coolify owns port 80) and runs both stacks side by side (about 2x disk for volume copies).
- `side-by-side` coexistence is not available; it is rejected with 400.

Two more choices, both with safe defaults:

- **Source runner** (`operator` default, `agent`, `coolify-host-loop`): who starts the migrator on the source host.
  `operator` prints the exact command for you to paste on each source host; `agent` has the Tugra agent on the source
  host run it and needs the opt-in `migrate` capability on that server (granted for the run, revoked at the end);
  `coolify-host-loop` prints one script for the **Coolify host** that loops over every source host (see below).
- **Source controller** (`manual` default, `api`, `agent`): who freezes and restarts the source writers. `manual` prints
  the steps and you attest; `api` needs a Coolify **write** token; `agent` stops the recorded container ids.

## The flow

Thirteen steps, linear. A step that does not apply (no DNS for a proxy swap, no object stores) is skipped with a code.
"Rollback" says what an abort does to it.

| # | Step | Who acts | What it does | Rollback |
|---|---|---|---|---|
| 1 | PREFLIGHT | hub | Re-plans the source read-only, checks the plan is still the one you reviewed, then target readiness (agent, ACME email, DNS credential and zone coverage, Cloudflare SSL mode, disk, bind mounts, generated hosts). **This is the dry run.** | none needed |
| 2 | IMPORT | hub | Applies the frozen plan through the importer (creates apps and empty databases). Retry is rollback plus a re-apply on a fresh operation (at most 2 attempts). | undo |
| 3 | DNS_PREPARE | hub, timer | Reads zones and records, lowers the TTL, sets the earliest flip time so the TTL wait elapses while data seeds. Skipped for a proxy swap and for manual-DNS zones. | restore TTL |
| 4 | DATA_SEED | you, optional | Non-disruptive rehearsal: the migrator `--dry-run` and a speed test, an object-migration seed pass, optionally a warm DB dump. Skippable. | cancel, reset |
| 5 | FREEZE | **you approve** | Opens the downtime window: stops the source writers. You approve the stop list and the window estimate; it can be scheduled. | restart recorded containers |
| 6 | DATA_FINAL | you or hub | The migrator's final resync, the final object pass and a verify. | destinations are disposable |
| 7 | REMAP_ENV | hub (+ approval if manual rows) | Rewrites database host references in env vars. | undo |
| 8 | DEPLOY_DARK | hub | Starts databases, then deploys the apps with an idempotency key. No public traffic yet. | stop what the run started |
| 9 | TLS_PREISSUE | hub | Issues certificates ahead of the flip, redeploys hosts that need it, loops until every host is ready. | restore prior challenge setting |
| 10 | VERIFY | hub, then **you approve the PONR** | The verification suite (below). Then an attended, name-typed approval bound to a hash of the report and the flip plan. Valid for 30 minutes. | none needed |
| 11 | CUTOVER | hub | The DNS flip in paced batches (or the proxy swap). **Sets the PONR** before the first stateful write. | lossy after the PONR |
| 12 | OBSERVE | hub, timer | Default 30 minutes (0 to 72 h): re-checks every host and watches for crashes and OOM kills. | lossy after the PONR |
| 13 | FINALIZE | hub (or you) | Restores the original TTL, writes the report, revokes the migrator token and any temporary capability grant. | irreversible, benign |

`DECOMMISSION` (takeover only) is **not** a step the run enters: it is armed by its own action (below).

### Gates and evidence

Every check a step reports carries how trustworthy a pass is. Read the badge; do not treat them as equal.

| Evidence | Meaning |
|---|---|
| `hub-verified` | The hub checked it itself (a transfer's entry counts, a health probe, a record read back). |
| `migrator-reported` | The migrator on the source host said so (a quiescence fingerprint, a row count). Trusted less: the source reports on itself. |
| `operator-attested` | **You** said so (for example "I stopped the source writers"). Recorded with who and when. |
| `source-api-reported` | The source's own API (read-only token) said so: its version, its health, what it lists. The hub cannot check it independently. |
| `host-loop-reported` | A read-only probe of the host script reported it and the script sent it back (an inventory, a reach probe, a per-host status). The hub cannot check it independently. |

An **unknown** check is a failure wherever data would move; it is never counted as a pass.

### The verification suite (step 10)

Volume parity (entry counts), the PostgreSQL physical-copy version check, database logical parity (Redis exact
`DBSIZE`; PostgreSQL and MySQL table and chosen-table row counts in `exact` or `estimate` mode, shown as such), object
verification (`mc diff`: keys and sizes, **not** a content hash), runtime checks (database health, apps running, host
checks, env key-count parity), the coverage ledger (every source app, database, service and domain is moved, skipped
with a code, or acknowledged) and a source-drift re-discovery (unknown if the session expired).

## Walkthrough (copy, two-box, operator-run data)

Set the hub and a PAT with `deploy` **and** `read:secrets` (`tugra login`). Cleanup, reverse and decommission need
`admin`.

1. **Connect and plan** as for any import (wizard, or the API / MCP tools). Review the plan, resolve the mapping,
   note the `planHash`. Anything you pass to the run (mapping, acks, db data modes) must be exactly what you planned
   with, or it is refused as a changed plan.
2. **Dry run.**

   ```bash
   tugra import run create --dry-run --session <sessionId> --server <targetServerId> --plan-hash <planHash> \
     --acme-email ops@example.com
   tugra import run status <runId>
   ```

   It ends `DRY_RUN_DONE` and shows, per step, what would happen and every blocker or unknown. It wrote nothing outside
   the run's own rows. Fix blockers (acks, mapping, ACME email, DNS credential) and repeat.
3. **Start for real.** Starting a finished dry run *promotes* it: a **new** run is created with the frozen inputs, the
   plan hash is re-validated against the live source, and the new run's id is returned.

   ```bash
   tugra import run start <dryRunId>          # prints the NEW run
   tugra import run watch <runId> --until-waiting
   ```

4. **Follow what it is waiting for.** `status` shows exactly one `waiting:` line naming the step and what unblocks it,
   and, for an approval, the exact command to approve it. `watch --until-waiting` returns when a human is needed;
   timers and the hub's own work do not stop it.
5. **Operator steps (DATA_SEED, DATA_FINAL).** Mint the source-host command once, paste it on the Coolify host:

   ```bash
   tugra import run command <runId> DATA_SEED          # the token inside is shown once; --reissue mints another
   ```

   For object stores, create the object migration with `tugra objects create` (credentials never pass through a
   run), then `tugra import run attach <runId> DATA_SEED --object-migration <id>`.
6. **FREEZE approval.** Read the stop list and the window estimate in `status`, then run the printed
   `tugra import run approve ...` command. The hash binds your approval to what you reviewed: if the stop list
   changes, your approval is void and the step returns to waiting (`approval-stale`). With a manual source controller
   you then stop the source writers by hand and attest.
7. **VERIFY and the point of no return.** Read the verification report. The approval needs you to type the target
   server name (and, for a takeover, the source host) and to accept the data risk. On a run that places resources on
   several servers it needs the name of **every** target server, so the approval can never cover only some of the
   hosts: the distinct names sorted by code point, joined with a comma and a space (`status` prints the exact text, and
   the panel asks for one name per field). It expires after 30 minutes.
   **Nobody can approve this over MCP**; an agent will be refused with `human-confirmation-required`.
8. **CUTOVER, OBSERVE, FINALIZE** run by themselves. Stop the source app yourself if the source controller is manual,
   before Tugra takes writes (the printed steps). Read the report: `tugra import run report <runId> --format md`.
9. **Decommission** (takeover only, optional, never automatic): only after FINALIZE, the run is at least 72 hours old
   (configurable) and every migrated database has at least one successful Tugra backup.

   ```bash
   tugra import run decommission <runId> --confirm <source host>
   ```

## Owner questions as run inputs

Unanswered questions do **not** block the run; each blocks only the step that needs it, and has a safe default.

| Input | Default when unknown | Blocks |
|---|---|---|
| `acmeEmail` | none | TLS_PREISSUE and CUTOVER only; steps 1 to 8 run |
| `allowBind` (bind-mount apps) | refuse; the count is shown in PREFLIGHT, per-volume exclusion with an acknowledgement | the affected data steps |
| `allowLiveShapeProbe` (consent for the read-only live probe of Coolify API shapes) | off; the services preview degrades with its existing wording | nothing |
| `sourceController` | `manual` (printed steps plus your attestation) | FREEZE automation only |
| `minioPolicy` (`hold`, `mirror`, `external`) | `hold`: hosts that depend on the source's object storage stay on the source | CUTOVER, for those hosts only |
| `workerPolicy` (`hold-dark`, `start-dark`, `exclude`) | `hold-dark`: apps without a domain stay stopped until after the cutover | nothing; it decides when workers start |
| `unlistedDbPolicy` (`block`, `carry`, `skip`) | `block`: a database container the source API does not list stops DATA_SEED | DATA_SEED |
| `orphanVolumePolicy` (`block`, `skip`) | `block`: a volume no container mounts stops DATA_SEED | DATA_SEED |

An unanswered fleet policy (or the literal `unknown`) keeps its default, and every default holds work back rather than
moving it. Set or change them any time: `tugra import run inputs <runId> --acme-email ops@example.com`, or
`--minio-policy`, `--worker-policy`, `--unlisted-db-policy`, `--orphan-volume-policy`; the panel's
"Owner inputs" card has the same fields.

The hub's input contract also holds `tickGapAcceptMinutes` (how long writes may be missing between the last copy and
the switch, default 0). FREEZE reads it: it compares the estimated window (the time the source writers stay stopped) with
the accepted minutes, and over that gap the step needs the explicit `tick-gap-accepted` attestation before it stops
anything; the default 0 means every gap needs it. The attestation is bound to the gap it was given for: a later, larger
estimate needs it again. The panel, the CLI and the MCP tools do not set the accepted minutes yet (set the input through
the API); the attestation itself is given in the panel.

## Fleet runs: several source hosts, one run

A real fleet is rarely one Coolify server. This section covers what a run does when a project spans several source
servers, has databases too large to dump into an artifact, or runs workers and floating image tags. All of it is
opt-in. **Status: designed from a real fleet's requirements and covered by unit and in-memory specs; not yet run
against a real fleet** (see the verification status above).

### Place source hosts on Tugra servers

A project that spans 3 to 6 source servers is **one** run. Give the run a `serverMap`: the **source server** (the Coolify
server uuid that appears in the plan's item refs, `app:<server>:<ref>`) mapped to a **Tugra server id**. The run's own
target server stays the default.

```bash
tugra import run create --dry-run --session <sessionId> --server <defaultTargetServerId> --plan-hash <planHash> \
  --map <sourceServerUuidA>=<tugraServerId1> --map <sourceServerUuidB>=<tugraServerId2> --campaign wave-1
```

In the panel the launch dialog lists the plan's source hosts once the target team has two or more servers; turn on
"Place source hosts on different Tugra servers" and choose a server per host. Rules, all enforced by the hub:

- **List every source server.** A source server missing from a non-empty map **stops the run** instead of landing on the
  default server (IMPORT's pre-gate and the dry run report it). A resource whose source host is unknown is placed with
  the key `_`. Many source servers may share one target; at most 64 are mapped.
- Every target must belong to the run's **team** (404 `server-not-found` otherwise).
- Each app, database and service is created on the server its source server maps to, and each app's env remap runs on
  its own server. A reference from one app to a database, service or alias on **another** Tugra server is **reported for
  a manual fix**, not rewritten to a name that cannot resolve there.
- The map is stored on the run, **not** in the frozen apply input or the plan hash.
- The run holds a lock on every target server (see the guarantees above) and the PONR approval names every one of them.
- The run page shows the placement, and `tugra import run list --campaign wave-1` (or the panel's campaign chips, or
  `migration_run_list` with `campaign`) lists the runs of one campaign with their server counts.

What this does **not** do: it does not read the source servers' names (only their uuids are in the plan, so the panel
and CLI show uuids), and the proxy swap does not support it (below).

### The Coolify-host loop runner

With `sourceRunner: coolify-host-loop` (`--source-runner coolify-host-loop`; options `--host-loop-key-dir`,
`--host-loop-parallel`, `--host-loop-connect-timeout`, `--host-loop-retries`) you do not paste a command on every source
host. The hub prints **one script for the Coolify host**. It loops over the run's source hosts using the SSH keys Coolify
already holds (`<keyDir>/ssh_key@<serverUuid>`, default key directory `/data/coolify/ssh/keys`), starts the migrator on
each, and posts a per-host status back to the hub. Re-running it resumes: a host that already finished is not redone.
Only the key **directory** is stored on the run, never a key; the script's token is the run's migration token, shown
once.

- The hosts are the `serverMap`'s keys plus the hosts named by the plan's items.
- **DATA_SEED asks for the host inventory first**, then the loop script (`tugra import run command <runId> DATA_SEED`
  returns whichever the step waits for; `--kind inventory|host-loop` names one). FREEZE and DATA_FINAL ask for the loop
  script again; the freeze script stops the writers per host and an aborted run can still fetch a **token-free unfreeze
  script** from the report.
- Source containers that are running are normal during a seed. Pass `--stop-source` only when the migrator should stop
  them itself; the run does not force it.
- Status per host is `host-loop-reported` evidence: the hub cannot verify what a host's script said.
- **Not covered:** DATA_FINAL's own wait does not yet surface a per-host failure by itself; read the per-host checks.

### Host inventory and the docker-vs-API cross-check

The run's coverage ledger comes from the source **API**, so a database container the API does not list would be left
behind silently. The inventory (`migrator.sh --inventory`, read-only) compares `docker ps` and the volumes of each source
host with the plan:

- a **database container the plan does not account for** is a blocking finding until you decide: set
  `unlistedDbPolicy` (`carry` or `skip`) or attest that exact finding with `inventory-excluded` (not migrated) or
  `inventory-mapped` (it **is** this plan item; the plan item must be named in the note);
- a **named volume no container mounts** that the plan does not carry blocks until `orphanVolumePolicy: skip` or an
  `inventory-excluded` attestation;
- **bind-mount sizes** are measured with `du`; a size that cannot be measured is **unknown**, never zero, and the
  downtime estimate stays unknown for it;
- a **hub reachability and body-cap probe** per host: if a proxy caps uploads the check fails and recommends the
  largest `MIGRATION_VX_PART_MIB` that passed (the part size is a hub setting, not a per-run one);
- anonymous volumes are counted, not listed one by one; the Coolify control plane and Tugra's own containers are never
  findings.

The inventory is `host-loop-reported` evidence. Container recognition is by image name, so a database in an image the
list does not know is not found. Each blocking finding gets its own attestation row in the panel.

### Large databases

A database whose **dump** is over the 256 MiB artifact limit, or that cannot be copied as files (for example a
PostgreSQL 18 data directory, which does not match how Tugra provisions PostgreSQL), has no physical lane. With
`largeDbMode: stream-logical` (`--large-db-mode stream-logical`) the dump streams through the hub's relay in parts and is
restored on the target without spooling, for PostgreSQL, MariaDB and MySQL. Notes:

- It is **opt-in**. With the default `refuse`, a database that needs it yields an explicit blocker naming the failed gate;
  it never silently falls back to a capped dump.
- It runs **inside the freeze window**, with no warm seed, so it adds to the downtime. The estimate includes the dump,
  transfer and restore and says so.
- Only the **dump size** decides the lane, never the volume size. The migrator measures it with
  `--dry-run --measure-dbs`; an uncounted database is routed conservatively by catalog size.
- Parity is the same row-count verification as for the other lanes. **It has a lab scenario** (L15, and a streamed leg in L9 and
  L10) that moves a running PostgreSQL and MariaDB through it, kills the hub mid-dump and compares the destination by checksum, but
  only on generated data of a few hundred MiB to a few GiB; **never exercised on a real multi-GB database.**
- **A PostgreSQL 18 destination is refused today, and the defect is wider than the streamed lane.** Tugra mounts every
  database volume at the pre-18 data path with no `PGDATA`, so the data of **any PostgreSQL 18 database Tugra provisions**, fresh
  or restored, sits outside its named volume and is lost when the container is recreated (the lab shows it by recreating a
  fresh 18 database: L16 leg A). The streamed lane therefore fails the transfer before the first byte (`dumpDestLayout`), and a
  PostgreSQL 18 database has no lane until provisioning keeps the cluster: do not plan a wave around one without asking.
- **What the dump carries.** Rows, extensions (including pgvector), sequence positions and collation arrive. **Roles, table
  ownership, grants, MariaDB users and stored routines do not**: the PostgreSQL dump runs with `--no-owner --no-acl` and
  the MariaDB one without `--routines`, so everything lands owned by the destination's own user. An application that connects
  as the database owner is unaffected; recreate any extra role, grant or routine by hand, per database, and check the lab's
  integrity section for what is compared.

### Safety rules before the cutover

- **Source version.** PREFLIGHT reads the source's Coolify version (also captured at create and promote and shown in
  the run view and report). Older than **4.1.2** blocks; newer than **4.7.5** (the newest tested) fails the check but
  can be **acknowledged**; a version the hub could not read **warns** (it does not block today; the contract intends
  steps that move data to refuse an unknown version, which is not wired). Dokploy has no range and is not judged.
- **Health baseline.** Before anything changes, PREFLIGHT records the source's per-resource health and restart counts
  (the run view shows only when). The watch after the cutover ignores apps that were already failing at the source.
  VERIFY does not consume the baseline yet.
- **Workers stay dark.** Apps without a domain are treated as workers and held **stopped until after the cutover**
  (`workerPolicy: hold-dark`, the default); OBSERVE or FINALIZE starts them after the point of no return, an abort never
  starts them and a reverse stops them. `start-dark` starts them with the rest, `exclude` leaves them out. Mark an app
  yourself with `tugra import run worker-mark <runId> --item app:<server>:<ref> --role job-runner|web|none` (the panel's
  "Held workers and image pins" card, `PUT /migration-runs/:id/worker-marks`). A `job-runner` mark is for an app with
  **no domain** whose role the plan cannot infer (for example one reached through a container alias); a `web` mark makes
  an app without a domain start dark. A `job-runner` mark on an app that **serves a domain** holds nothing: it is a
  conflict, and PREFLIGHT and DEPLOY_DARK fail until you remove the mark (a hostname needs the app running dark for the
  certificate and the router probe). A mark that matches no app of the plan also fails PREFLIGHT and DEPLOY_DARK, so a
  misspelled item cannot leave the real worker running next to the source. These marks are **attested by you**.
- **No deploy on push.** Push-to-deploy is switched off on imported apps from IMPORT until after the point of no
  return, then restored with a `release.webhooks-repoint` hint. Removing the push webhook **at the source** stays
  manual (the source token is read-only). Pull-request previews are not covered.
- **Floating image tags.** An image with a tag such as `latest` is flagged (acknowledgeable). Record the digest the
  source runs (`tugra import run image-pin <runId> --image repo/app:latest --digest sha256:<64 hex>`, or the panel
  card, `PUT /migration-runs/:id/image-pins`) and an image app is pinned to `repo@sha256:...` before it deploys; service
  members use the existing per-service pins. The digest is attested, not checked; recording it on the hosts for you is
  not automatic yet.
- **Build before the freeze.** `deployWaves: earlyBuild` builds every app image right after the import, with nothing
  started, so the window holds only starts; `deployConcurrency` (1 to 8, default 1) caps builds per target server for
  small hosts. It prebuilds **Git** builds on the app's own server only, and the window estimate does not yet include
  deploy time.

### The cutover for a fleet

CUTOVER decides per **host**, so a host that cannot move does not stall the others:

- **Object-storage dependants** (`minioPolicy`): with `hold` they stay on the source; `mirror` waits until their object
  data is copied and verified (then they flip in a later group), `external` treats the storage as not on the source.
  A host is judged a dependant from the **names** of its app's environment variables (S3, MinIO, bucket and similar) or
  because it is the storage service itself: a heuristic, so the gate lists which hosts were judged and by which names. Clear one
  host with the `cutover.object-cleared` attestation.
- **Manual DNS** gets a per-host checklist: the exact records to enter (with copy buttons in the panel) and what the
  resolvers show now. Confirm each host (`cutover.manual-dns-switched`, per host or for all) or defer it
  (`cutover.manual-dns-deferred`: it stays on the source and is reported as not cut over). The run keeps checking
  resolvers while it waits, and a confirmation the resolvers never showed is asked about again after 30 minutes.
- **HTTP-01 gaps** are accepted per host (`tls-preissue.http01-gap-accepted`), or the host is **left out**
  (`cutover.host-left-out`). The decision gate still needs every host decided; a bulk accept exists.
- Hosts flip **one target server at a time** (the stateless server first, dependants last) with the point of no return
  recorded once, per-group `autoRevert`, a per-server ACME check and one approval over all hosts. Imported compose
  services are tracked, flipped and verified like apps.
- After the cutover each git app behind a moved host gets a **webhook-repoint warning** (GitHub App source URL or the
  per-app deploy webhook, credentials stripped from the shown URL). The run only gives guidance.
- **Same-host proxy swap** no longer needs the Coolify control plane stopped: it refuses the control plane's own box
  (`cutover.swap-control-plane-host`), takes the ports back if Coolify restarts its proxy (two attempts at the start,
  two while live) and **refuses runs that span several target servers** (`cutover.swap-multi-target`). How Coolify really
  behaves here is unverified until the lab item for it is run.

### Other fleet details

- **PostgreSQL TLS.** A database can serve TLS (self-signed). IMPORT creates the copy with TLS when the Coolify source
  expects it, and the env rewrite switches TLS on before writing `sslmode=require` URLs. `verify-ca` and `verify-full`
  stay manual. The lab has a scenario for it on 16, 17, 18 and pgvector (L16: `sslmode=require` from inside the container and
  from a client container, an encrypted session, a streamed restore read back over TLS); it had not run when this was written.
- **Service endpoints.** An internal service host is rewritten to the service's private network alias (the app joins that
  network; undo restores the networks) and a renamed public service host is rewritten. Services with public domains or
  several members have no private alias and stay manual. Services are created **stopped**; starting them dark and
  choosing them for verification belongs to DEPLOY_DARK and is not complete.
- **Custom network aliases** (for example `api.internal`) are carried as DNS labels, and dependants' env is rewritten.
- **Service domains** count as hosts to flip in the cutover hint.

## Abort, cleanup, reverse, decommission

| Action | When | Typed confirmation | Scope |
|---|---|---|---|
| `pause` / `resume` | any time | none | `deploy` |
| `abort` | **before** the PONR (409 `run-past-ponr` after) | the run id | `deploy` |
| `cleanup` | after an abort | the run id; data-bearing resources also need `--include-data` and their exact names | `admin` |
| `reverse` | **after** the PONR | the run id plus `--acknowledge-data-loss` | `admin` |
| `decommission` | takeover, after FINALIZE | the source host | `admin` |

`pause` stops forward progress and undoes nothing. After an abort the Tugra copies are left **stopped**, not deleted;
inspect them, then `cleanup` if you want them gone.

## Hub restarts, crashes and expiry

- A restart does not lose the run. Every step observes what is already true before it acts, and a recovery pass
  (at boot and every 15 seconds) re-drives any run whose owner is not the current hub process. A copy interrupted
  mid-volume resumes by part.
- A run is driven only by the user who created it. If that user loses the team permissions the run needs, it pauses
  with `auth-lost` and does nothing further.
- A stuck operator step notifies you after a configurable wait (`stuckOperatorMinutes`, default 60).
- An import session older than an hour sends a step that needs it to waiting; re-enter the token with
  `TUGRA_SOURCE_TOKEN=<token> tugra import run source-session <runId>`. The token is read from the environment, never a
  flag, and is never returned.

## Agents and MCP

The `migration_run_*` tools let an agent prepare, dry-run and supervise a run. They are intentionally narrower than the
CLI:

- `migration_run_create` defaults to a **dry run**; an agent must pass `dryRun: false` explicitly for a real one.
- **Refused to agents:** the PONR approval and decommission (`403 human-confirmation-required`). Also not exposed: the
  source-host command and the host-loop and inventory scripts (they carry a live token), operator attestations (a human
  vouches for the source host), the image-digest and job-runner facts (only someone who can see the source host can
  vouch for them) and the source-token re-entry.
- `migration_run_create` takes `serverMap` and `campaign`; its `options` and `inputs` cover the host-loop runner, the
  build and large-database options and the fleet policies. `migration_run_set_inputs` changes the policies,
  `migration_run_list` filters by `campaign`, and `migration_run_status` shows the placement, the source version with
  its verdict and the health-baseline time.
- Abort, cleanup and reverse need the run id echoed back, and cleanup and reverse need an `admin` token.
- The `guided_migration` prompt walks an agent through this and tells it to report evidence kinds honestly.

## Security notes

- No secret is stored in a run. The frozen apply input holds names, placement and acknowledgement codes; the source
  token stays in the encrypted import session; migrator tokens are hashed at rest and returned once; object-store
  credentials stay in the object migration. Views, events and the report carry **codes and parameters only**.
- Every hub-built script is quoted and validated; with the `agent` runner the migrator token travels in a 0600
  env-file removed on exit, never on a command line.
- Every mutating call is audited (`migration.run.*`) with ids and codes.

## Troubleshooting

| Error / code | Meaning |
|---|---|
| `plan-changed` (409) | The source changed since you reviewed the plan (create, or promoting a dry run). Re-plan and review again. |
| `server-has-live-run` (409) | Another real run is live on one of the target servers (the default or any mapped one). Finish or abort it first. |
| `server-not-found` (404) | A target server in the `serverMap` does not exist or belongs to another team. |
| `command-kind-unavailable` (409) | The host-loop or inventory script is not available for this run: it needs `sourceRunner: coolify-host-loop` (or, for a single-host inventory, a run that can build one) and a known list of source hosts. |
| `hints-closed` (409) | The image-digest and job-runner facts can no longer be changed: the run is finished or past the point of no return. |
| `approval-stale` (409) | What you reviewed changed. Read `status` again and approve the new hash. |
| `bad-confirmation` (400) | The typed name does not match (run id, target server, source host, or "server host" for a takeover; on a multi-server run, every target server, sorted, joined with a comma and a space). |
| `acks-required` / `data-risk-required` (400) | The approval needs those acknowledgements ticked. |
| `human-confirmation-required` (403) | You are on MCP. The PONR and decommission approvals are for a human session or PAT. |
| `insufficient-scope` (403) | Create needs `deploy` and `read:secrets`; cleanup, reverse and decommission need `admin`. |
| `run-past-ponr` (409) | Abort is no longer possible; use `reverse` (lossy) or finish forward. |
| `run-not-pausable` / `run-not-paused` (409) | The run is not in a state where that applies. |
| `step-not-retryable` (409) | Only a failed or waiting step can be retried. |
| `session-expired` (400) | Re-enter the source token with `source-session`, or pass a fresh `--session` to `start`. |
| `run-not-found` (404) | Unknown run, or it belongs to another user. |

A failed run is never a dead end: retry the step, fix the cause, or abort.
