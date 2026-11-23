import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
        cwd,
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1" } as NodeJS.ProcessEnv,
      }).trim();
    const commit = (marker: string): string => {
      mkdirSync(join(upstream, "scripts"), { recursive: true });
      const f = join(upstream, "scripts", "install.sh");
      writeFileSync(f, `#!/bin/sh\necho "INSTALLED:${marker} args:$* ver:${"$"}{TUGRA_VERSION:-none}"\n`);
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
      git(upstream, "tag", "v0.1.0-beta.9");
      git(upstream, "checkout", "-q", "-b", "feature");
      commit("feature");
      git(upstream, "checkout", "-q", "main");
      commit("main");
      git(upstream, "tag", "v0.1.0-beta.10"); // numerically newer than beta.9 (a plain string sort would pick beta.9)
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

    it("defaults to the newest RELEASE tag (numeric pre-release order), pins its version and passes installer flags through", () => {
      const r = boot({}, ["--domain", "x.example.com"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("Latest release: v0.1.0-beta.10");
      expect(r.out).toContain("INSTALLED:main args:--domain x.example.com ver:0.1.0-beta.10");
    });

    describe("--doctor is read-only", () => {
      it("on a host with no checkout it runs the installer's doctor from a throwaway copy: nothing is left behind, no ./tugra", () => {
        const r = boot({ TUGRA_DOCTOR_DOCKER_LOOKUP: "0" }, ["--doctor"]);
        expect(r.code).toBe(0);
        expect(r.out).toContain("args:--doctor");
        expect(r.out).toContain("throwaway copy of v0.1.0-beta.10");
        expect(existsSync(join(r.cwd, "tugra"))).toBe(false);
      });

      it("on a host that already has a checkout it runs THAT checkout as it is: no fetch, no checkout of the newest release, no TUGRA_VERSION", () => {
        const cwd = join(root, "doctor-existing");
        mkdirSync(cwd);
        git(cwd, "clone", "-q", `file://${upstream}`, "tugra");
        git(join(cwd, "tugra"), "checkout", "-q", "--detach", firstSha);
        const head = git(join(cwd, "tugra"), "rev-parse", "HEAD");
        const r = boot({ TUGRA_DOCTOR_DOCKER_LOOKUP: "0" }, ["--doctor"], { cwd });
        expect(r.code).toBe(0);
        expect(r.out).toContain("INSTALLED:first args:--doctor ver:none");
        expect(r.out).toContain("nothing is fetched or changed");
        expect(git(join(cwd, "tugra"), "rev-parse", "HEAD")).toBe(head); // not moved to the newest release
      });

      it("does not die on local edits in the checkout (the install path does): the doctor only reads", () => {
        const cwd = join(root, "doctor-dirty");
        mkdirSync(cwd);
        git(cwd, "clone", "-q", `file://${upstream}`, "tugra");
        writeFileSync(join(cwd, "tugra", "scripts", "install.sh"), '#!/bin/sh\necho "EDITED args:$*"\n');
        const r = boot({ TUGRA_DOCTOR_DOCKER_LOOKUP: "0" }, ["--doctor"], { cwd });
        expect(r.code).toBe(0);
        expect(r.out).toContain("EDITED args:--doctor");
      });

      it("never installs git: without git and without a checkout it stops with a clear message", () => {
        const bin = join(root, "nogit-bin");
        mkdirSync(bin);
        for (const t of ["sh", "head", "awk", "sort", "tail", "cut", "mktemp", "rm", "cat"]) {
          const real = execFileSync("sh", ["-c", `command -v ${t}`]).toString().trim();
          if (real.startsWith("/")) symlinkSync(real, join(bin, t));
        }
        const cwd = join(root, "doctor-nogit");
        mkdirSync(cwd);
        const r = spawnSync(join(bin, "sh"), [BOOTSTRAP, "--doctor"], { cwd, encoding: "utf8", env: { PATH: bin, HOME: root, TUGRA_DIR: "tugra", TUGRA_DOCTOR_DOCKER_LOOKUP: "0" } as NodeJS.ProcessEnv });
        expect(r.status).toBe(1);
        expect(`${r.stdout}${r.stderr}`).toContain("git is not installed (the doctor changes nothing, so it will not install it)");
      });
    });

    it("a STABLE release wins over newer-looking pre-releases", () => {
      git(upstream, "tag", "v0.1.0", firstSha);
      try {
        const r = boot({});
        expect(r.code).toBe(0);
        expect(r.out).toContain("Latest release: v0.1.0");
        expect(r.out).toContain("INSTALLED:first");
        expect(r.out).toContain("ver:0.1.0");
      } finally {
        git(upstream, "tag", "-d", "v0.1.0");
      }
    });

    it("an explicit TUGRA_VERSION is kept; a branch ref (TUGRA_REF=main) pins nothing", () => {
      expect(boot({ TUGRA_VERSION: "9.9.9" }).out).toContain("ver:9.9.9");
      expect(boot({ TUGRA_REF: "main" }).out).toContain("INSTALLED:main args: ver:none");
    });

    it("no release tag on the remote fails loudly instead of installing a branch", () => {
      n += 1;
      const empty = join(root, `empty${n}`);
      mkdirSync(empty);
      git(empty, "init", "-q");
      git(empty, "commit", "-q", "--allow-empty", "-m", "x");
      const r = spawnSync("sh", [BOOTSTRAP], {
        cwd: root,
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: root, TUGRA_REPO_URL: `file://${empty}`, TUGRA_DIR: `noRel${n}` } as NodeJS.ProcessEnv,
      });
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toContain("could not find a published Tugra release");
    });

    it("checks out a BRANCH ref", () => {
      const r = boot({ TUGRA_REF: "feature" });
      expect(r.code).toBe(0);
      expect(r.out).toContain("INSTALLED:feature");
    });

    it("a branch bootstrap leaves a checkout that TRACKS origin (so `git pull && ./scripts/install.sh` works)", () => {
      const r = boot({ TUGRA_REF: "main" });
      expect(r.code).toBe(0);
      const dir = join(r.cwd, "tugra");
      expect(git(dir, "rev-parse", "--abbrev-ref", "main@{upstream}")).toBe("origin/main");
      expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main"); // not detached
      expect(() => git(dir, "pull", "-q", "--ff-only")).not.toThrow();
      // re-running bootstrap over the existing checkout keeps it tracking
      expect(boot({ TUGRA_REF: "main" }, [], { cwd: r.cwd }).code).toBe(0);
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

    describe("files the in-app updater replaced (.tugra-host-applied)", () => {
      const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
      const checkout = () => {
        const r = boot({ TUGRA_REF: "main" });
        expect(r.code).toBe(0);
        return join(r.cwd, "tugra");
      };

      it("a release-replaced script that still matches its record is reset, so a re-run moves on (no `uncommitted changes` dead end)", () => {
        const dir = checkout();
        const f = join(dir, "scripts", "install.sh");
        writeFileSync(f, '#!/bin/sh\necho "FROM-IN-APP-UPDATE"\n');
        writeFileSync(join(dir, ".tugra-host-applied"), `${sha(f)}  scripts/install.sh\n`);
        const r = boot({ TUGRA_REF: "main" }, [], { cwd: join(dir, "..") });
        expect(r.code).toBe(0);
        expect(r.out).toContain("INSTALLED:main");
        expect(r.out).not.toContain("FROM-IN-APP-UPDATE");
        expect(git(dir, "status", "--porcelain", "--untracked-files=no")).toBe("");
      });

      it("a script edited AFTER the in-app update (no longer matches the record) is still protected", () => {
        const dir = checkout();
        const f = join(dir, "scripts", "install.sh");
        writeFileSync(f, "#!/bin/sh\necho applied\n");
        writeFileSync(join(dir, ".tugra-host-applied"), `${sha(f)}  scripts/install.sh\n`);
        writeFileSync(f, "#!/bin/sh\necho my-own-edit\n");
        const r = boot({ TUGRA_REF: "main" }, [], { cwd: join(dir, "..") });
        expect(r.code).not.toBe(0);
        expect(r.out).toContain("uncommitted local changes");
        expect(readFileSync(f, "utf8")).toContain("my-own-edit");
      });

      it("only compose/scripts paths are ever reset: a record naming anything else is ignored", () => {
        const dir = checkout();
        writeFileSync(join(dir, "README.md"), "mine\n");
        git(dir, "add", "README.md");
        writeFileSync(join(dir, "README.md"), "mine, edited\n");
        writeFileSync(join(dir, ".tugra-host-applied"), `${sha(join(dir, "README.md"))}  README.md\n${"0".repeat(64)}  scripts/../README.md\n`);
        const r = boot({ TUGRA_REF: "main" }, [], { cwd: join(dir, "..") });
        expect(r.code).not.toBe(0);
        expect(readFileSync(join(dir, "README.md"), "utf8")).toContain("mine, edited");
      });
    });

    it("checks out a TAG ref (a non-release tag pins no version)", () => {
      const r = boot({ TUGRA_REF: "v1.0" });
      expect(r.code).toBe(0);
      expect(r.out).toContain("INSTALLED:first");
      expect(r.out).toContain("ver:none");
      expect(boot({ TUGRA_REF: "v0.1.0-beta.9" }).out).toContain("INSTALLED:first args: ver:0.1.0-beta.9");
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
