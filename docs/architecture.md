# Architecture

Tugra is a monorepo with one control plane (the hub), a web UI, a lightweight per-server agent, and
shared/client packages, deployed as a Docker Compose stack.

## Repository layout

| Path | Contents |
|---|---|
| `apps/hub-api/` | The hub — NestJS control plane (the "brain"). |
| `apps/web/` | The web UI — Next.js. |
| `agent/` | The per-server agent — a single Go binary. |
| `packages/shared/` | `@tugra/shared` — types + helpers shared by hub and web. |
| `packages/cli/` | `tugra-cli` — the `tugra` command-line client. |
| `deploy/` | Production `docker-compose.yml` + Dockerfiles + the update sidecar. |
| `scripts/` | `install.sh`, `update.sh`, release tooling. |
| `.github/workflows/` | CI (`ci.yml`) and the release pipeline (`release.yml`). |

## Components

- **Hub (`apps/hub-api`)** — a NestJS app with ~50 feature modules (servers, applications, deploy,
  databases, backups, monitors, notifications, teams, projects, instance settings, update, …). It owns all
  state and secrets and is the only service that talks to the database.
- **Web (`apps/web`)** — a Next.js app. It reaches the hub through a same-origin `/api` proxy
  (`HUB_INTERNAL_URL`), so the browser session cookie stays same-origin and the web container holds no
  secrets.
- **Agent (`agent/`)** — a Go binary installed on each managed server. It **dials out** to the hub over
  WSS (no inbound ports), enrolls with its own key, and executes signed commands. It self-updates via a
  hub-signed, digest-pinned image (see [upgrade](upgrade.md)).

## Data plane

- **PostgreSQL** (via Prisma) — the system of record.
- **Redis / BullMQ** — background jobs (backups, notifications, metrics rollups) and the self-update queue.

## Networking & routing

The REST API is served under the versioned prefix **`/api/v1`**, with a few bare, unversioned routes
(`/health`, `/version`, `/install/agent.sh`, `/install/migrator.sh`, `/webhooks/*`, `/auth/oauth/*`) that
external systems call at fixed paths. Two raw WebSocket endpoints are unprefixed: **`/agent`** (agent
enrollment + commands) and **`/terminal`** (the web terminal). For a TLS deployment's reverse-proxy path
routing, see [install](install.md#production-tls--a-domain).

The one-click [Coolify data migrator](coolify-migration.md) is a **separate one-shot container** that runs on
the untrusted *source* host (not the agent): it talks to the hub over the REST ingest API under
`/api/v1/import/migration/*` with a one-time token — never the agent WebSocket — and streams each database
dump to hub staging, from where the target agent restores it.

## Hub ↔ agent protocol

The agent connects out over WSS and authenticates with an ed25519 keypair. Every hub→agent command is
signed with the hub's key (which the agent pins on connect) and scoped to a granted capability, so a
compromised network path can neither forge commands nor exceed the server's granted capabilities. The
[security overview](security.md) covers this in context.

**The hub's address is not a single point of failure for the agent.** An agent keeps an *ordered list* of hub
endpoints in its state directory (`~/.tugra/endpoints.json`, on the same volume as its identity; initially just the
`--hub` it was installed with) and survives restarts and self-updates with it. When it cannot reach the hub it rotates
through the list with backoff (1 s up to 30 s per round), **always trying the primary first** after every drop, and the
install-time address stays as the last resort. The hub pushes the list in a signed **`hub_endpoints`** frame on every
connect and whenever it changes (agents advertise `hub_endpoints_v1`):

```json
{ "type": "hub_endpoints", "serverId": "…", "rev": 1731672000123,
  "endpointsJson": "[{\"url\":\"wss://panel.example.com/agent\"},{\"url\":\"wss://203.0.113.7/agent\",\"pin\":\"sha256:…\"}]",
  "sig": "<ed25519 over \"hep\\n<serverId>\\n<rev>\\n<endpointsJson>\">" }
```

The first entry is the primary, the rest are fallbacks (the current domain, the previous domain during a grace, the IP
route). The signature covers the exact JSON bytes and the **agent's own server id** (so a frame captured for another
server never verifies, although the hub key is fleet-wide); `rev` is wall-clock milliseconds, strictly increasing, and an
agent refuses a lower one (replay). The agent verifies it with the hub key **pinned at enroll** (`~/.tugra/agent.json`,
`hubKey`) — never with a key delivered by the endpoint it just dialled. A valid list that changes the primary makes the
agent reconnect, primary first, and only stay if that endpoint completes the handshake; otherwise it falls back to the
old one, which the list kept. After every handshake — and as the reply to every list — the agent reports
`hub_endpoint_state` (`rev`, the `active` endpoint of this very session, its `primary`, `accepted`/`error`), which the hub
stores per server (`Server.hubEndpoint*`). A session on a fallback re-checks the primary every two minutes and returns to
it when it answers. Agents that do not advertise the feature keep using the single URL they were installed with.

