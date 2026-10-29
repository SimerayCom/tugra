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
    // Least-privilege: packages:write lives on build-push, not the top level (ci + guard stay read-only).
    expect(doc.permissions?.packages).toBeUndefined();
    expect(doc.jobs["build-push"].permissions?.packages).toBe("write");
  });

  it("derives the version via the tested script (not inline YAML logic)", () => {
    const steps = doc.jobs["build-push"].steps as Array<{ run?: string }>;
    expect(steps.some((s) => s.run?.includes("scripts/release-version.sh"))).toBe(true);
  });

  it("builds all four images from committed deploy/ Dockerfiles with the right ghcr names", () => {
    const include = doc.jobs["build-push"].strategy.matrix.include as Array<{
      name: string;
      image: string;
      dockerfile: string;
      platforms: string;
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

  it("builds the agent multi-arch (amd64 + arm64) and the others amd64", () => {
    const include = doc.jobs["build-push"].strategy.matrix.include as Array<{ name: string; platforms: string }>;
    const agent = include.find((e) => e.name === "agent")!;
    expect(agent.platforms).toContain("linux/amd64");
    expect(agent.platforms).toContain("linux/arm64");
    for (const other of include.filter((e) => e.name !== "agent")) {
      expect(other.platforms).toBe("linux/amd64");
    }
  });

  it("captures the agent's per-arch digests as an artifact for the manifest signer", () => {
    const steps = doc.jobs["build-push"].steps as Array<{ run?: string; uses?: string; with?: { name?: string } }>;
    expect(steps.some((s) => s.run?.includes("imagetools inspect") && s.run?.includes("agent-digests.json"))).toBe(true);
    expect(steps.some((s) => s.uses?.startsWith("actions/upload-artifact") && s.with?.name === "agent-digests")).toBe(true);
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

  it("build-push waits for BOTH the CI gate and the main-ancestor guard", () => {
    const needs = relDoc.jobs["build-push"].needs;
    const arr = Array.isArray(needs) ? needs : [needs];
    expect(arr).toContain("ci");
    expect(arr).toContain("guard");
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
    for (const job of ["build-push", "publish-manifest", "github-release", "guard"]) {
      const checkout = (relDoc.jobs[job].steps as Array<{ uses?: string; with?: { ref?: string } }>).find((s) =>
        s.uses?.startsWith("actions/checkout"),
      );
      expect(checkout?.with?.ref).toBe("${{ github.sha }}");
    }
  });

  it("passes the release ref through env (no expression injection in a run block)", () => {
    const ver = (relDoc.jobs["build-push"].steps as Array<{ id?: string; run?: string; env?: Record<string, string> }>).find(
      (s) => s.id === "ver",
    )!;
    expect(ver.env?.REF).toContain("github.ref_name");
    expect(ver.run).toContain("$REF");
    expect(ver.run).not.toContain("github.ref_name");
  });
});
