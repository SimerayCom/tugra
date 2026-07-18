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
    expect(doc.permissions?.packages).toBe("write");
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
      hub: "ghcr.io/mrcandev/tugra-hub",
      web: "ghcr.io/mrcandev/tugra-web",
      updater: "ghcr.io/mrcandev/tugra-updater",
      agent: "ghcr.io/mrcandev/tugra-agent",
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
