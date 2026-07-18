import { execFileSync } from "node:child_process";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "release-version.sh");

function derive(ref: string): Record<string, string> {
  const out = execFileSync("bash", [SCRIPT, ref], { stdio: "pipe" }).toString();
  const kv: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const m = /^([a-z]+)=(.*)$/.exec(line);
    if (m) kv[m[1]] = m[2];
  }
  return kv;
}

describe("scripts/release-version.sh", () => {
  it("is valid bash syntax (bash -n)", () => {
    expect(() => execFileSync("bash", ["-n", SCRIPT], { stdio: "pipe" })).not.toThrow();
  });

  it("a stable tag → version stripped, channel=stable, latest=true", () => {
    expect(derive("v1.2.3")).toEqual({ version: "1.2.3", channel: "stable", latest: "true" });
  });

  it("a pre-release tag → channel=beta, latest=false (never moves latest)", () => {
    expect(derive("v0.2.0-beta.1")).toEqual({ version: "0.2.0-beta.1", channel: "beta", latest: "false" });
    expect(derive("v3.0.0-rc.2").channel).toBe("beta");
  });

  it("accepts a full refs/tags/ ref and a bare version (dispatch input)", () => {
    expect(derive("refs/tags/v2.0.0").version).toBe("2.0.0");
    expect(derive("1.4.5")).toEqual({ version: "1.4.5", channel: "stable", latest: "true" });
  });

  it("rejects a non-semver ref (fail-closed, non-zero exit)", () => {
    for (const bad of ["not-a-version", "v1.2", "1.2.3.4", ""]) {
      expect(() => execFileSync("bash", [SCRIPT, bad], { stdio: "pipe" })).toThrow();
    }
  });

  it("rejects +build metadata (not a legal image tag — must fail up front, not at docker buildx)", () => {
    expect(() => execFileSync("bash", [SCRIPT, "v1.2.3+build.5"], { stdio: "pipe" })).toThrow();
  });
});
