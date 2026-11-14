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
   The manifest is then served at `https://simeraycom.github.io/tugra/versions.json` (the `.sig` sits beside
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
   - builds + pushes `ghcr.io/simeraycom/tugra-{hub,web,agent,updater}:<version>` (and `:latest` for stable).
     The **agent is multi-arch** (`linux/amd64,linux/arm64`); hub/web/updater are `amd64`. Each image carries
     **two** provenance layers (see [Supply-chain verification](#supply-chain-verification) below):
     - an **unsigned BuildKit SLSA provenance + SPDX SBOM**, attached as OCI attestation manifests in the
       index — inspect with
       `docker buildx imagetools inspect ghcr.io/simeraycom/tugra-hub:<version> --format '{{json .Provenance}}'`
       (or `'{{json .SBOM}}'`);
     - a **Sigstore-signed, Rekor-logged SLSA provenance attestation** (keyless, via
       `actions/attest-build-provenance`), pushed as an OCI referrer — publicly verifiable with
       `gh attestation verify` (no key to distribute).
   - stamps every image with an `org.opencontainers.image.version=<version>` label and records each image's
     **OCI index digest** (the `docker/build-push-action` `digest` output, the same value the provenance
     attestation signs) as a per-image `image-digest-<name>` artifact;
   - signs a merged `versions.json` (updating only the released channel, preserving the other) and pushes
     it + its `.sig` to `gh-pages`. The entry carries `imageDigests` (`hub`, `web`, `updater`, `agent`; bare
     64-hex **index** digests — not the agent's per-arch `agentSha256`) and the workflow passes
     `--require-digests true`, so a release without the hub + web digests is refused. The signer validates the
     digests as 64-hex, self-verifies against the real consumer verifier and refuses to publish anything that
     wouldn't validate.

## First-release checklist

- [ ] `UPDATE_SIGNING_KEY` secret is set.
- [ ] After the first successful run, make the **four GHCR packages public** (they default to private, so
      anonymous `docker pull` in `install.sh` fails otherwise): each package → *Package settings* →
      *Change visibility* → Public.
- [ ] GitHub Pages is enabled on `gh-pages`.
- [ ] Smoke test the published artifacts:

  ```sh
  docker run --rm ghcr.io/simeraycom/tugra-agent:<version> --version   # prints the real version, not 0.0.0-dev
  curl -s https://simeraycom.github.io/tugra/versions.json | jq .tugra.stable.version
  ```

## Supply-chain verification

### Signed build provenance (Sigstore)

Every released image carries a **Sigstore-signed, transparency-logged** SLSA provenance attestation in
addition to the unsigned BuildKit one. Signing is **keyless** — the release job mints a short-lived GitHub
OIDC token (`id-token: write`) that Fulcio exchanges for a signing certificate, and the attestation is
recorded in the public Rekor log, so there is **no signing key to manage or distribute**. Verify any image
against this repository:

```sh
gh attestation verify oci://ghcr.io/simeraycom/tugra-hub:<version> --repo SimerayCom/tugra
# …same for tugra-web / tugra-agent / tugra-updater
```

A pass proves the image was built by this repo's release workflow from the attested commit. The permissions
for this (`id-token: write` + `attestations: write`) live **only on the `build-push` job** — `ci`/`guard`
run read-only, so unvetted test code on a tagged commit can never mint a signing token.

### Pinned third-party images

`deploy/docker-compose.yml` pins the two third-party images by **multi-arch manifest-list (OCI index)
digest** so a moved or compromised upstream tag can't swap them, while the readable `:16-alpine`/`:7-alpine`
tag is kept for docs and install messages:

- `postgres:16-alpine@sha256:…`
- `redis:7-alpine@sha256:…`

**Refreshing a pin** (e.g. to pick up a patched Alpine/Postgres build within the same major). Resolve the
current index digest and update the `@sha256:` in compose — this is also exactly how the initial pins were
set, and is a deterministic refresh path independent of Dependabot:

```sh
# Needs Docker (buildx). Prints the index (manifest-list) digest, NOT a per-arch one:
docker buildx imagetools inspect postgres:16-alpine --format '{{json .Manifest.digest}}'
docker buildx imagetools inspect redis:7-alpine     --format '{{json .Manifest.digest}}'

# No Docker? Resolve straight from the registry (the Docker-Content-Digest header is the index digest):
TOKEN=$(curl -fsS "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/postgres:pull" | jq -r .token)
curl -fsSI -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.oci.image.index.v1+json" \
  -H "Accept: application/vnd.docker.distribution.manifest.list.v2+json" \
  https://registry-1.docker.io/v2/library/postgres/manifests/16-alpine | grep -i docker-content-digest
```

> Always pin the **index** digest (multi-arch), never a per-arch manifest digest — an arm64 control plane
> (`install.sh --build` on a Pi) must be able to resolve its own architecture.

**Auto-refresh:** `.github/dependabot.yml` runs the `docker-compose` updater weekly against `/deploy`; it
rewrites the `@sha256:` digest when the pinned tag is re-pushed and opens a PR. A **major** bump
(`16 → 17`, `7 → 8`) is a deliberate, manual on-disk data-migration event and is **ignored** by Dependabot
(`version-update:semver-major`), so an auto-refresh can never break an existing install's data volume. The
first-party `ghcr.io/…:${TUGRA_VERSION}` images are intentionally **not** pinned with a literal digest here
(Dependabot skips them — it can't parse the `${…}` interpolation). Instead `hub-api` and `web` accept an
**optional** digest suffix: `TUGRA_HUB_DIGEST` / `TUGRA_WEB_DIGEST` (bare 64-hex) turn the ref into
`ghcr.io/…:<version>@sha256:<hex>` (the registry enforces the content hash; the tag is informational). Unset or
empty is exactly the old tag-only ref. The self-update sidecar sets them from the signed manifest's
`imageDigests` (see [Upgrade](upgrade.md)); the `agent` and `updater` services are unchanged.

> **Status:** digests are recorded in the signed manifest and used to pin updates by content hash. Verifying
> *who built* a digest (cosign / attestation checks inside the updater) is a later step — until then the
> provenance attestation above stays a manual `gh attestation verify`.

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

## Publishing an operator notice (no release)

A top-level `notice` in the signed manifest shows a banner to every instance owner (on their next signed
check), decoupled from releases — e.g. "beta.2 fixes a critical bug, please update" or a maintenance note.
Publish or clear it from the **Publish notice** workflow
([`.github/workflows/notice.yml`](../.github/workflows/notice.yml)), which re-signs the existing
`versions.json` on gh-pages without building images:

```sh
# set a notice
gh workflow run notice.yml -f id=2026-11-02-beta2 \
  -f message="beta.2 fixes a deploy bug — please update" -f severity=warning \
  -f url=https://github.com/SimerayCom/tugra/releases/tag/v0.1.0-beta.2
# clear it
gh workflow run notice.yml -f clear=true
```

Notes: it runs only from `main`; a **new `id`** re-shows a banner a viewer had dismissed; `critical` is not
dismissible; the message is plain text (<=500 chars) and any link must be `https://`. A release carries an
active notice forward unchanged (it is never silently erased by the next version). Protect the `release`
Environment (required reviewers / branch) so only trusted dispatches can sign.
