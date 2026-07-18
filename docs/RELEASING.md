# Releasing Tugra

Cutting a release builds and pushes the four container images to GHCR and publishes a **signed update
manifest** (`versions.json` + detached `versions.json.sig`) that self-hosted instances verify before
applying an update. The pipeline lives in [`.github/workflows/release.yml`](../.github/workflows/release.yml).

## One-time setup

1. **Generate the publisher signing keypair** (once, ever — rotating it forces every instance to update
   its `UPDATE_PUBLISHER_KEY`):

   ```sh
   node scripts/keygen-publisher.mjs
   ```

   It prints two values and writes no files:
   - `UPDATE_SIGNING_KEY` — the **private** seed. Add it as a GitHub Actions **repository secret** named
     `UPDATE_SIGNING_KEY`. Never commit it.
   - `UPDATE_PUBLISHER_KEY` — the **public** key. Publish it in the release notes / docs so operators can
     set it on their instances. This is what verifies every update.

2. **GitHub Pages**: the manifest is published to the `gh-pages` branch. The first release creates the
   branch automatically; enable Pages for the repo (Settings → Pages → *Deploy from branch* → `gh-pages`).
   The manifest is then served at `https://mrcandev.github.io/tugra/versions.json` (the `.sig` sits beside
   it). To use a custom domain later, add a `CNAME` file to `gh-pages` — `keep_files` preserves it and only
   the URL operators configure changes.

## Cutting a release

1. Make sure the commit is **green on `main`** — the release workflow does not re-run the CI test suite
   (a tag push doesn't match `ci.yml`'s branch trigger).
2. Bump the root `package.json` `version` to match the tag (cosmetic; the tag is the source of truth).
3. Tag and push:

   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```

   A pre-release tag (`v0.2.0-beta.1`) ships to the **beta** channel and never moves `latest`. You can also
   run the workflow manually (Actions → *Release* → *Run workflow*) with a `version` and an optional
   `min_upgrade_from` (the minimum version required to upgrade directly to this release).
4. The workflow:
   - builds + pushes `ghcr.io/mrcandev/tugra-{hub,web,agent,updater}:<version>` (and `:latest` for stable).
     The **agent is multi-arch** (`linux/amd64,linux/arm64`); hub/web/updater are `amd64`.
   - signs a merged `versions.json` (updating only the released channel, preserving the other) and pushes
     it + its `.sig` to `gh-pages`. The signer self-verifies against the real consumer verifier and refuses
     to publish anything that wouldn't validate.

## First-release checklist

- [ ] `UPDATE_SIGNING_KEY` secret is set.
- [ ] After the first successful run, make the **four GHCR packages public** (they default to private, so
      anonymous `docker pull` in `install.sh` fails otherwise): each package → *Package settings* →
      *Change visibility* → Public.
- [ ] GitHub Pages is enabled on `gh-pages`.
- [ ] Smoke test the published artifacts:

  ```sh
  docker run --rm ghcr.io/mrcandev/tugra-agent:<version> --version   # prints the real version, not 0.0.0-dev
  curl -s https://mrcandev.github.io/tugra/versions.json | jq .tugra.stable.version
  ```

## Notes & caveats

- **Control-plane arch:** hub/web/updater are published `amd64`-only. A Raspberry-Pi / arm64 control plane
  should install with `./scripts/install.sh --build` (builds from source natively). The **agent** runs on
  managed servers of any arch and is always multi-arch.
- **Published web image URL:** the `tugra-web` image bakes no `NEXT_PUBLIC_API_URL`; the SPA resolves the
  hub origin at runtime (`window.location.origin`). This makes the published image work out of the box for
  a single-origin (`--domain`) reverse-proxy deployment. A split-port deployment that needs a fixed
  absolute hub URL for the terminal WebSocket should build from source (`--build`) with `NEXT_PUBLIC_API_URL`
  set (compose passes it automatically from `HUB_PUBLIC_URL`).
- **Key rotation** is a coordinated event: a new publisher key breaks updates for every instance until each
  updates its `UPDATE_PUBLISHER_KEY`. Treat the signing key as long-lived.
- The four Dockerfiles live in [`deploy/`](../deploy/) (committed). The copies under `local/` are only for
  local dev and are redundant with these.
