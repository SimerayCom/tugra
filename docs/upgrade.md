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
local agent and pre-pulls the updater image. The sidecar runs `scripts/update.sh` from the mounted checkout, so an
install only gains a new updater capability (the snapshot, the compose/script updates below) after that checkout is
updated once with `git pull && ./scripts/install.sh` (below).

### Releases that change the compose file or the scripts

A release can change files that live in your checkout rather than in an image: `deploy/docker-compose.yml` and the
installer/updater shell scripts (`scripts/*.sh`, `scripts/lib/*.sh`). The in-app updater applies those too, so a
plain **Update now** is enough — no `git pull`. Each release publishes them next to the signed manifest under
`host/<version>/`, with a `HOSTFILES` list (sha256 per file) signed by the **same publisher key** as `versions.json`;
the signed `versions.json` commits to that list's sha256 (`hostFilesDigest`). The sidecar does not take file content
from the hub or Redis: it downloads and verifies everything itself.

1. **Verify.** It fetches `HOSTFILES` + `.sig` from the manifest's own location (`UPDATE_MANIFEST_URL`, https only),
   checks the ed25519 signature with `UPDATE_PUBLISHER_KEY` (or the official key), checks that the list's sha256 is the
   one the signed manifest committed to, and that the list is for exactly this version. Paths are restricted to the
   compose file and `scripts/**/*.sh`; `.env` and anything else can never be named. Only files that differ from your
   checkout are downloaded, and each must match its signed hash.
2. **Validate**, before changing anything: every script must parse (`bash -n`), the new compose file must be valid
   against your real `.env` (`docker compose config`), and it must not need a setting your `.env` lacks. If it does,
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
   the compose file changed a one-shot helper container recreates the `tugra-updater` service itself — a container
   cannot recreate itself — so a changed updater definition or image takes effect without an installer run.

The common case — only the images changed — is a fast path: the sidecar fetches the small signed list, sees your
checkout already matches, and downloads and changes nothing. Releases published before this feature, and manifests
without `hostFilesDigest`, update images only, exactly as before; if verification fails for any reason the update is
refused with nothing changed (the owner sees the reason on the Updates card). `TUGRA_UPDATE_CHECKS=0` stays a hard off:
nothing is fetched, and the hub queues no update.

Notes:

- Local edits to `deploy/docker-compose.yml` or the scripts are overwritten by a release that changes them (the previous
  copy is in the backup directory). Keep configuration in `.env`.
- The sidecar records what it applied in `.tugra-host-applied`. On a `git` checkout the applied files show as modified;
  re-running `bootstrap.sh` resets them automatically, and for a manual `git pull` run
  `awk '{print $2}' .tugra-host-applied | xargs git checkout --` first.
- The updater image needs `curl` and `openssl` to verify files; it has them from the release that introduced this
  feature. An older updater image refuses a release that changes compose/scripts ("run `git pull && ./scripts/install.sh`
  once to refresh it") instead of applying anything unverified.
- Not covered (still `git pull && ./scripts/install.sh`): `Dockerfile.*` and other repository files (they only matter for
  `--build`), and a release that needs a brand-new `.env` setting.

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
