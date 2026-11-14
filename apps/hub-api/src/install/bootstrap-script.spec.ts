import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BOOTSTRAP = join(__dirname, "..", "..", "..", "..", "scripts", "bootstrap.sh");
const source = readFileSync(BOOTSTRAP, "utf8");

describe("scripts/bootstrap.sh", () => {
  it("is valid POSIX sh syntax (sh -n)", () => {
    expect(() => execFileSync("sh", ["-n", BOOTSTRAP], { stdio: "pipe" })).not.toThrow();
  });

  it("has no silent `|| git clone` fallback (a bad ref must fail loudly, never install the default branch)", () => {
    expect(source).not.toMatch(/\|\|\s*git clone/);
    expect(source).toContain("fetch --depth 1 origin");
  });

  describe("against a local git fixture", () => {
    const root = mkdtempSync(join(tmpdir(), "bootstrap-"));
    const upstream = join(root, "upstream");
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    const git = (cwd: string, ...args: string[]): string =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
        cwd,
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1" } as NodeJS.ProcessEnv,
      }).trim();
    const commit = (marker: string): string => {
      mkdirSync(join(upstream, "scripts"), { recursive: true });
      const f = join(upstream, "scripts", "install.sh");
      writeFileSync(f, `#!/bin/sh\necho "INSTALLED:${marker} args:$*"\n`);
      chmodSync(f, 0o755);
      git(upstream, "add", "-A");
      git(upstream, "commit", "-q", "-m", marker);
      return git(upstream, "rev-parse", "HEAD");
    };

    let firstSha = "";
    let mainInstallSha256 = "";
    beforeAll(() => {
      mkdirSync(upstream, { recursive: true });
      git(upstream, "init", "-q");
      git(upstream, "symbolic-ref", "HEAD", "refs/heads/main");
      git(upstream, "config", "uploadpack.allowAnySHA1InWant", "true");
      firstSha = commit("first");
      git(upstream, "tag", "v1.0");
      git(upstream, "checkout", "-q", "-b", "feature");
      commit("feature");
      git(upstream, "checkout", "-q", "main");
      commit("main");
      mainInstallSha256 = createHash("sha256").update(readFileSync(join(upstream, "scripts", "install.sh"))).digest("hex");
    });

    let n = 0;
    const boot = (env: Record<string, string>, args: string[] = [], opts: { cwd?: string; premake?: boolean } = {}) => {
      let cwd = opts.cwd;
      if (!cwd) {
        n += 1;
        cwd = join(root, `run${n}`);
        mkdirSync(cwd);
      }
      if (opts.premake) mkdirSync(join(cwd, "tugra"), { recursive: true });
      const r = spawnSync("sh", [BOOTSTRAP, ...args], {
        cwd,
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: root, TUGRA_REPO_URL: `file://${upstream}`, TUGRA_DIR: "tugra", ...env } as NodeJS.ProcessEnv,
      });
      return { cwd, code: r.status, out: `${r.stdout}${r.stderr}` };
    };

    it("defaults to main and passes installer flags through", () => {
      const r = boot({}, ["--domain", "x.example.com"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("INSTALLED:main args:--domain x.example.com");
    });

    it("checks out a BRANCH ref", () => {
      const r = boot({ TUGRA_REF: "feature" });
      expect(r.code).toBe(0);
      expect(r.out).toContain("INSTALLED:feature");
    });

    it("a branch bootstrap leaves a checkout that TRACKS origin (so `git pull && ./scripts/install.sh` works)", () => {
      const r = boot({}); // default ref = main
      expect(r.code).toBe(0);
      const dir = join(r.cwd, "tugra");
      expect(git(dir, "rev-parse", "--abbrev-ref", "main@{upstream}")).toBe("origin/main");
      expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main"); // not detached
      expect(() => git(dir, "pull", "-q", "--ff-only")).not.toThrow();
      // re-running bootstrap over the existing checkout keeps it tracking
      expect(boot({}, [], { cwd: r.cwd }).code).toBe(0);
      expect(git(dir, "rev-parse", "--abbrev-ref", "main@{upstream}")).toBe("origin/main");
    });

    it("a TAG / SHA bootstrap is detached by design (upgrade by re-running bootstrap with a new TUGRA_REF)", () => {
      const r = boot({ TUGRA_REF: "v1.0" });
      expect(git(join(r.cwd, "tugra"), "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
    });

    it("an existing-but-empty ./tugra: a bad ref fails AND leaves no .git behind; a re-run then succeeds", () => {
      const bad = boot({ TUGRA_REF: "no-such-ref" }, [], { premake: true });
      expect(bad.code).not.toBe(0);
      expect(existsSync(join(bad.cwd, "tugra"))).toBe(true); // the dir pre-existed, so it is kept…
      expect(existsSync(join(bad.cwd, "tugra", ".git"))).toBe(false); // …but our half-made .git is gone
      const ok = boot({}, [], { cwd: bad.cwd });
      expect(ok.code).toBe(0);
      expect(ok.out).toContain("INSTALLED:main");
    });

    it("a leftover UNBORN .git (older failed run) does not wedge the next run", () => {
      n += 1;
      const cwd = join(root, `run${n}`);
      mkdirSync(join(cwd, "tugra"), { recursive: true });
      git(join(cwd, "tugra"), "init", "-q");
      git(join(cwd, "tugra"), "remote", "add", "origin", `file://${upstream}`);
      const r = boot({}, [], { cwd });
      expect(r.code).toBe(0);
      expect(r.out).toContain("INSTALLED:main");
    });

    it("checks out a TAG ref", () => {
      const r = boot({ TUGRA_REF: "v1.0" });
      expect(r.code).toBe(0);
      expect(r.out).toContain("INSTALLED:first");
    });

    it("checks out a full commit SHA (which `git clone --branch` cannot do)", () => {
      const r = boot({ TUGRA_REF: firstSha });
      expect(r.code).toBe(0);
      expect(r.out).toContain("INSTALLED:first");
      expect(r.out).not.toContain("INSTALLED:main");
    });

    it("a BAD ref exits non-zero, never runs the installer, and leaves no half-made checkout behind", () => {
      const r = boot({ TUGRA_REF: "no-such-ref" });
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("could not fetch TUGRA_REF=no-such-ref");
      expect(r.out).not.toContain("INSTALLED:");
      expect(existsSync(join(r.cwd, "tugra"))).toBe(false);
    });

    it("TUGRA_SHA256 matching install.sh lets the installer run", () => {
      const r = boot({ TUGRA_SHA256: mainInstallSha256 });
      expect(r.code).toBe(0);
      expect(r.out).toContain("INSTALLED:main");
    });

    it("a TUGRA_SHA256 MISMATCH aborts before the installer runs", () => {
      const r = boot({ TUGRA_SHA256: "0".repeat(64) });
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("checksum mismatch");
      expect(r.out).not.toContain("INSTALLED:");
    });
  });
});
