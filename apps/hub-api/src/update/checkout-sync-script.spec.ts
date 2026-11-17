import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Drives the REAL scripts/lib/checkout.sh against throwaway git repositories: a "release server" (bare origin with
 * tags v0.1.0 and v0.2.0) and an install checkout cloned at v0.1.0 whose compose/scripts the in-app updater then
 * overwrote with the v0.2.0 content (so git shows them as modified / untracked although they are the release's).
 */

const LIB = join(__dirname, "..", "..", "..", "..", "scripts", "lib", "checkout.sh");
const BASH = execFileSync("sh", ["-c", "command -v bash"]).toString().trim();

const V1: Record<string, string> = {
  "deploy/docker-compose.yml": "name: tugra\n# v1\n",
  "scripts/install.sh": "#!/usr/bin/env bash\n# installer v1\n",
  "scripts/update.sh": "#!/usr/bin/env bash\n# updater v1\n",
  "README.md": "readme v1\n",
  "apps/app.txt": "app v1\n",
};
const V2: Record<string, string> = {
  "deploy/docker-compose.yml": "name: tugra\n# v2\n",
  "scripts/install.sh": "#!/usr/bin/env bash\n# installer v2\n",
  "scripts/update.sh": "#!/usr/bin/env bash\n# updater v2\n",
  "scripts/lib/images.sh": "# images v2 (new file)\n",
  "README.md": "readme v1\n", // unchanged between the releases
  "apps/app.txt": "app v2\n",
};

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function write(root: string, files: Record<string, string>): void {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c, { mode: p.endsWith(".sh") ? 0o755 : 0o644 });
  }
}

interface Rig {
  dir: string;
  origin: string;
  repo: string;
  work: string;
  v2: string;
}

/** origin has main at v0.2.0 (tags v0.1.0, v0.2.0); the checkout is a clone at v0.1.0 (branch main). */
function makeRig(opts: { shallow?: boolean; fetchTagIntoClone?: boolean } = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), "co-rig-"));
  dirs.push(dir);
  const work = join(dir, "work");
  const origin = join(dir, "origin.git");
  const repo = join(dir, "repo");
  mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  write(work, V1);
  writeFileSync(join(work, ".gitignore"), ".env\nbackups/\n.tugra-host-applied\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "v1");
  git(work, "tag", "v0.1.0");
  const v1 = git(work, "rev-parse", "HEAD");
  write(work, V2);
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "v2");
  git(work, "tag", "v0.2.0");
  const v2 = git(work, "rev-parse", "HEAD");
  // The install was cloned when the release server only had v1; the remote later gained v2 (same URL afterwards).
  const origin1 = join(dir, "origin1.git");
  git(dir, "init", "-q", "--bare", origin1);
  git(work, "push", "-q", origin1, `${v1}:refs/heads/main`, "refs/tags/v0.1.0");
  git(dir, "init", "-q", "--bare", origin);
  git(work, "push", "-q", origin, "main", "--tags");
  git(dir, "clone", "-q", "--no-tags", ...(opts.shallow ? ["--depth", "1", `file://${origin1}`] : [origin1]), "repo");
  git(repo, "tag", "v0.1.0", v1);
  git(repo, "remote", "set-url", "origin", opts.shallow ? `file://${origin}` : origin);
  if (opts.fetchTagIntoClone) git(repo, "fetch", "-q", "--no-tags", "origin", "+refs/tags/v0.2.0:refs/tags/v0.2.0");
  return { dir, origin, repo, work, v2 };
}

/** What the in-app updater leaves behind: the release's managed files written over the checkout. */
function applyRelease(repo: string): void {
  const managed = Object.fromEntries(Object.entries(V2).filter(([p]) => p === "deploy/docker-compose.yml" || p.startsWith("scripts/")));
  write(repo, managed);
}

