import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const pkgVersion = (rel: string): string => JSON.parse(readFileSync(join(REPO_ROOT, rel), "utf8")).version;

describe("core / CLI version sync", () => {
  it("the CLI package carries the same version as the core (root package.json)", () => {
    expect(pkgVersion("packages/cli/package.json")).toBe(pkgVersion("package.json"));
  });

  it("scripts/check-versions.mjs passes on the committed tree", () => {
    const r = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "check-versions.mjs")], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("ok");
  });

  it("the release workflow guard job runs the check before anything is published", () => {
    const doc = parseYaml(readFileSync(join(REPO_ROOT, ".github", "workflows", "release.yml"), "utf8")) as {
      jobs: Record<string, { steps?: Array<{ run?: string }> }>;
    };
    expect(doc.jobs.guard.steps?.some((s) => s.run?.includes("scripts/check-versions.mjs"))).toBe(true);
  });
});
