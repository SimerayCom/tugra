# Upgrade

Tugra can update itself in place from the web UI, or you can upgrade manually by re-running the
installer. Both paths preserve your data and secrets.

## How updates work

**Update checks are OFF by default** — Tugra never pings for
a new version on its own. Turn them on explicitly, either at install
(`install.sh --enable-update-checks`) or any time by setting `UPDATE_MANIFEST_URL` + `UPDATE_PUBLISHER_KEY`
in `.env` and restarting hub-api. With checks off, upgrade manually by re-running the installer, and watch
GitHub releases for security advisories.

(Separate from update checks: anonymous usage stats are on by default — aggregate counts plus your version, edition and OS under a random id; no names, IPs, domains or secrets, and the receiver doesn't store your IP — and you can turn them off anytime with `--no-telemetry`, `TUGRA_TELEMETRY=0`, or in Settings. **Upgrading from a pre-telemetry release?** The stats turn on with this upgrade; opt out in Settings → Anonymous usage stats, or set `TUGRA_TELEMETRY=0`.)

Once enabled, Tugra checks a **publisher-signed release manifest** (`versions.json` + a detached ed25519
signature). Before any update is applied the hub:

- verifies the manifest's **ed25519 signature** against the publisher key you configured;
- refuses a **downgrade** and refuses to **skip a required intermediate version**;
- applies **patch releases automatically** (when auto-update is on) but always waits for an explicit
  owner click for a **minor/major** release.

The publisher side of this — how releases and the signed manifest are produced — is documented in
[Releasing](RELEASING.md).

## In-app update

1. As the owner, open **Settings → Updates**. The card shows the current and latest version and the
   release channel (stable/beta).
2. Configure the manifest source so the hub can check for updates — set `UPDATE_MANIFEST_URL` and
   `UPDATE_PUBLISHER_KEY` (see [`.env.example`](../.env.example)). For official builds use the values
   under [Configuring update checks](#configuring-update-checks) below; a self-signed build uses its
   own published key instead.
3. Click **Update now** (or enable patch-only auto-update).

Applying an update recreates the hub and web containers, so the hub can't do it itself — a small
[`tugra-updater`](../SECURITY.md) sidecar drains a Redis queue and performs the recreate, then the
UI reconnects to the new version. Its security surface is documented in [SECURITY.md](../SECURITY.md).

## Manual upgrade

Re-running the installer is a safe upgrade path — it keeps your secrets and only updates configuration:

```bash
cd tugra
git pull
./scripts/install.sh
```

This pulls (or rebuilds) the images referenced by your checkout and recreates the stack. Use it when
you prefer git-driven upgrades or haven't configured the signed-manifest source.

## Configuring update checks

| Key | Purpose |
|---|---|
| `UPDATE_MANIFEST_URL` | URL of the signed `versions.json` (the `.sig` is fetched alongside it). Official builds: `https://simeraycom.github.io/tugra/versions.json`. |
| `UPDATE_PUBLISHER_KEY` | The publisher's ed25519 public key (base64), used to verify the manifest. Official builds: `MCowBQYDK2VwAyEA4+vvlIQS9SWHEKc0Fo1UD2ZW+DSl0AJA9hOK5NeiXBE=`. |
| `UPDATE_CHECK_INTERVAL_MIN` | Minutes between background version checks (default 1440 = daily). |
| `UPDATE_CHANGELOG_URL` | Optional changelog URL surfaced next to an available update. |

Setting `UPDATE_MANIFEST_URL` without `UPDATE_PUBLISHER_KEY` is rejected at boot (fail-closed — an
unsigned manifest is never trusted). Leave both empty to disable update checks.

## Rollback & troubleshooting

If an image **pull** fails nothing has been recreated, so the running stack is untouched. If a **recreate or
health check** fails after the pull, the sidecar actively restores the previous version — it rewrites
`TUGRA_VERSION`, recreates hub-api + web, and verifies both become healthy — then marks the update `failed`.
If that restore cannot be completed and verified, the status becomes **`recovery_required`**: the stack may
be partly updated and needs manual recovery. The sidecar logs the exact command, which is:

```sh
# set TUGRA_VERSION=<previous version> in .env, then:
docker compose --env-file .env -f deploy/docker-compose.yml up -d --no-deps hub-api web
```

**Database migrations are NOT rolled back.** A newer image runs `prisma migrate deploy` at boot, so its
schema changes persist even after the image tag is restored, and the old image may be incompatible with the
migrated schema (this is often why a failed health check ends in `recovery_required`). **Take a database
backup before updating a production instance** so you have a restore point.

## Publishing releases (maintainers)

Cutting a release, generating the publisher keypair, and publishing the signed manifest are covered in
[Releasing](RELEASING.md).
