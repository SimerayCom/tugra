# Troubleshooting: volumes and mounts

"I redeployed and my data is gone" is almost always one of three things. This page explains how Tugra
persists data, so you can tell which one it is.

## The rule in one sentence

**Only data in a declared volume survives a redeploy.** Every deploy starts a *new* container from the image.
Anything the app wrote to the container's own filesystem (uploads, SQLite files, `.env` edits made at runtime)
is discarded with the old container.

## Single-container apps (Git, Image, Dockerfile, static)

### How volumes work

You declare volumes on the app as `{ name, path }` pairs: `path` is where it is mounted inside the container,
`name` identifies it.

- Tugra creates a Docker **named volume** called `tugra_appv_<appId>_<name>` and mounts it with
  `-v tugra_appv_<appId>_<name>:<path>` (`apps/hub-api/src/deploy/deploy-script.ts`, `appVolumeName` and the
  run-args builder).
- The volume is reused by every later deploy, restart, rollback and recreate. It is not recreated or emptied.
- Rules (`SetVolumesSchema`, `apps/hub-api/src/applications/dto.ts`): `name` is lowercase `[a-z0-9_-]`, max 41
  chars; `path` must be absolute and use only `[A-Za-z0-9._/-]`; at most 20 volumes per app; names unique.

```bash
tugra api PUT /apps/<appId>/volumes --data '{"volumes":[{"name":"data","path":"/app/data"}]}'
```

Changing the volume list takes effect on the **next deploy** (the running container is not re-mounted live).

### Named vs bind

- **Named volumes (the Tugra way):** declared as above. Docker owns the storage; Tugra can back it up, list
  its files and delete it with the app.
- **Bind mounts of host paths** are not part of the app's volume model. They are only reachable through the
  advanced raw `dockerOptions` field (`-v`/`--mount`), and Tugra rejects dangerous ones: `docker.sock` and
  sensitive host prefixes such as `/etc`, `/root`, `/home`, `/var`, `/opt`, `/srv`, `/proc`, `/sys`
  (`docker-options-safety.ts`). A bare name (`-v mydata:/data`) is treated as a named volume and is allowed.
  Prefer a declared named volume: it is the only kind Tugra backs up and cleans up for you.

### "Do repo files get cleared on redeploy?"

Not in a way that affects your mounts. For Git apps Tugra clones the repo into `/etc/tugra/builds/<appId>`
and **deletes and re-clones that directory on every deploy** (`rm -rf <dir> && mkdir -p <dir>` in
`prepSteps`, `deploy-script.ts`). But that directory is only a **build context**: the result is a Docker image
(`tugra_<appId>:<version>`), and the container never bind-mounts the checkout. So the Dokploy-style trap,
where a bind mount that points into the cloned repo is wiped on redeploy, does not exist here. The corollary
is that files committed in your repo are baked into the image and are read-only in spirit: if the app writes
to them at runtime, those writes are lost on the next deploy unless that path is a declared volume.

### Symptoms and fixes

| Symptom | Cause | Fix |
|---|---|---|
| Uploads / SQLite / sessions vanish after each deploy | Path is not a declared volume | Add a volume whose `path` is the directory the app writes to, then redeploy. Existing data in the old container is not migrated, so copy it out first if you need it. |
| Volume mounted but app cannot write | Container user does not own the (new, root-owned) volume dir | Set ownership in the image/entrypoint, or run the app as a user that can write to `path`. |
| Data present but the image's files at `path` disappeared | A volume mounted over a path hides the image content there | Mount the volume on a dedicated subdirectory (`/app/data`), not on `/app`. |
| Deploy causes a short outage on an app with volumes | Zero-downtime rolling is disabled for apps with named volumes, because two overlapping containers would share one volume and could corrupt data (`rollingEligible`, `applications.service.ts`). Such apps use stop, start, health-gate, restore-previous-on-failure. | Expected. Keep `rollbackOnFailure` on so a bad deploy is restored automatically. |
| Data gone after deleting the app | Deleting an app removes its container **and its named volumes** (`buildRemoveScript`; compose uses `down -v`) | Take a volume backup first (below). |