function co(repo: string, version: string, opts: { list?: string; fetch?: 0 | 1; env?: NodeJS.ProcessEnv } = {}): { rc: number; result: string; note: string; out: string } {
  const script = `. "${LIB}"; REPO_DIR="${repo}"; co_sync "${version}" "${opts.list ?? ""}" "${opts.fetch ?? 1}"; rc=$?; echo "RC=$rc"; echo "RESULT=$CO_RESULT"; echo "NOTE=$CO_NOTE"`;
  const r = spawnSync(BASH, ["-c", script], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, ...(opts.env ?? {}) } });
  const out = `${r.stdout}${r.stderr}`;
  const pick = (k: string) => (new RegExp(`^${k}=(.*)$`, "m").exec(r.stdout)?.[1] ?? "");
  return { rc: Number(pick("RC")), result: pick("RESULT"), note: pick("NOTE"), out };
}

const status = (repo: string) => execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repo, encoding: "utf8" }).replace(/\n$/, "");

describe("scripts/lib/checkout.sh", () => {
  it("is valid bash syntax", () => {
    expect(() => execFileSync("bash", ["-n", LIB])).not.toThrow();
  });

  it("a checkout dirtied only by the updater's files (modified + a new untracked lib) is moved to the release tag and ends clean", () => {
    const rig = makeRig({ fetchTagIntoClone: true });
    applyRelease(rig.repo);
    expect(status(rig.repo)).toContain("M scripts/install.sh");
    expect(status(rig.repo)).toContain("?? scripts/lib/images.sh");
    // the failure the bug report describes: git itself refuses the documented upgrade paths
    expect(() => git(rig.repo, "checkout", "v0.2.0")).toThrow();

    const r = co(rig.repo, "0.2.0");
    expect(r.rc).toBe(0);
    expect(r.result).toBe("synced");
    expect(status(rig.repo)).toBe("");
    expect(git(rig.repo, "rev-parse", "HEAD")).toBe(rig.v2);
    // a fast-forward keeps the branch, so `git pull` keeps working
    expect(git(rig.repo, "symbolic-ref", "--short", "HEAD")).toBe("main");
    // the rest of the tree followed the tag, and the managed files are exactly the release's
    expect(readFileSync(join(rig.repo, "apps", "app.txt"), "utf8")).toBe("app v2\n");
    expect(readFileSync(join(rig.repo, "scripts", "lib", "images.sh"), "utf8")).toBe(V2["scripts/lib/images.sh"]);
    expect(() => git(rig.repo, "pull", "-q", "--ff-only")).not.toThrow();
  });

  it("fetches the release tag when the checkout does not have it yet", () => {
    const rig = makeRig();
    expect(() => git(rig.repo, "rev-parse", "-q", "--verify", "refs/tags/v0.2.0")).toThrow();
    applyRelease(rig.repo);
    const r = co(rig.repo, "0.2.0");
    expect(r.result).toBe("synced");
    expect(status(rig.repo)).toBe("");
    expect(git(rig.repo, "rev-parse", "HEAD")).toBe(rig.v2);
  });

  it("works on a shallow checkout (shallow tag fetch; the branch is kept because it has no local commits)", () => {
    const rig = makeRig({ shallow: true });
    expect(git(rig.repo, "rev-parse", "--is-shallow-repository")).toBe("true");
    applyRelease(rig.repo);
    const r = co(rig.repo, "0.2.0");
    expect(r.result).toBe("synced");
    expect(status(rig.repo)).toBe("");
    expect(git(rig.repo, "rev-parse", "HEAD")).toBe(rig.v2);
    expect(git(rig.repo, "symbolic-ref", "--short", "HEAD")).toBe("main");
  });

  it("a real local edit (differs from the release too) is preserved and reported; git stays untouched", () => {
    const rig = makeRig({ fetchTagIntoClone: true });
    applyRelease(rig.repo);
    writeFileSync(join(rig.repo, "scripts", "install.sh"), "#!/usr/bin/env bash\n# my own edit\n");
    const headBefore = git(rig.repo, "rev-parse", "HEAD");
    const statusBefore = status(rig.repo);
    const r = co(rig.repo, "0.2.0");
    expect(r.rc).toBe(1);
    expect(r.result).toBe("skipped");
    expect(r.note).toContain("scripts/install.sh");
    expect(r.note).toContain("local edit");
    expect(git(rig.repo, "rev-parse", "HEAD")).toBe(headBefore);
    expect(status(rig.repo)).toBe(statusBefore);
    expect(readFileSync(join(rig.repo, "scripts", "install.sh"), "utf8")).toContain("my own edit");
    // nothing was staged either
    expect(git(rig.repo, "diff", "--cached", "--name-only")).toBe("");
  });

  it("offline: tag not in the repo and the remote unreachable is a graceful skip with nothing changed", () => {
    const rig = makeRig();
    applyRelease(rig.repo);
    git(rig.repo, "remote", "set-url", "origin", join(rig.dir, "no-such-remote.git"));
    const before = status(rig.repo);
    const r = co(rig.repo, "0.2.0");
    expect(r.rc).toBe(1);
    expect(r.result).toBe("skipped");
    expect(r.note).toMatch(/could not be fetched/);
    expect(status(rig.repo)).toBe(before);
    expect(git(rig.repo, "rev-parse", "HEAD")).not.toBe(rig.v2);
  });

  it("fetching disallowed (hard-off) never touches the network and leaves git alone", () => {
    const rig = makeRig();
    applyRelease(rig.repo);
    const r = co(rig.repo, "0.2.0", { fetch: 0 });
    expect(r.result).toBe("skipped");
    expect(git(rig.repo, "rev-parse", "HEAD")).not.toBe(rig.v2);
    expect(() => git(rig.repo, "rev-parse", "-q", "--verify", "refs/tags/v0.2.0")).toThrow();
  });

  it("other local changes survive: an untracked override file and an edit to a file the release does not change", () => {
    const rig = makeRig({ fetchTagIntoClone: true });
    applyRelease(rig.repo);
    writeFileSync(join(rig.repo, "deploy", "docker-compose.override.yml"), "services: {}\n");
    writeFileSync(join(rig.repo, "README.md"), "readme v1 + my note\n");
    const r = co(rig.repo, "0.2.0");
    expect(r.result).toBe("synced");
    expect(readFileSync(join(rig.repo, "deploy", "docker-compose.override.yml"), "utf8")).toBe("services: {}\n");
    expect(readFileSync(join(rig.repo, "README.md"), "utf8")).toBe("readme v1 + my note\n");
    expect(status(rig.repo).split("\n").sort()).toEqual([" M README.md", "?? deploy/docker-compose.override.yml"]);
    expect(git(rig.repo, "rev-parse", "HEAD")).toBe(rig.v2);
  });

  it("a local edit to a non-managed file that the release changes blocks the move; git is put back exactly as it was", () => {
    const rig = makeRig({ fetchTagIntoClone: true });
    applyRelease(rig.repo);
    writeFileSync(join(rig.repo, "apps", "app.txt"), "app v1 + my change\n");
    const headBefore = git(rig.repo, "rev-parse", "HEAD");
    const statusBefore = status(rig.repo);
    const r = co(rig.repo, "0.2.0");
    expect(r.rc).toBe(1);
    expect(r.result).toBe("skipped");
    expect(r.note).toContain("git refused");
    expect(git(rig.repo, "rev-parse", "HEAD")).toBe(headBefore);
    expect(status(rig.repo)).toBe(statusBefore);
    expect(git(rig.repo, "diff", "--cached", "--name-only")).toBe("");
    expect(readFileSync(join(rig.repo, "apps", "app.txt"), "utf8")).toBe("app v1 + my change\n");
  });

  it("a branch with local commits is detached at the release instead of being rewound", () => {
    const rig = makeRig({ fetchTagIntoClone: true });
    writeFileSync(join(rig.repo, "mine.txt"), "mine\n");
    git(rig.repo, "add", "mine.txt");
    git(rig.repo, "commit", "-q", "-m", "local");
    const mine = git(rig.repo, "rev-parse", "HEAD");
    applyRelease(rig.repo);
    const r = co(rig.repo, "0.2.0");
    expect(r.result).toBe("synced");
    expect(() => git(rig.repo, "symbolic-ref", "-q", "HEAD")).toThrow(); // detached
    expect(git(rig.repo, "rev-parse", "HEAD")).toBe(rig.v2);
    expect(git(rig.repo, "rev-parse", "main")).toBe(mine); // the local commit is still on its branch
  });

  it("a clean checkout, a non-git directory and a missing git are all left alone", () => {
    const rig = makeRig({ fetchTagIntoClone: true });
    expect(co(rig.repo, "0.2.0").result).toBe("clean");
    expect(git(rig.repo, "rev-parse", "HEAD")).not.toBe(rig.v2);
    const plain = mkdtempSync(join(tmpdir(), "co-plain-"));
    dirs.push(plain);
    const r = co(plain, "0.2.0");
    expect(r.rc).toBe(0);
    expect(r.result).toBe("not-a-checkout");
  });

  it("refuses when the signed list does not describe the tag's content", () => {
    const rig = makeRig({ fetchTagIntoClone: true });
    applyRelease(rig.repo);
    const list = join(rig.dir, "list");
    writeFileSync(list, `${"0".repeat(64)}  scripts/install.sh\n`);
    const r = co(rig.repo, "0.2.0", { list });
    expect(r.result).toBe("skipped");
    expect(r.note).toContain("signed release content");
    expect(git(rig.repo, "rev-parse", "HEAD")).not.toBe(rig.v2);
  });

  it("leaves a checkout in the middle of a merge alone", () => {
    const rig = makeRig({ fetchTagIntoClone: true });
    applyRelease(rig.repo);
    writeFileSync(join(rig.repo, ".git", "MERGE_HEAD"), `${git(rig.repo, "rev-parse", "HEAD")}\n`);
    const r = co(rig.repo, "0.2.0");
    expect(r.result).toBe("skipped");
    expect(r.note).toContain("in progress");
    expect(existsSync(join(rig.repo, ".git", "MERGE_HEAD"))).toBe(true);
  });
  describe("review fixes", () => {
    /** `id -u` says 0 and chown only logs: lets a normal user observe the sidecar's (root) ownership repair. */
    function rootStubs(rig: Rig): { env: NodeJS.ProcessEnv; log: string } {
      const bin = join(rig.dir, "stubs");
      const log = join(rig.dir, "chown.log");
      mkdirSync(bin);
      const realId = execFileSync("sh", ["-c", "command -v id"]).toString().trim();
      writeFileSync(join(bin, "id"), `#!/bin/sh\nif [ "$1" = "-u" ]; then echo 0; else exec ${realId} "$@"; fi\n`, { mode: 0o755 });
      writeFileSync(join(bin, "chown"), `#!/bin/sh\necho "$@" >> "${log}"\n`, { mode: 0o755 });
      return { env: { PATH: `${bin}:${process.env.PATH}` }, log };
    }
    const chowned = (log: string) => (existsSync(log) ? readFileSync(log, "utf8") : "");

    it("hands git's files back to the checkout's owner even when the run ends in a skip (local edit after the fetch)", () => {
      const rig = makeRig(); // tag not in the clone yet: the fetch (as root) writes into .git
      applyRelease(rig.repo);
      writeFileSync(join(rig.repo, "scripts", "install.sh"), "#!/usr/bin/env bash\n# my own edit\n");
      const stubs = rootStubs(rig);
      const r = co(rig.repo, "0.2.0", { env: stubs.env });
      expect(r.result).toBe("skipped");
      expect(chowned(stubs.log)).toMatch(/-R .*\.git/);
    });

    it("hands ownership back when the signed list does not match too", () => {
      const rig = makeRig();
      applyRelease(rig.repo);
      const list = join(rig.dir, "list");
      writeFileSync(list, `${"0".repeat(64)}  scripts/install.sh\n`);
      const stubs = rootStubs(rig);
      const r = co(rig.repo, "0.2.0", { list, env: stubs.env });
      expect(r.note).toContain("signed release content");
      expect(chowned(stubs.log)).toMatch(/-R .*\.git/);
    });

    it("does not touch ownership when git was never asked to write (clean checkout)", () => {
      const rig = makeRig({ fetchTagIntoClone: true });
      const stubs = rootStubs(rig);
      expect(co(rig.repo, "0.2.0", { env: stubs.env }).result).toBe("clean");
      expect(chowned(stubs.log)).toBe("");
    });

    it("the tag fetch writes no FETCH_HEAD", () => {
      const rig = makeRig();
      applyRelease(rig.repo);
      expect(co(rig.repo, "0.2.0").result).toBe("synced");
      expect(existsSync(join(rig.repo, ".git", "FETCH_HEAD"))).toBe(false);
    });

    it("a detached HEAD with a local commit no ref reaches keeps that commit on a rescue branch and its file", () => {
      const rig = makeRig({ fetchTagIntoClone: true });
      git(rig.repo, "checkout", "-q", "--detach", "v0.1.0");
      writeFileSync(join(rig.repo, "apps", "mine.txt"), "mine\n");
      git(rig.repo, "add", "apps/mine.txt");
      git(rig.repo, "commit", "-q", "-m", "local");
      const mine = git(rig.repo, "rev-parse", "HEAD");
      applyRelease(rig.repo);
      const r = co(rig.repo, "0.2.0");
      expect(r.result).toBe("synced");
      expect(git(rig.repo, "rev-parse", "HEAD")).toBe(rig.v2);
      expect(git(rig.repo, "branch", "--contains", mine, "--format=%(refname:short)")).toMatch(/^tugra-local-/);
      expect(status(rig.repo)).toBe("");
    });

    it("a detached HEAD on a tagged commit (a tag install) moves without creating any branch", () => {
      const rig = makeRig({ fetchTagIntoClone: true });
      git(rig.repo, "checkout", "-q", "--detach", "v0.1.0");
      applyRelease(rig.repo);
      expect(co(rig.repo, "0.2.0").result).toBe("synced");
      expect(git(rig.repo, "branch", "--list", "tugra-local-*")).toBe("");
    });

    it("the branch name is kept only when git pull still fast-forwards: a tag off origin's line detaches", () => {
      const rig = makeRig();
      // a release tag cut from an unrelated line of history (a release branch), with the v2 managed files
      git(rig.work, "checkout", "-q", "--orphan", "rel");
      git(rig.work, "rm", "-rfq", ".");
      write(rig.work, V2);
      writeFileSync(join(rig.work, ".gitignore"), ".env\nbackups/\n.tugra-host-applied\n");
      git(rig.work, "add", "-A");
      git(rig.work, "commit", "-q", "-m", "rel");
      git(rig.work, "tag", "v0.3.0");
      git(rig.work, "push", "-q", rig.origin, "refs/tags/v0.3.0");
      const old = git(rig.repo, "rev-parse", "HEAD");
      expect(git(rig.repo, "rev-parse", "origin/main")).toBe(old);
      applyRelease(rig.repo);
      const r = co(rig.repo, "0.3.0");
      expect(r.result).toBe("synced");
      expect(() => git(rig.repo, "symbolic-ref", "-q", "HEAD")).toThrow(); // detached
      expect(git(rig.repo, "rev-parse", "main")).toBe(old);
    });

    it("an operator's core.sshCommand (deploy key) is not overridden by a default GIT_SSH_COMMAND", () => {
      const rig = makeRig();
      applyRelease(rig.repo);
      const called = join(rig.dir, "ssh-called");
      const fake = join(rig.dir, "fake-ssh.sh");
      writeFileSync(fake, `#!/bin/sh\necho "$@" > "${called}"\nexit 1\n`, { mode: 0o755 });
      git(rig.repo, "config", "core.sshCommand", fake);
      git(rig.repo, "remote", "set-url", "origin", "ssh://git@127.0.0.1:1/none.git");
      const r = co(rig.repo, "0.2.0");
      expect(r.result).toBe("skipped");
      expect(existsSync(called)).toBe(true);
    });
  });
});
