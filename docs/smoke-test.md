# Real-VM smoke test

`scripts/smoke-vm.sh` is an end-to-end check that drives a **real** enrolled server — a real agent, real
Docker containers, a real `pg_dump`/`pg_restore`, a real deploy — straight through the public REST API,
and verifies backup/restore round-trips, a live deploy and the MCP endpoint against a real enrolled server.

## Why this exists

Tugra's CI runs the full unit and integration suite against real PostgreSQL and Redis, exercising the
agent protocol through an in-process test double so the hub's own logic is covered fast and
deterministically. This script is the complementary layer: it verifies the parts that only a real
machine can exercise — Docker, backup/restore round-trips and live deploys — against a server you enroll
yourself.

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
callable by a real client — all on a real server.

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
| `TUGRA_DB_ENGINE` | no | Default `POSTGRES`. |
| `TUGRA_DB_VERSION` | no | Default `16`. |
| `TUGRA_DB_HOST_PORT` | no | Default: a random port in 20000-39999. |
| `TUGRA_APP_IMAGE` | no | Default `traefik/whoami:latest`. |
| `TUGRA_APP_DOMAIN` | no | A real domain you already point at the server. When set, the app deploys with a real Let's Encrypt HTTPS domain; when unset, a free `sslip.io` "magic" domain is used for testing. |
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

Scope: PostgreSQL backup/restore, an image-source deploy and an MCP round-trip.
