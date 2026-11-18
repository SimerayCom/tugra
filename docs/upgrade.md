# Upgrade

Tugra can update itself in place from the web UI, or you can upgrade manually by re-running the
installer. Both paths preserve your data and secrets.

## How updates work

Update checks are **on by default**: once an hour, and whenever someone opens the panel, the hub fetches one
publisher-signed manifest (`versions.json` + `.sig`, ~2 KB, no identifiers). Turn them off with
`install.sh --no-update-checks` or `TUGRA_UPDATE_CHECKS=0` in `.env` (restart hub-api); with checks off, upgrade
manually by re-running the installer and watch GitHub releases for security advisories. The channel is automatic:
a beta build tracks beta, a release build tracks stable; pin one in Settings → Updates.

(Separate from update checks: anonymous usage stats are on by default — aggregate counts plus your version, edition and OS under a random id; no names, IPs, domains or secrets, and the receiver doesn't store your IP — and you can turn them off anytime with `--no-telemetry`, `TUGRA_TELEMETRY=0`, or in Settings. **Upgrading from a pre-telemetry release?** The stats turn on with this upgrade; opt out in Settings → Anonymous usage stats, or set `TUGRA_TELEMETRY=0`.)

The manifest is a `versions.json` with a detached ed25519 signature. Before any update is applied the hub:

- verifies the manifest's **ed25519 signature** against the publisher key (built into official builds, or the one you configured);
- refuses a **downgrade** and refuses to **skip a required intermediate version**;
- applies **patch releases, and the next beta while you run a beta,** automatically (when auto-update is on)
  but always waits for an explicit owner click for a **minor/major** release or the move from beta to stable.

The publisher side of this — how releases and the signed manifest are produced — is documented in
[Releasing](RELEASING.md).

## In-app update

1. As the owner, open **Settings → Updates**. The card shows the current and latest version and the
   release channel (stable/beta).
2. Official builds need no configuration. A self-built release sets `UPDATE_MANIFEST_URL` +
   `UPDATE_PUBLISHER_KEY` to its own manifest and key (see [Configuring update checks](#configuring-update-checks)
   below and [`.env.example`](../.env.example)).
3. Click **Update now** (or enable auto-update for patch releases and the next beta).

When the signed manifest carries image digests (`imageDigests`, published by releases that include them), the
update is **digest-pinned**: the hub queues the release's `hub`/`web` OCI index digests, the sidecar writes them
to `.env` as `TUGRA_HUB_DIGEST` / `TUGRA_WEB_DIGEST` (compose then pulls `repo:<version>@sha256:…`, so a
moved or re-pushed tag can't change what is pulled), and after the pull it checks the image's
`org.opencontainers.image.version` label equals the target before recreating anything. For a digest-pinned
update this check fails closed: an image without the label, or one that cannot be inspected, is rolled back
(every release that publishes digests also carries the label, so an unlabelled image is an older release). Older manifests without digests keep updating by tag, exactly as before, and any previous
digest pin is cleared so it can't override the new tag. This pins *which bytes* are pulled; it does not yet
verify a signature on the image itself. The sidecar runs `update.sh` and the compose file from your checkout
(they are bind-mounted), so the digest path takes effect after a `git pull` + installer re-run; a checkout
without digest support in its compose file safely keeps pulling by tag.

Before anything changes, the sidecar takes a **pre-update restore point** — a `pg_dump -Fc` of the hub database
plus a copy of your `.env` — into `backups/` in the install directory (directory `0700`, files `0600`, the newest 5
sets kept; secret-bearing, gitignored). If it cannot be taken the update aborts with nothing changed (status
`failed`, "pre-update backup failed"). The updater refuses to start when the backup directory clearly lacks free space
for the dump; nothing is changed. `PRE_UPDATE_BACKUP=0` in `.env` disables it (not recommended); tune with
`PRE_UPDATE_KEEP` and `TUGRA_BACKUP_DIR`. For the in-app updater `TUGRA_BACKUP_DIR` must be an absolute path
**inside the checkout** (that is the only directory the sidecar has mounted); otherwise the update is refused
with "pre-update backup failed". The installer (`install.sh`) accepts any path. After hub-api and web are healthy the sidecar also refreshes the bundled
local agent, pre-pulls the updater image and then recreates the updater itself on that image (see below). The sidecar runs `scripts/update.sh` from the mounted checkout, so an
install only gains a new updater capability (the snapshot, the compose/script updates below) after that checkout is
updated once with `git pull && ./scripts/install.sh` (below).

### An update can not leave a half state

The order is built so that no failure can leave `.env` naming a release that is not installed:

1. **Disk preflight, before anything is written or pulled.** The updater measures the free space of the Docker data root
   (`docker info`'s `DockerRootDir`; from inside the sidecar through a throwaway container that mounts that path read-only)
   and of the install directory. The data root needs about twice the size of the release you run now plus 2 GiB (10 GiB
   when no Tugra image is on disk to measure), the install directory 256 MiB. When either is short, the safe cleanup
   from step 6 below runs once (only Tugra's own releases older than the running and the previous one) and the space is
   measured again. Still short: the update stops with status `failed` and the numbers, for example "needs about 20.0 GB
   free on /var/lib/docker, has 5.0 GB. Free some space ... then retry", and nothing was touched. `TUGRA_DISK_CHECK=0` in
   `.env` skips the check; a measurement that cannot be taken never blocks. The installer runs the same preflight before it pulls.
2. **Pull first, write `.env` last.** The images are pulled by the exact references the recreate will use (digest-pinned
   when the release publishes digests, else the tag), through a temporary copy of `.env`; then their version labels are
   checked. Only after both succeed is `.env` written, and every `.env` write is atomic: the new file is built next to
   it, verified, flushed to disk and renamed in, so a full disk can only fail the write and leave the old file intact.
   A failure before that point has nothing to roll back.
3. **A half-finished update is repaired, not refused.** If `.env` already names a release newer than the one the containers
   run (a crash, a full disk, or an updater from before this change), **Update now** resumes it: it pulls what is missing and
   recreates, or, when the target cannot be pulled, puts `.env` back to the running release. The updater also checks this
   when it starts; Settings > Updates then explains it and offers **Finish update**. The status text always carries the
   cause (the disk numbers, the failing pull, the version-label mismatch), never just "Update failed".

### Releases that change the compose file or the scripts

A release can change files that live in your checkout rather than in an image: `deploy/docker-compose.yml` and the
installer/updater shell scripts (`scripts/*.sh`, `scripts/lib/*.sh`). The in-app updater applies those too, so a
plain **Update now** is enough for the common case — no `git pull`. The updater recreates only `hub-api`, `web`,
`agent` and `tugra-updater`, so a release whose compose file also changes (or adds) any other service, such as
`postgres`, `redis` or `traefik`, is refused with nothing changed and a pointer to `git pull && ./scripts/install.sh`
(below). Each release publishes them next to the signed manifest under
`host/<version>/`, with a `HOSTFILES` list (sha256 per file) signed by the **same publisher key** as `versions.json`;
the signed `versions.json` commits to that list's sha256 (`hostFilesDigest`). The sidecar does not take file content
from the hub or Redis: it downloads and verifies everything itself.

1. **Verify.** It fetches `HOSTFILES` + `.sig` from the manifest's own location (`UPDATE_MANIFEST_URL`, https only),
   checks the ed25519 signature with `UPDATE_PUBLISHER_KEY` (or the official key), checks that the list's sha256 is the
   one the signed manifest committed to, and that the list is for exactly this version. Paths are restricted to the
   compose file and `scripts/**/*.sh`; `.env` and anything else can never be named. Only files that differ from your
   checkout are downloaded, and each must match its signed hash.
2. **Validate**, before changing anything: every script must parse (`bash -n`), the new compose file must be valid
   against your real `.env` (`docker compose config`), it must only change the services the updater recreates
   (compared with `docker compose config --hash`), and it must not need a setting your `.env` lacks. If it does,
   the update stops with nothing changed and tells you to run `git pull && ./scripts/install.sh`, which generates
   the new setting.
3. **Back up and apply.** After the pre-update restore point, the files about to change are copied to
   `backups/host-files-<from>-to-<to>-<timestamp>/` (directory `0700`, newest 5 kept) and replaced with atomic renames.
   Your `.env` is never touched by this step — it keeps every line; only `TUGRA_VERSION` (and the digest pins) move,
   exactly as before.
4. **Roll back automatically.** If the image pull, the recreate or the health check then fails, the previous compose
   file and scripts are put back first and the previous version is recreated from them and verified. If that cannot be
   completed the status is `recovery_required` and names the backup directory.
5. **Finish.** Replaced scripts take effect immediately (the sidecar restarts its own loop on the new code), and when
   the compose file changed, or the running updater is on an older image than the one the compose file now names
   (every release moves the image tag, even one that changes no file), a one-shot helper container recreates the
   `tugra-updater` service itself — a container cannot recreate itself — so a changed updater definition or image
   takes effect without an installer run. This happens last, after the update is reported done; if the helper
   cannot start the old updater keeps running and the next update retries. An updater that is still on an older
   image when it starts (for example after a release whose scripts predate this) refreshes itself once, before it
   takes any job.

6. **Clean up.** Every release adds roughly 8 GB of images (hub, web, agent, updater) and nothing used to remove the old
   ones. After a verified update the sidecar removes Tugra's **own** release images older than the previous release:
   the running one and the one before it (your rollback) stay, an image used by any container is refused by Docker and
   stays, and nothing that is not a Tugra release image (apps, databases, Traefik, your own tags, `latest`) is touched.
   Digest-pinned pulls leave no tag locally, so the release is read from the image's version label. The log says what
   was freed. Opt out with `TUGRA_PRUNE_IMAGES=0` in `.env`. The installer reports what could be freed and removes it
   with `--prune-images`.

The local agent is pulled by the signed per-platform image digest, and the updater image with a plain `docker pull` (not
`docker compose pull`, which failed on engines that use the containerd image store because the release tag also lists
BuildKit attestation entries). Re-running the installer on the version you already run keeps the newest older release it
finds on disk as the rollback, instead of treating the current one as "the previous".

**An install whose updater predates all of this** (an old `tugra-updater` image and an old `scripts/update.sh` ignore the
signed compose/scripts, never refresh the updater and cannot even report their version) converges without an installer
run: shortly after the hub restarts on the new release it asks the local agent, once per release and never while an
update is queued or running, to pull the release's updater image by its signed digest, apply the release's signed
compose/scripts to the checkout (same signature checks, backup and validation as above) and recreate the updater and
the bundled agent with a detached helper; the same helper then removes the old release images (the old script never did).
The update lock is held for the whole operation, so an "Update now" cannot start a job that the recreate would cut off.
An agent that lags on an install without an updater container is refreshed the same way. **Settings → Updates** shows the update helper's version and says when it lags
or when this did not finish (then run `./scripts/install.sh` once).

The common case — only the images changed — is a fast path: the sidecar fetches the small signed list, sees your
checkout already matches, and downloads and changes nothing. Releases published before this feature, and manifests
without `hostFilesDigest`, update images only, exactly as before; if verification fails for any reason the update is
refused with nothing changed (the owner sees the reason on the Updates card). `TUGRA_UPDATE_CHECKS=0` stays a hard off:
nothing is fetched, and the hub queues no update.

Notes:

- Local edits to `deploy/docker-compose.yml` or the scripts are overwritten by a release that changes them (the previous
  copy is in the backup directory). Keep configuration in `.env`.
- **Git state of the checkout.** The files the updater writes are byte-identical to the release, but a `git` checkout
  would show them as modified (and a new script as untracked), and `git pull` / `git checkout <tag>` then refuse with
  "Your local changes ... would be overwritten". So after a successful update the sidecar moves the checkout to the
  release tag `v<version>` (fetching just that tag when the checkout does not have it) when every modified compose/script
  file has exactly that tag's content; `git status` is clean afterwards. A branch that can fast-forward keeps its name
  (`git pull` keeps working), otherwise the checkout is detached at the tag; local commits that no branch contains are
  first kept on a `tugra-local-<sha>` branch. It never discards anything:
  a compose/script file that you edited yourself (it differs from both your checkout's `HEAD` and the release) is still
  replaced by the release copy as above, but is reported in the log, listed in `LOCAL-EDITS` inside the backup
  directory, and git is then left alone; with no network (the tag cannot be fetched), no `git` in an older updater
  image, or other local changes git refuses to carry over, git is left exactly as it was and the log says why. Switch it
  off with `TUGRA_CHECKOUT_SYNC=0` in `.env`.
- **If `git pull` refuses on such a checkout** (an older updater, or one of the cases above), run
  `TUGRA_VERSION=<the version you run> ./scripts/install.sh --sync-checkout`: it performs the same move (checking again
  that every modified compose/script file equals the release, and never discarding a real edit) and does nothing else.
  A normal `TUGRA_VERSION=<version> ./scripts/install.sh` does the same step first and then carries on with the install,
  so a re-run on a checkout dirtied only by the updater's files proceeds instead of stopping. After that,
  `git pull` works on a branch checkout; on a detached one use `git checkout main && git pull` (or
  `git fetch --tags && git checkout v<newer>`).
- The sidecar records what it applied in `.tugra-host-applied`. Re-running `bootstrap.sh` also resets the applied
  files that still match that record.
- The updater image needs `curl` and `openssl` to verify files; it has them from the release that introduced this
  feature. An older updater image refuses a release that changes compose/scripts ("run `git pull && ./scripts/install.sh`
  once to refresh it") instead of applying anything unverified.
- Not covered (still `git pull && ./scripts/install.sh`): `Dockerfile.*` and other repository files (they only matter for
  `--build`), a release that needs a brand-new `.env` setting, and a release whose compose file changes or adds a service
  other than `hub-api`, `web`, `agent` and `tugra-updater`.
- A custom `UPDATE_MANIFEST_URL` mirror must be https and must also host `host/<version>/` (the `HOSTFILES`,
  `HOSTFILES.sig` and the files) next to `versions.json`, i.e. copy the whole `gh-pages` tree, not only the manifest.
  When a release carries `hostFilesDigest` and that location cannot be fetched, the update is refused with nothing
  changed; it is never silently reduced to an images-only update.
- `.env` values may be quoted (`UPDATE_MANIFEST_URL=""` means unset, `TUGRA_UPDATE_CHECKS="0"` means off), the same way
  docker compose reads them.

Applying an update recreates the hub and web containers, so the hub can't do it itself — a small
[`tugra-updater`](../SECURITY.md) sidecar drains a Redis queue and performs the recreate, then the
UI reconnects to the new version. Its security surface is documented in [SECURITY.md](../SECURITY.md).

## Manual upgrade

Re-running the installer is a safe upgrade path — it keeps your secrets and only updates configuration. Use it for
the one-time step that gives an older checkout the compose/script updates above, for a release that needs a new `.env`
setting, or whenever you prefer git-driven upgrades:

```bash
cd tugra
git pull
./scripts/install.sh
```

(If `git pull` refuses because the in-app updater modified `deploy/docker-compose.yml` or the scripts, see
[Git state of the checkout](#releases-that-change-the-compose-file-or-the-scripts) above:
`TUGRA_VERSION=<version> ./scripts/install.sh --sync-checkout` makes the checkout clean again.)

This pulls (or rebuilds) the images referenced by your checkout and recreates the stack. A digest pin left by the
self-updater is kept on a plain re-run, and cleared when you re-pin with `TUGRA_VERSION=…` or build from source with
`--build`. When the stack is
already running, first takes the same pre-update restore point as above (aborting if it fails). A failed pull on a
pinned `TUGRA_VERSION`, or any pull failure other than "no such image for this architecture", stops instead of
silently building unreleased code from the checkout (use `--build` to build deliberately). Use it when you prefer
git-driven upgrades or run with update checks turned off. (A checkout made by `bootstrap.sh` with a
branch `TUGRA_REF` tracks that branch, so `git pull` works. A tag- or SHA-pinned install is detached by design:
upgrade it by re-running bootstrap with a new `TUGRA_REF`, not with `git pull`.)

### GitHub sign-in on a two-port or split-host install

Earlier betas registered `<HUB_PUBLIC_URL>/auth/oauth/github/callback` with GitHub. When the web and hub run on
different ports or hosts (the raw install), the callback is now served on the web origin:
`<WEB_PUBLIC_URL>/api/auth/oauth/github/callback`. After upgrading, either update the callback URL in your GitHub
OAuth app to that address, or set `GITHUB_OAUTH_CALLBACK_URL` to the URL you already registered. Single-origin
(`--domain`) installs are unchanged. Open the panel at exactly `WEB_PUBLIC_URL` when signing in with GitHub.

## Configuring update checks

| Key | Purpose |
|---|---|
| `TUGRA_UPDATE_CHECKS` | `0` turns update checks off for this deployment (`install.sh --no-update-checks`); unset or `1` = on. |
| `UPDATE_MANIFEST_URL` | URL of the signed `versions.json` (the `.sig` is fetched alongside it). Official builds: `https://simeraycom.github.io/tugra/versions.json`. |
| `UPDATE_PUBLISHER_KEY` | The publisher's ed25519 public key (base64), used to verify the manifest. Official builds: `MCowBQYDK2VwAyEA4+vvlIQS9SWHEKc0Fo1UD2ZW+DSl0AJA9hOK5NeiXBE=`. |
| `UPDATE_CHECK_INTERVAL_MIN` | Minutes between background version checks (default 60 = hourly). Opening the panel also triggers a check when the last one is stale. |
| `UPDATE_CHANGELOG_URL` | Optional changelog URL surfaced next to an available update. |

Setting `UPDATE_MANIFEST_URL` without `UPDATE_PUBLISHER_KEY` is rejected at boot (fail-closed — an
unsigned manifest is never trusted). When both URL and key are blank the official values are used; set both to
point at your own signed manifest. Use `TUGRA_UPDATE_CHECKS=0` to disable update checks.

### Upgrading from beta.16 or earlier

Hubs on `0.1.0-beta.16` or older have no working update check, so the first upgrade to a release with automatic
checks is manual: `git pull && ./scripts/install.sh`. After that the hub checks on its own. Checks turn **on**
with this upgrade (also on a hub that had left `UPDATE_MANIFEST_URL` blank to keep them off): to stay off, set
`TUGRA_UPDATE_CHECKS=0` in `.env` before the restart, or run the installer with `--no-update-checks`. A hub that
was pinned to Stable on a beta build is switched to Automatic (Beta) by this upgrade; pin Stable again in
Settings → Updates if that was deliberate.

## Rollback & troubleshooting

If an image **pull** fails nothing has been recreated, so the running stack is untouched (the release's compose/scripts,
if it changed them, are put back too). If a **recreate or
health check** fails after the pull, the sidecar actively restores the previous version — it puts the previous compose
file and scripts back, rewrites
`TUGRA_VERSION` (and the previous `TUGRA_HUB_DIGEST` / `TUGRA_WEB_DIGEST`, or clears them if the stack was
not pinned), recreates hub-api + web, and verifies both become healthy — then marks the update `failed`.
If that restore cannot be completed and verified, the status becomes **`recovery_required`**: the stack may
be partly updated and needs manual recovery. The sidecar logs the exact command, which is:

```sh
# set TUGRA_VERSION=<previous version> in .env (and the previous TUGRA_HUB_DIGEST / TUGRA_WEB_DIGEST if it
# was digest-pinned, or leave them empty); if the update replaced compose/scripts, copy the files from
# backups/host-files-<from>-to-<to>-<timestamp>/ back to the same paths in the checkout; then:
docker compose --env-file .env -f deploy/docker-compose.yml up -d --no-deps hub-api web
```

**Database migrations are NOT rolled back.** A newer image runs `prisma migrate deploy` at boot, so its
schema changes persist even after the image tag is restored, and the old image may be incompatible with the
migrated schema (this is often why a failed health check ends in `recovery_required`). The automatic
pre-update snapshot is your restore point: see
[Restoring a pre-update snapshot](disaster-recovery.md#restoring-a-pre-update-snapshot). Keep an additional
offsite copy for production instances.

## Publishing releases (maintainers)

Cutting a release, generating the publisher keypair, and publishing the signed manifest are covered in
[Releasing](RELEASING.md).
