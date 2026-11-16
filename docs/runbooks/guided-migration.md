# Guided migration runbook (Coolify / Dokploy to Tugra)

One resumable, observable, abortable run that drives a whole migration: preflight, config import, data copy, TLS
pre-issue, verification and the cutover. It sits **above** the pieces described in
[Migrating from Coolify](../coolify-migration.md) and the [SSL/DNS cutover runbook](cutover.md); it does not replace
them. Those manual paths keep working and remain the way to do anything a run does not cover.

Where it lives: the API under `/migration-runs`, the CLI `tugra import run ...`, the `migration_run_*` MCP tools and
the `/import/runs` pages of the panel.

## Verification status (read this first)

Be clear about what has and has not been proven before you point this at a fleet you care about.

- **Verified by automated tests:** the run engine, state machine, gates, approvals, abort/pause/resume, crash recovery
  and the request/response contracts are covered by specs that run the whole flow against **in-memory fakes** (a fake
  clock, store, importer, data plane and cutover). The CLI request builders and the MCP tools are spec-tested the same
  way.
- **Not verified:** **no live lab run has happened.** No real Coolify host, Cloudflare zone, source-host migrator run,
  DNS flip or same-host proxy swap has been driven end to end by this feature. Every number in this document that is
  a time or a rate is an **estimate**, not a measurement. The measured downtime of your own run is in its report.
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
  A fleet is a campaign of runs, one per source team and target server. Dry runs are unlimited.
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
  hub (the hub cannot start it unless you enrol an agent there, see the runner option below).
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

- **Source runner** (`operator` default, `agent`): who starts the migrator on the source host. `operator` prints the
  exact command for you to paste; `agent` has the Tugra agent on the source host run it and needs the opt-in `migrate`
  capability on that server (granted for the run, revoked at the end).
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
   server name (and, for a takeover, the source host) and to accept the data risk. It expires after 30 minutes.
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

Set or change them any time: `tugra import run inputs <runId> --acme-email ops@example.com`.

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
  source-host command (it carries a live token), operator attestations (a human vouches for the source host) and the
  source-token re-entry.
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
| `server-has-live-run` (409) | Another real run is live on that target server. Finish or abort it first. |
| `approval-stale` (409) | What you reviewed changed. Read `status` again and approve the new hash. |
| `bad-confirmation` (400) | The typed name does not match (run id, target server, source host, or "server host" for a takeover). |
| `acks-required` / `data-risk-required` (400) | The approval needs those acknowledgements ticked. |
| `human-confirmation-required` (403) | You are on MCP. The PONR and decommission approvals are for a human session or PAT. |
| `insufficient-scope` (403) | Create needs `deploy` and `read:secrets`; cleanup, reverse and decommission need `admin`. |
| `run-past-ponr` (409) | Abort is no longer possible; use `reverse` (lossy) or finish forward. |
| `run-not-pausable` / `run-not-paused` (409) | The run is not in a state where that applies. |
| `step-not-retryable` (409) | Only a failed or waiting step can be retried. |
| `session-expired` (400) | Re-enter the source token with `source-session`, or pass a fresh `--session` to `start`. |
| `run-not-found` (404) | Unknown run, or it belongs to another user. |

A failed run is never a dead end: retry the step, fix the cause, or abort.
