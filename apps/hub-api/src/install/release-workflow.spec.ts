import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const WORKFLOW = join(REPO_ROOT, ".github", "workflows", "release.yml");

describe(".github/workflows/release.yml", () => {
  const raw = readFileSync(WORKFLOW, "utf8");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc = parseYaml(raw) as any;

  it("is valid YAML", () => {
    expect(doc).toBeTruthy();
    expect(doc.jobs).toBeTruthy();
  });

  it("triggers on a version tag + manual dispatch, and can write packages", () => {
    // `on` is parsed as the literal string key under YAML 1.2 core; assert on the raw text to be robust.
    expect(raw).toMatch(/tags:\s*\["v\*\.\*\.\*"\]/);
    expect(raw).toContain("workflow_dispatch");
    // Least-privilege: packages:write lives on build + merge, not the top level (ci + guard stay read-only).
    expect(doc.permissions?.packages).toBeUndefined();
    expect(doc.jobs["build"].permissions?.packages).toBe("write");
    expect(doc.jobs["merge"].permissions?.packages).toBe("write");
  });

  it("offers a dry_run dispatch input that never publishes", () => {
    expect(doc.on.workflow_dispatch.inputs.dry_run.type).toBe("boolean");
    expect(doc.on.workflow_dispatch.inputs.dry_run.default).toBe(false);
    // publish-manifest (and so github-release) is skipped on a dry run; the scratch tag is ci-<run_id>, never latest.
    for (const job of ["publish-manifest", "github-release"]) {
      expect(doc.jobs[job].if).toContain("github.event.inputs.dry_run != 'true'");
    }
    const tagStep = (doc.jobs["meta"].steps as Array<{ id?: string; run?: string }>).find((s) => s.id === "tag")!;
    expect(tagStep.run).toContain('tag="ci-$RUN_ID"; latest=false');
  });

  it("derives the version via the tested script (not inline YAML logic)", () => {
    const steps = doc.jobs["meta"].steps as Array<{ run?: string }>;
    expect(steps.some((s) => s.run?.includes("scripts/release-version.sh"))).toBe(true);
  });

  it("builds all four images from committed deploy/ Dockerfiles with the right ghcr names", () => {
    const include = doc.jobs["build"].strategy.matrix.include as Array<{
      name: string;
      image: string;
      dockerfile: string;
      arch: string;
    }>;
    const byName = Object.fromEntries(include.map((e) => [e.name, e]));
    const expected: Record<string, string> = {
      hub: "ghcr.io/simeraycom/tugra-hub",
      web: "ghcr.io/simeraycom/tugra-web",
      updater: "ghcr.io/simeraycom/tugra-updater",
      agent: "ghcr.io/simeraycom/tugra-agent",
    };
    for (const [name, image] of Object.entries(expected)) {
      const entry = byName[name];
      expect(entry).toBeTruthy();
      expect(entry.image).toBe(image);
      expect(entry.dockerfile.startsWith("deploy/")).toBe(true);
      expect(existsSync(join(REPO_ROOT, entry.dockerfile))).toBe(true);
    }
  });

  it("builds every image natively on amd64 AND arm64 (no QEMU), then merges them into one index", () => {
    const include = doc.jobs["build"].strategy.matrix.include as Array<{
      name: string;
      arch: string;
      platform: string;
      runner: string;
    }>;
    expect([...new Set(include.map((e) => e.name))].sort()).toEqual(["agent", "hub", "updater", "web"]);
    for (const name of ["agent", "hub", "updater", "web"]) {
      const legs = include.filter((e) => e.name === name);
      expect(legs.map((e) => e.platform).sort()).toEqual(["linux/amd64", "linux/arm64"]);
      expect(legs.find((e) => e.arch === "amd64")!.runner).toBe("ubuntu-24.04");
      expect(legs.find((e) => e.arch === "arm64")!.runner).toBe("ubuntu-24.04-arm");
    }
    expect(raw).not.toContain("setup-qemu-action");
    const steps = doc.jobs["build"].steps as Array<{ uses?: string; with?: Record<string, unknown> }>;
    const build = steps.find((s) => s.uses?.startsWith("docker/build-push-action"))!;
    // Pushed by digest only; the tagged manifest list is created by merge.
    expect(String(build.with?.outputs)).toContain("push-by-digest=true");
    expect(String(build.with?.outputs)).toContain("name-canonical=true");
    expect(build.with?.tags).toBeUndefined();
    expect(String(build.with?.["cache-from"])).toContain("type=gha");
    expect(String(build.with?.["cache-to"])).toContain("mode=max");
    const mergeSteps = doc.jobs["merge"].steps as Array<{ run?: string }>;
    const create = mergeSteps.map((s) => s.run ?? "").join("\n");
    expect(create).toContain("imagetools create");
    // the index must keep both arches and one attestation manifest per arch
    expect(create).toContain('["linux/amd64", "linux/arm64"]');
  });

  it("captures the agent's per-arch digests as an artifact for the manifest signer", () => {
    const steps = doc.jobs["merge"].steps as Array<{ run?: string; uses?: string; with?: { name?: string } }>;
    expect(steps.some((s) => s.run?.includes("index.json") && s.run?.includes("agent-digests.json"))).toBe(true);
    expect(steps.some((s) => s.uses?.startsWith("actions/upload-artifact") && s.with?.name === "agent-digests")).toBe(true);
  });

  it("attaches SLSA provenance and an SBOM to every pushed image", () => {
    const steps = doc.jobs["build"].steps as Array<{ uses?: string; with?: Record<string, unknown> }>;
    const build = steps.find((s) => s.uses?.startsWith("docker/build-push-action"))!;
    expect(build).toBeTruthy();
    expect(String(build.with?.provenance)).toMatch(/^(true|mode=(min|max))$/); // never "false"
    expect(build.with?.provenance).not.toBe(false);
    expect(build.with?.sbom).toBe(true);
  });

  it("the agent digest capture still selects by platform and skips the attestation manifests", () => {
    const steps = doc.jobs["merge"].steps as Array<{ run?: string }>;
    const capture = steps.find((s) => s.run?.includes("agent-digests.json"))!.run!;
    expect(capture).toContain('.platform.os=="linux"');
    expect(capture).toContain('.platform.architecture=="amd64"');
    expect(capture).toContain('.platform.architecture=="arm64"');
    // attestation entries (provenance/sbom) must be excluded so they can never be picked as the arch digest.
    expect(capture).toContain("attestation-manifest");
  });

  it("grants merge id-token + attestations write for Sigstore signing, and only merge", () => {
    // The Sigstore signed provenance (actions/attest-build-provenance) needs id-token:write (keyless OIDC)
    // and attestations:write — granted ONLY on merge, keeping packages:write + contents:read. These do
    // NOT move to the top level and are NOT given to ci/guard/build, so unvetted test code never holds them.
    expect(doc.jobs["merge"].permissions?.["id-token"]).toBe("write");
    expect(doc.jobs["merge"].permissions?.attestations).toBe("write");
    expect(doc.jobs["merge"].permissions?.packages).toBe("write");
    expect(doc.jobs["merge"].permissions?.contents).toBe("read");
    expect(doc.jobs["build"].permissions?.["id-token"]).toBeUndefined();
    expect(doc.jobs["build"].permissions?.attestations).toBeUndefined();
    // No top-level escalation.
    expect(doc.permissions?.["id-token"]).toBeUndefined();
    expect(doc.permissions?.attestations).toBeUndefined();
    expect(doc.permissions?.packages).toBeUndefined();
    // ci + guard never hold the signing/publish tokens.
    for (const job of ["ci", "guard"]) {
      expect(doc.jobs[job].permissions?.["id-token"]).toBeUndefined();
      expect(doc.jobs[job].permissions?.attestations).toBeUndefined();
      expect(doc.jobs[job].permissions?.packages).toBeUndefined();
    }
    expect(doc.jobs["publish-manifest"].permissions?.contents).toBe("write"); // unchanged
  });

  it("adds a Sigstore signed build-provenance attestation step wired to the pushed digest", () => {
    const steps = doc.jobs["merge"].steps as Array<{ id?: string; uses?: string; with?: Record<string, unknown> }>;
    // The merge step exposes the final INDEX digest via `id: index`.
    expect(steps.some((s) => s.id === "index")).toBe(true);
    // A keyless-signed, Rekor-logged provenance attestation, pushed to the registry as an OCI referrer.
    const attest = steps.find((s) => s.uses?.startsWith("actions/attest-build-provenance"))!;
    expect(attest).toBeTruthy();
    expect(attest.uses).toMatch(/@v\d+\.\d+\.\d+$/); // pinned to an exact version, not a floating major
    expect(attest.with?.["push-to-registry"]).toBe(true);
    expect(String(attest.with?.["subject-digest"])).toContain("steps.index.outputs.digest");
    expect(String(attest.with?.["subject-name"])).toContain("matrix.image");
  });

  it("stamps the OCI image.version label on every image build", () => {
    const steps = doc.jobs["build"].steps as Array<{ uses?: string; with?: Record<string, unknown> }>;
    const build = steps.find((s) => s.uses?.startsWith("docker/build-push-action"))!;
    expect(String(build.with?.labels)).toContain("org.opencontainers.image.version=${{ needs.meta.outputs.version }}");
  });

  it("every merge leg records its INDEX digest from the merge step and uploads it as image-digest-<name>", () => {
    const steps = doc.jobs["merge"].steps as Array<{
      name?: string;
      run?: string;
      uses?: string;
      if?: string;
      env?: Record<string, string>;
      with?: { name?: string; path?: string };
    }>;
    const record = steps.find((s) => s.name === "Record image index digest")!;
    expect(record).toBeTruthy();
    expect(record.if).toBeUndefined(); // ALL four legs (hub/web/updater/agent), not just the agent
    // The digest reaches the script through env (no expression injection) and is the merge step's index digest.
    expect(record.env?.DIGEST).toBe("${{ steps.index.outputs.digest }}");
    expect(record.run).not.toContain("steps.index.outputs.digest");
    expect(record.run).toContain("sha256:[0-9a-f]{64}"); // malformed/empty digest fails the leg
    expect(record.run).toContain("$NAME.digest");
    const upload = steps.find((s) => s.uses?.startsWith("actions/upload-artifact") && s.with?.name === "image-digest-${{ matrix.name }}")!;
    expect(upload).toBeTruthy();
    expect(upload.if).toBeUndefined();
    expect(upload.with?.path).toBe("${{ matrix.name }}.digest");
    // Ordered AFTER the (untouched) attest step, so a failed attestation never leaves a recorded digest behind.
    const order = (pred: (s: (typeof steps)[number]) => boolean) => steps.findIndex(pred);
    expect(order((s) => s.name === "Record image index digest")).toBeGreaterThan(
      order((s) => !!s.uses?.startsWith("actions/attest-build-provenance")),
    );
  });

  it("publish-manifest downloads all image digests and signs them in with --require-digests", () => {
    const steps = doc.jobs["publish-manifest"].steps as Array<{
      run?: string;
      uses?: string;
      with?: { name?: string; pattern?: string; path?: string; "merge-multiple"?: boolean };
    }>;
    const dl = steps.find((s) => s.uses?.startsWith("actions/download-artifact") && s.with?.pattern === "image-digest-*")!;
    expect(dl).toBeTruthy();
    expect(dl.with?.["merge-multiple"]).toBe(true);
    // the existing agent per-arch digest download is untouched
    expect(steps.some((s) => s.uses?.startsWith("actions/download-artifact") && s.with?.name === "agent-digests")).toBe(true);
    const sign = steps.find((s) => s.run?.includes("scripts/sign-manifest.mjs"))!.run!;
    for (const flag of ["--hub-digest", "--web-digest", "--updater-digest", "--agent-index-digest", "--require-digests true"]) {
      expect(sign).toContain(flag);
    }
    // every digest file is read through the fail-closed reader (set -e + non-empty check)
    for (const n of ["hub", "web", "updater", "agent"]) expect(sign).toContain(`read_digest ${n}`);
  });

  it("has a publish-manifest job that signs + publishes to gh-pages after the images build", () => {
    const job = doc.jobs["publish-manifest"];
    expect(job).toBeTruthy();
    expect(job.needs).toBe("build-push");
    expect(job.permissions?.contents).toBe("write"); // needs to push gh-pages
    const steps = job.steps as Array<{ run?: string; uses?: string; env?: Record<string, string> }>;
    const runs = steps.map((s) => s.run ?? "").join("\n");
    expect(runs).toContain("scripts/sign-manifest.mjs");
    expect(runs).toContain("origin gh-pages"); // reads current from + publishes to gh-pages
    expect(runs).toContain("git push origin gh-pages");
    // The signing key comes from a secret, never inlined.
    expect(steps.some((s) => s.env?.UPDATE_SIGNING_KEY?.includes("secrets.UPDATE_SIGNING_KEY"))).toBe(true);
    // The current manifest is read from the git branch (trust root = repo write), not an HTTP fetch.
    expect(runs).toContain("git show origin/gh-pages:versions.json");
  });
});

