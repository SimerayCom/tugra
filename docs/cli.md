# CLI

`tugra-cli` is the official command-line client (`tugra`) for the Tugra REST API. It's a small,
MIT-licensed client you can use from your terminal or CI.

## Quick start

> `tugra-cli` is published to npm (`npm i -g tugra-cli`). To run it from a checkout instead, build it with
> `pnpm --filter tugra-cli build` and use `node packages/cli/dist/index.js` in place of the `tugra` command.

```bash
npm i -g tugra-cli
tugra login --hub https://tugra.example.com   # paste a PAT from Settings → API tokens
tugra servers ls
```

Add `--json` to any command for scriptable output.

## Full reference

The complete command list, configuration and token-security notes live in the package README:
**[packages/cli/README.md](../packages/cli/README.md)**.

## Migrating from Coolify / Dokploy

(CapRover imports run from the web wizard, MCP or the REST API: see [Move from CapRover](move-from-caprover.md).)

Two groups under `tugra import` cover a migration (procedure:
[guided migration runbook](runbooks/guided-migration.md), [Coolify migration](coolify-migration.md)):

- `tugra import cutover <opId> <action>` and `tugra import volumes`, `tugra import git-links`, `tugra objects ...`:
  the individual pieces (SSL/DNS cutover, streamed volume copies, git links, object migration).
- `tugra import run <subcommand>`: the **guided migration run**, one resumable flow over all of them.

```bash
# rehearse: projects every step, writes nothing outside the run's own rows
tugra import run create --dry-run --session <sessionId> --server <targetServerId> --plan-hash <planHash> --acme-email ops@example.com
tugra import run status <runId>           # steps, gate checks with evidence kinds, what it waits for, the approval to review
tugra import run start <dryRunId>         # promotes the dry run into a NEW real run and prints it
tugra import run watch <runId> --until-waiting
tugra import run command <runId> DATA_SEED                  # the source-host command (live token, shown once)
tugra import run command <runId> DATA_SEED --kind inventory   # name the script (migrator | host-loop | inventory); default: what the step waits for
tugra import run approve <runId> FREEZE --hash <inputHash> --confirm <typed name>   # `status` prints this line for you
tugra import run abort <runId> --confirm <runId>            # before the point of no return only; deletes nothing
tugra import run report <runId> --format md

# a fleet: one run over several source hosts (see "Fleet runs" in the guided runbook)
tugra import run create --dry-run --session <sessionId> --server <defaultTargetServerId> --plan-hash <planHash> \
  --map <sourceServerUuidA>=<tugraServerId1> --map <sourceServerUuidB>=<tugraServerId2> --campaign wave-1 \
  --source-runner coolify-host-loop --large-db-mode stream-logical --minio-policy hold
tugra import run list --campaign wave-1
tugra import run image-pin <runId> --image repo/app:latest --digest sha256:<64 hex>   # the digest the SOURCE runs (attested by you)
tugra import run worker-mark <runId> --item app:<server>:<ref> --role job-runner      # held until after the cutover; `none` removes it
```

Sub-commands: `list`, `create`, `status`, `events`, `watch`, `start`, `approve`, `retry`, `skip`, `evidence`, `attach`,
`command`, `inputs`, `pause`, `resume`, `abort`, `cleanup`, `reverse`, `decommission`, `source-session`, `report`,
`safety-hints`, `image-pin`, `worker-mark`. Notes:

- Fleet options of `create`: `--map <source=target>` (repeat for each source host; every source host must be listed once a
  map is given) or `--server-map-file`, `--campaign`, `--source-runner coolify-host-loop` with `--host-loop-key-dir`,
  `--host-loop-parallel`, `--host-loop-connect-timeout`, `--host-loop-retries`, `--deploy-waves earlyBuild`,
  `--deploy-concurrency`, `--large-db-mode`, and the owner policies `--minio-policy`,
  `--worker-policy`, `--unlisted-db-policy`, `--orphan-volume-policy` (also on `inputs`). Nothing answered, nothing sent:
  the hub's fail-closed defaults apply.
- On a multi-server run `status` prints every target server, the placement, the source version with its verdict and the
  exact typed confirmation (every target server, sorted, joined with a comma and a space).
- `create` and `command` need a token with `deploy` **and** `read:secrets`; `cleanup`, `reverse` and `decommission`
  need `admin` (see [scopes](api.md#scopes)).
- Secrets never travel as flags: `source-session` reads the source API token from `$TUGRA_SOURCE_TOKEN`; object-store
  keys stay in the object migration (`tugra objects create`), which you `attach` by id.
- `approve` requires the `--hash` that `status` showed you, so an approval is only ever for what you reviewed.
  `abort`, `cleanup` and `reverse` require `--confirm <runId>`; `reverse` also `--acknowledge-data-loss`.
- The guided run has **not been run against a live Coolify yet** (see the runbook's verification status).

## API & scopes

The CLI is a thin client over the [REST API](api.md); commands like `tugra apps deploy` need the matching
[scope](api.md#scopes) on your token.

## Typed API types

The package ships TypeScript types generated from the API's OpenAPI contract (via
[`openapi-typescript`](https://github.com/openapi-ts/openapi-typescript)) — `paths`, `operations`,
`components` and an `ApiError` alias — so you can type your own calls against the API. Regenerate them after
the contract changes with `pnpm --filter tugra-cli generate:api`; a test keeps the committed types
byte-in-sync with `apps/hub-api/openapi.json`.