### Inspecting and backing up

- List files in a declared volume (read-only metadata, never content): `GET /apps/<appId>/files?volume=<name>&path=`
  (requires the `read:secrets` scope; only volumes the app declares can be listed).
- Back up: the `apps/<appId>/volume-backups` API (`volume-backups.controller.ts`) offers backup-now, restore,
  a scheduled config (`PUT .../volume-backups/config`), import-from-URL and a migration export URL. Only an S3
  destination can produce an export URL.
- Moving volumes from Coolify is still a manual `tar` copy: see [Coolify migration](../coolify-migration.md).

### Clusters (Swarm)

A named volume is node-local. When an app that has volumes is put on a cluster, Tugra **hard-pins it to the
cluster's swarm manager** and requires `replicas = 1`, so the single replica always lands on its data
(`setClusterConfig` / `setVolumes`, `applications.service.ts`). Adding a volume to a clustered app with
`replicas > 1` is rejected: lower replicas to 1 first. Removing all volumes does not automatically unpin it.

## Compose apps

A compose app stores your `docker-compose.yml` text in Tugra. On each deploy the agent writes it to
`/etc/tugra/compose/<appId>/docker-compose.yml` and runs it under the project name `tugra_<appId>`
(`compose-script.ts`). There is no repo checkout involved, so there is nothing to be "cleared".

What this means for persistence:

- **Redeploys use `docker compose up -d --remove-orphans` and never `down`.** Compose **named volumes**
  (declared under top-level `volumes:`) and anonymous volumes survive. So do relative binds such as `./data`
  (they resolve under `/etc/tugra/compose/<appId>/`).
- **The whole directory is removed only when the app is deleted** (`buildComposeDownScript` runs
  `down -v` then `rm -rf /etc/tugra/compose/<appId>`). That deletes the stack's volumes **and** any relative
  bind data. Back up first.
- **Prefer named volumes over `./data`** in compose: they are Docker-managed and clearly separate from
  Tugra's own files in that directory.
- Editing the compose file or env in the UI and redeploying rewrites `docker-compose.yml` and `.env`
  (mode 600) from what Tugra has stored. Hand edits made on the server to those two files are overwritten
  on the next deploy. Make changes in Tugra.

### Config-file mounts (templates)

Catalog templates that need a config file (for example an `nginx.conf`) use **config mounts**: Tugra writes
each file (resolving `${KEY}` placeholders from the app env) to `/etc/tugra/compose/<appId>/mounts/<index>`
and adds a **read-only** bind into the named service through a second file,
`docker-compose.tugra.yml`, passed with `-f` (`compose-script.ts`, `composeOverride`). Consequences:

- Edit the template's file in Tugra and redeploy, never inside the container: the mount is read-only and the
  file is regenerated on every deploy.
- Your own compose file is never rewritten; the mount lives only in the override.

### Your own compose override and what is rejected

A fork-free `composeOverride` is parsed and validated before it is accepted (`compose-safety.ts`). These pass:
named volumes, anonymous volumes (`- /var/lib/mysql`), long-syntax `type: volume`, and contained relative
paths (`./data`). These are rejected with a 400:

- binding `docker.sock`, or a host path under `/etc`, `/root`, `/home`, `/var`, `/opt`, `/srv`, `/usr`, `/proc`,
  `/sys`, `/dev`, `/boot` (only `/etc/localtime` and `/etc/timezone` are allowed);
- a bind source using `${VAR}` interpolation (it must be a literal path);
- a relative path that climbs out with `..`;
- `volumes_from`, `external_links`, `build`, `extends`, top-level `secrets`/`configs`, `privileged`, `devices`,
  host namespaces, and a top-level volume that binds a sensitive `device:`.

If you hit one of these, convert the mount to a named volume.

## Quick checklist

1. Is the path the app writes to listed under the app's volumes? If not, add it.
2. Did you redeploy after changing volumes? The list applies on the next deploy.
3. Is it a Compose app? Use named volumes; know that deleting the app deletes them.
4. On a cluster? Expect a single replica pinned to the manager.
5. Before deleting an app or migrating, run a volume backup.
