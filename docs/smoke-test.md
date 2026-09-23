# Real-VM smoke test

`scripts/smoke-vm.sh` proves Tugra's core promise against a **real** server: a real agent, real Docker
containers, a real `pg_dump`/`pg_restore`, a real deploy. It's the one thing the CI suite can't do.

## Why this exists, and what CI doesn't cover

`apps/hub-api/test/*.e2e-spec.ts` talks to a in-process test agent (see
`backups.e2e-spec.ts`, `server-ops.e2e-spec.ts`, …) that the test spins up itself. That's the right tool
for testing the hub's own logic fast and deterministically. A real-VM smoke test additionally covers a real
`docker run`, a real backup/restore, or a real deploy against a real machine. The smoke test covers this end to end; the pipeline
proves the product actually works end to end on a VM.

This script does: it drives the real REST API against an enrolled server and fails loudly the moment
anything doesn't come back the way it should — most importantly, if a restore doesn't actually bring the
data back.

## What it covers

1. Create a Postgres database (`POST /databases`), provision it, wait for `RUNNING`.
2. Insert 3 known rows directly (`psql` — there's no generic SQL-exec API endpoint).
3. Trigger a backup (`POST /databases/{id}/backups`), wait for `SUCCESS`.
4. `DROP TABLE` — destroy the data.
5. Restore from that backup (`POST /databases/{id}/backups/{backupId}/restore`).
6. Verify all 3 known rows are back, content and all — **fails loudly** if they aren't.
7. Deploy a tiny real app (`traefik/whoami`, `IMAGE` source) and curl its live URL for `200`.
8. One MCP round-trip: `POST /api/v1/mcp` `tools/list`, then `tools/call get_database`.

A green run means: a customer's database really can be backed up and restored without data loss, a
customer's app really can be deployed and reached over the internet, and the MCP endpoint really is
callable by a real client — on a real box, not a mock.

## Prerequisites

- **A cheap real server, provisioned and enrolled.** The simplest path: in the Tugra web UI, add a Hetzner
  credential under **Cloud Providers**, then **Servers → Add Server → Provision from cloud** and pick a
  **CX22** (this calls `POST /api/v1/servers/provision`) — or enroll any existing box with the one-line
  agent installer (see [Install](install.md)). Either way, wait until `tugra servers ls` (or the Servers
  page) shows it **ONLINE** before running the script — an offline agent fails step 0 immediately.
- **A personal access token** with scopes **`write`**, **`deploy`** and **`read:secrets`** (Settings → API
  tokens). Without `read:secrets` the database's password/connection fields come back redacted (`null`)
  and the script can't connect to insert/verify rows — see [API → Scopes](api.md#scopes).
- **`curl`, `jq`, `psql`** on the machine running the script.
- **Network reach to the database's published port.** The script publishes Postgres on a host port
  (`TUGRA_DB_HOST_PORT`, random by default) so it can connect from wherever you run it. If the server sits
  behind a Hetzner Cloud Firewall (or similar), allow that TCP port inbound first, or run the script from
  inside the same network.

## Env vars

| Var | Required | Meaning |
|---|---|---|
| `TUGRA_URL` | yes | Hub base URL, e.g. `https://hub.example.com`. |
| `TUGRA_TOKEN` | yes | A `tugra_pat_…` token with `write`, `deploy`, `read:secrets`. |
| `TUGRA_SERVER` | yes | The id **or** name of an already-enrolled, **ONLINE** server. |
| `TUGRA_DB_ENGINE` | no | Default `POSTGRES` (the only engine this script speaks). |
| `TUGRA_DB_VERSION` | no | Default `16`. |
| `TUGRA_DB_HOST_PORT` | no | Default: a random port in 20000-39999. |
| `TUGRA_APP_IMAGE` | no | Default `traefik/whoami:latest`. |
| `TUGRA_APP_DOMAIN` | no | A real domain you already point at the server. When set, the app deploys with a real Let's Encrypt HTTPS domain instead of a free `sslip.io` "magic" one (see the script's TODO comment near `APP_URL` for why the default can come back as `http://`, not `https://`). |
| `TUGRA_CLEANUP` | no | `1` deletes the smoke-test database + app at the end of a **successful** run (needs the `admin` scope too). Default: left running so you can inspect them. |

## Run it

```sh
TUGRA_URL=https://hub.example.com \
TUGRA_TOKEN=tugra_pat_xxx \
TUGRA_SERVER=my-hetzner-box \
  ./scripts/smoke-vm.sh
```

Every step prints `PASS:`/`FAIL:` as it happens, and the run ends with a summary + `RESULT: ALL STEPS
PASSED` (exit `0`) or `RESULT: FAILED` (exit non-zero) with the failing step's real hub/psql error
attached — nothing fails silently.

## What a green run proves

- Backup + restore is not just an API call that returns `200` — the data it protects is verifiably
  recoverable, byte for byte.
- A deploy actually produces a running, internet-reachable app, not just a `RUNNING` status flag.
- The [MCP server](api.md#mcp-server) is reachable and returns real tool results to a real caller.

It's still just one path through one engine (Postgres) and one deploy shape (`IMAGE` source) — it's a
smoke test, not full coverage. Extending it to MySQL/Redis/Mongo or a `GIT`-source build is a natural next
slice.