**Who is the hub?** Every endpoint — the install-time one and every pushed one — must present the pinned hub key, and
prove it holds it: the agent sends a fresh `hubNonce` in `auth`/`enroll` and the hub answers with `hubProof`, an ed25519
signature over `hubid\n<challenge>\n<hubNonce>` (the challenge is the hub's own per-connection nonce). A hub-pushed
endpoint always needs the proof; once any proof has been seen an agent refuses a hub that stops sending it (no downgrade),
and a different key than the pinned one is refused (`TUGRA_HUB_REPIN=1` accepts a changed `HUB_SIGNING_KEY` once). A
hub-pushed endpoint can never make an agent resend its enroll token (`reenroll` is honoured only on the install-time
address).

**Transport.** A domain uses its publicly trusted certificate. A hub on a bare IP (`http://<ip>/` install) serves
`wss://<ip>/agent` on :443 with **one persisted self-signed certificate** (ECDSA P-256, ~10 years, IP SAN, key encrypted at
rest in `InstanceSettings`; Traefik's default certificate for the host-less routes, so it never regenerates). The
add-server command carries its SHA-256 fingerprint (`--hub-pin sha256:…`) and the agent pins the **leaf** for that
endpoint (the installer itself is fetched with `curl --pinnedpubkey`); the same certificate is handed to `backup`
commands as `TUGRA_HUB_CACERT` so the signed file-transfer relay verifies it too. Plain `ws://` is accepted only to
loopback / a compose service name, or with the explicit `--hub-insecure` opt-in (the command says so and the UI warns);
a hub-pushed list can never downgrade an agent that installed over TLS to plaintext. The certificate changes only through
a signed `hub_endpoints` frame (the pin travels inside the list); nothing rotates it implicitly.

**Moving the panel without stranding agents.** Setting, changing or removing the panel domain pushes the new list to
every connected remote agent *before* the switch, and the hub keeps the **old host and the IP route answering `/agent`**
(plus the signed transfer relay) in the proxy — whatever happens to the panel itself — until every agent reports the new
endpoint, the owner presses *Stop waiting*, or 7 days pass (`InstanceSettings.agentEndpointGrace`, rendered by
`ProxyConfigService` into `agentHosts` / `agentIp`). Settings → Panel domain shows "N of M agents moved to the new
address" and the ones that did not (offline, still waiting, or too old to follow). A change that fails before the switch
points the agents back at the address that still works. Agents too old to understand `hub_endpoints` keep working on
their single URL because the old route is kept for them.

**Durable deploy commands and hub-restart recovery.** A deploy is one long shell command the hub sends and
awaits. Agents that advertise the `cmd_journal_v1` feature keep an on-disk *command journal*: the hub marks the
main deploy command `durable`, the agent records its start and its result (exit code, output head and tail,
whether it was cancelled), keeps running it if the WebSocket drops, never runs a re-sent request id twice, and
answers a signed `command_status` query from the journal. On the hub side every running deploy carries a
*lease* (the owning hub process, the agent request id, a recovery deadline and a frozen outcome plan). If the hub
restarts — or the agent's socket drops — mid-deploy, the deploy is **not** failed blind: it is kept running
and re-adopted when that agent reconnects, and settled from the journaled result exactly as the live path would
have settled it (success, failure, auto-rollback, cancelled). Only when the outcome genuinely cannot be known
(the agent process itself restarted, has no record, never answers, or the deadline passes) does the row settle
as "interrupted", and the application's status is left untouched. Agents without the feature — and the swarm,
build-server and rollback paths — keep the previous behaviour: a deploy still running at hub boot is marked
failed and must be re-deployed.

## File manager and the container filesystem

An app's **Files** tab talks to the hub's `/apps/{id}/files*` and `/apps/{id}/container-files*` routes. The hub resolves
the target (one of the app's declared volumes, or the running container of a single-container or Compose app), checks
the team permission (`apps:config`, plus `terminal` for the container filesystem), the policy (no changes while a deploy
is queued or running; a running database or broker volume needs an acknowledgement) and the server's capabilities, then
sends the agent a signed **`fs2_req`** (advertised by the agent as the `fs2_v1` feature). The signature covers every field
(length-prefixed, so no value can forge another), carries an expiry, and the agent keeps a replay cache; the agent
re-derives the capability set itself and drops anything the hub could not have been allowed to send.

| scope | operation | server capabilities required |
|---|---|---|
| volume | stat, read | `files` |
| volume | write, mkdir, rename, chmod, delete | `files`, `files_write` |
| container | list, stat, read | `files`, `terminal` |
| container | write, mkdir, rename, chmod, delete | `files`, `files_write`, `terminal` |

**Volumes.** The agent runs the operation in a one-shot helper container started from the agent's own image: no
network, read-only root, only the one named volume mounted at `/data`, and every path confined with `os.Root` (symbolic
links in a path are refused). Reads run with `DAC_READ_SEARCH` and the volume mounted read-only; writes run with `CHOWN`,
`DAC_OVERRIDE` and `FOWNER` and the volume mounted read-write. An upload never travels over the WebSocket: the hub
streams the browser's body to a private staging file while hashing it, hands the agent a relative, HMAC-signed,
single-use URL (the agent builds the host from its own configured hub address), and the agent writes the file through a
temporary file in the destination folder and renames it into place. A download is the reverse: the agent pushes the file
to a signed URL and the hub pipes it straight into the browser response, so nothing is stored on the hub.

**Container filesystem.** The agent uses `docker cp` (daemon-side, so it works on stopped and distroless containers; the
tar stream is parsed header by header and never extracted) for list, stat, read, write and mkdir, and a fixed-argument
`docker exec` for rename, chmod and delete. Because `docker cp` is performed by the Docker daemon, list, read, write and
mkdir act as container-root (they ignore the image's `USER` and file modes), whereas rename, chmod and delete run as the
image's default user, like the terminal. Changes are ephemeral and not atomic, and a very large directory lists only
its first part. Limitation: `docker cp` cannot read or write tmpfs mounts, and Docker refuses every `docker cp` write
into a container with a read-only root filesystem (even onto a tmpfs), so those paths report not found or read-only
for browse, read and write; rename, chmod and delete re-check from inside the container and do work on files that
exist in a tmpfs.

The web server streams file bodies through dedicated routes (Next's generic rewrite buffers and truncates request
bodies above 10 MiB); a hub behind a reverse proxy must also allow large request bodies on `/api/v1/apps/*/files/content`
and `/api/v1/agent-fs/t/*`, and parts of at most `MOVE_PART_MIB` on `/api/v1/agent-vx/t/*` (the app-move volume relay).

## Volume copies: backup restore, import and app move

A named volume is never read or written through the agent's own filesystem (the agent is a container with only
`/etc/tugra` and the docker socket bound). Every copy streams through a throwaway container of the pinned helper
image (`alpine:3.21` by digest, `BACKUP_HELPER_IMAGE`): `tar -cf -` out of the volume for a backup or a move pack,
and, for a restore, an import or a move apply, a *validate → snapshot → wipe → extract* sequence with a labelled
rollback volume, so a corrupt archive aborts before the wipe and a failed extract is rolled back (exit codes
0/72/71/70, `volume-backup-script.ts`). The move pack is gzip-split into fixed parts, checksummed per part, relayed
through the hub (`/api/v1/agent-vx/t/*`) and streamed twice on the target (validate, then extract), so no decoded
tar ever sits on disk. The move preflight probes both hosts the same way: free space and device id of the daemon's
real docker root and of the staging disk are read through a bind of the host path into the helper (or the agent's
own image when the helper is not on the host yet; the probe never pulls), and the target's listening ports come
from a `--network host` run of it (netstat, else `/proc/net/tcp{,6}`); if they cannot be listed the preflight fails
closed rather than assume none.

**Fidelity limit (BusyBox tar).** The extract is BusyBox `tar -xf` (ownership kept for our own archives, dropped with
`--no-same-owner` for an untrusted import). Content, modes, owners and mtimes of regular files, directory modes and
owners, hard links and symlink targets survive exactly; what BusyBox does not restore is the owner of a symlink
itself (`root:root` afterwards) and the mtime of non-empty directories and of symlinks (the unpack time). Extended
attributes, ACLs and sparse-file holes are not carried either. This is the same for restores, imports and moves and
is not a data loss, but an mtime-keyed cache may rebuild after one. A helper image with GNU tar would lift the
symlink/directory part (follow-up); the rollback snapshot uses `cp -a` and keeps all of it.

## Deployment

The [`deploy/docker-compose.yml`](../deploy/docker-compose.yml) stack is hub + web + PostgreSQL + Redis +
the `tugra-updater` sidecar (which applies in-app updates — see [upgrade](upgrade.md)). Releases are built
and signed by [`release.yml`](../.github/workflows/release.yml), which publishes container images and a
signed `versions.json` manifest (details in [Releasing](RELEASING.md)).

## Editions

The Community edition in this repository is the complete product; the proprietary Pro/Cloud layer lives
elsewhere. See [Open-core & editions](open-core.md). The API surface is documented in [api.md](api.md).