describe("release gate (CI must pass + the commit must be on main)", () => {
  const ciRaw = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const relDoc = parseYaml(readFileSync(WORKFLOW, "utf8")) as any;

  it("ci.yml exposes workflow_call so the release can re-run the exact same suite", () => {
    // A tag push does not match ci.yml's branch trigger, so the release must be able to CALL it.
    expect(ciRaw).toContain("workflow_call");
  });

  it("release.yml runs CI as a reusable workflow before building images", () => {
    const ci = relDoc.jobs["ci"];
    expect(ci).toBeTruthy();
    expect(ci.uses).toBe("./.github/workflows/ci.yml");
  });

  it("release.yml guards that the released commit is an ancestor of main", () => {
    const guard = relDoc.jobs["guard"];
    expect(guard).toBeTruthy();
    const runs = (guard.steps as Array<{ run?: string }>).map((s) => s.run ?? "").join("\n");
    expect(runs).toContain("merge-base");
    expect(runs).toContain("--is-ancestor");
  });

  it("the build chain waits for BOTH the CI gate and the main-ancestor guard", () => {
    const meta = relDoc.jobs["meta"].needs;
    const arr = Array.isArray(meta) ? meta : [meta];
    expect(arr).toContain("ci");
    expect(arr).toContain("guard");
    // meta -> build -> merge -> build-push: nothing builds or signs without passing through meta.
    expect(relDoc.jobs["build"].needs).toEqual(["meta"]);
    expect(relDoc.jobs["merge"].needs).toEqual(["meta", "build"]);
    expect(relDoc.jobs["build-push"].needs).toEqual(["meta", "merge"]);
  });

  it("ci + guard run read-only, so unvetted test code never holds a publish token", () => {
    expect(relDoc.jobs["ci"].permissions?.contents).toBe("read");
    expect(relDoc.jobs["ci"].permissions?.packages).toBeUndefined();
    expect(relDoc.jobs["guard"].permissions?.contents).toBe("read");
    // ci does not even run on an off-main commit.
    expect(relDoc.jobs["ci"].needs).toBe("guard");
  });

  it("every publishing job stays transitively behind the gate", () => {
    expect(relDoc.jobs["publish-manifest"].needs).toBe("build-push");
    const ghr = relDoc.jobs["github-release"].needs;
    const arr = Array.isArray(ghr) ? ghr : [ghr];
    expect(arr).toContain("build-push");
    expect(arr).toContain("publish-manifest");
  });

  it("builds/signs/releases the vetted SHA, not a possibly-moved tag ref", () => {
    for (const job of ["meta", "build", "publish-manifest", "github-release", "guard"]) {
      const checkout = (relDoc.jobs[job].steps as Array<{ uses?: string; with?: { ref?: string } }>).find((s) =>
        s.uses?.startsWith("actions/checkout"),
      );
      expect(checkout?.with?.ref).toBe("${{ github.sha }}");
    }
  });

  it("passes the release ref through env (no expression injection in a run block)", () => {
    const ver = (relDoc.jobs["meta"].steps as Array<{ id?: string; run?: string; env?: Record<string, string> }>).find(
      (s) => s.id === "ver",
    )!;
    expect(ver.env?.REF).toContain("github.ref_name");
    expect(ver.run).toContain("$REF");
    expect(ver.run).not.toContain("github.ref_name");
  });
});
