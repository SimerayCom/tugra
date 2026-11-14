import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  gitCloneSteps,
  buildRunScript,
  buildBuildOnlyScript,
  buildRollingDeployScript,
  buildRecreateDeployScript,
  type AppSpec,
} from "./deploy-script";

const BD = "/etc/tugra/builds/abc";
const git: AppSpec = { id: "abc", source: "GIT", gitUrl: "https://github.com/acme/app.git", gitBranch: "main", buildType: "DOCKERFILE", env: {}, hostPort: null, containerPort: 80 };
const joined = (a: AppSpec) => gitCloneSteps(a, BD).join("\n");
const gate = { retries: 1, intervalSec: 1, startPeriodSec: 0 };

describe("gitCloneSteps: defaults are byte-identical", () => {
  it("a raw spec with none of the new fields emits nothing new", () => {
    const s = joined(git);
    expect(s).not.toMatch(/GIT_LFS_SKIP_SMUDGE|submodule|lfs|unset/);
    expect(s).toContain(`git clone --depth 1 --branch 'main' -- 'https://github.com/acme/app.git' ${BD}`);
  });
  it("token auth keeps the original two-line askpass when neither submodules nor LFS is on", () => {
    const s = joined({ ...git, gitToken: "tok" });
    expect(s).toContain(`printf '%s\\n' '#!/bin/sh' 'cat "$(dirname "$0")/token"' > "$sd/askpass"`);
  });
});

describe("gitCloneSteps: shallow clone", () => {
  it("gitShallowClone:false drops --depth 1", () => {
    const s = joined({ ...git, gitShallowClone: false });
    expect(s).toContain(`git clone --branch 'main' -- 'https://github.com/acme/app.git' ${BD}`);
    expect(s).not.toContain("--depth");
  });
  it("gitShallowClone:true keeps --depth 1; a pinned commit never has it", () => {
    expect(joined({ ...git, gitShallowClone: true })).toContain("git clone --depth 1");
    expect(joined({ ...git, gitShallowClone: true, gitCommit: "abc1234" })).not.toContain("--depth");
  });
});

describe("gitCloneSteps: LFS", () => {
  it("gitLfs:false skips smudge, warns on lfs attributes, and unsets before the commit markers", () => {
    const steps = gitCloneSteps({ ...git, gitLfs: false }, BD);
    expect(steps[0]).toBe(`rm -rf ${BD} && mkdir -p ${BD}`);
    expect(steps[1]).toBe("export GIT_LFS_SKIP_SMUDGE=1");
    const s = steps.join("\n");
    expect(s).toContain(`grep -qs 'filter=lfs' ${BD}/.gitattributes`);
    expect(s).not.toContain("lfs pull");
    expect(s.indexOf("unset GIT_LFS_SKIP_SMUDGE")).toBeLessThan(s.indexOf("TUGRA_C="));
    expect(s.indexOf("unset GIT_LFS_SKIP_SMUDGE")).toBeGreaterThan(s.indexOf("git clone"));
  });
  it("a missing git-lfs fails with the agent-image wording", () => {
    expect(joined({ ...git, gitLfs: true })).toContain("TUGRA: this agent image has no git-lfs - update the agent or turn Git LFS off");
  });
  it("gitLfs:true checks for git-lfs, then pulls after the pin checkout", () => {
    const s = joined({ ...git, gitLfs: true, gitCommit: "abc1234" });
    expect(s).toContain("command -v git-lfs");
    expect(s.indexOf("command -v git-lfs")).toBeLessThan(s.indexOf("git clone"));
    expect(s.indexOf("checkout 'abc1234'")).toBeLessThan(s.indexOf(`git -C ${BD} lfs pull`));
    expect(s.indexOf(`git -C ${BD} lfs pull`)).toBeLessThan(s.indexOf("TUGRA_C="));
    expect(s).not.toContain("filter=lfs");
  });
});

describe("gitCloneSteps: submodules", () => {
  it("runs after the pin and before the commit markers, with file/ext transports refused", () => {
    const s = joined({ ...git, gitSubmodules: true, gitCommit: "abc1234" });
    expect(s).toContain("-c protocol.file.allow=never -c protocol.ext.allow=never submodule update --init --recursive");
    expect(s.indexOf("checkout 'abc1234'")).toBeLessThan(s.indexOf("submodule update"));
    expect(s.indexOf("submodule update")).toBeLessThan(s.indexOf("TUGRA_C="));
    expect(s).toContain("TUGRA: submodule clone failed");
  });
  it("shallow clones try --depth 1 first then fall back; pinned/full clones never use --depth", () => {
    const shallow = joined({ ...git, gitSubmodules: true });
    expect(shallow).toMatch(/submodule update --init --recursive --depth 1 \|\| .*submodule update --init --recursive \|\| \{/);
    const full = joined({ ...git, gitSubmodules: true, gitShallowClone: false });
    expect(full).not.toContain("--recursive --depth 1");
  });
  it("follow-up git commands carry the matching auth env for ssh, token and public repos", () => {
    const ssh = joined({ ...git, gitUrl: "git@github.com:acme/app.git", gitSshKey: "KEY", gitSubmodules: true });
    expect(ssh).toMatch(/GIT_SSH_COMMAND="ssh -F \/dev\/null[^\n]*" GIT_TERMINAL_PROMPT=0 git -C [^\n]*submodule update/);
    const tok = joined({ ...git, gitToken: "tok", gitSubmodules: true });
    expect(tok).toContain(`GIT_ASKPASS="$sd/askpass" GIT_TERMINAL_PROMPT=0 git -C ${BD} -c protocol.file.allow=never`);
    const pub = joined({ ...git, gitSubmodules: true });
    expect(pub).toContain(`GIT_TERMINAL_PROMPT=0 git -C ${BD} -c protocol.file.allow=never`);
  });
  it("submodules + LFS also pulls LFS inside each submodule", () => {
    expect(joined({ ...git, gitSubmodules: true, gitLfs: true })).toContain("submodule foreach --recursive 'git lfs pull'");
    expect(joined({ ...git, gitLfs: true })).not.toContain("submodule foreach");
  });
});

describe("gitCloneSteps: host-pinned askpass", () => {
  const askpassOf = (s: string) => {
    const m = /printf %s '([A-Za-z0-9+/=]+)' \| base64 -d > "\$sd\/askpass"/.exec(s);
    return m ? Buffer.from(m[1], "base64").toString("utf8") : null;
  };
  it("is written only with submodules or LFS, and answers only for the repo's own host", () => {
    const body = askpassOf(joined({ ...git, gitToken: "tok", gitSubmodules: true }));
    expect(body).toContain(`"Username for 'https://github.com': ") echo x-access-token ;;`);
    expect(body).toContain(`"Password for 'https://x-access-token@github.com': ") cat "$(dirname "$0")/token" ;;`);
    expect(body).toContain("*) exit 1 ;;");
    expect(body).not.toMatch(/\*"/); // no substring (glob) matching on the prompt
    expect(askpassOf(joined({ ...git, gitToken: "tok", gitLfs: true }))).not.toBeNull();
    expect(askpassOf(joined({ ...git, gitToken: "tok" }))).toBeNull();
  });
  it("keeps a port in the pinned host", () => {
    expect(askpassOf(joined({ ...git, gitUrl: "https://git.example.com:8443/a/b.git", gitToken: "t", gitSubmodules: true }))).toContain("'https://git.example.com:8443': ");
  });
  it("executed: answers the exact legit prompts and refuses spoofed ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "askpass-"));
    try {
      writeFileSync(join(dir, "askpass"), askpassOf(joined({ ...git, gitToken: "tok", gitSubmodules: true }))!, { mode: 0o700 });
      writeFileSync(join(dir, "token"), "s3cret-token");
      const run = (prompt: string) => spawnSync("bash", [join(dir, "askpass"), prompt], { encoding: "utf8" });
      expect(run("Username for 'https://github.com': ").stdout.trim()).toBe("x-access-token");
      expect(run("Password for 'https://x-access-token@github.com': ").stdout).toBe("s3cret-token");
      const spoofs = [
        "Password for 'https:////github.com'@evil.example': ", // percent-decoded userinfo spoof ending in the host
        "Password for 'https://%40github.com%27@evil.example': ",
        "Password for 'https://x-access-token@evil.example': ",
        "Password for 'https://x-access-token@github.com.evil.example': ",
        "Username for 'https://evil.example/github.com': ",
        "Password for 'https://github.com': ", // wrong user
        "",
      ];
      for (const p of spoofs) {
        const r = run(p);
        expect({ p, status: r.status, out: r.stdout }).toEqual({ p, status: 1, out: "" });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("fails closed when the host cannot be derived", () => {
    const s = joined({ ...git, gitUrl: "https://bad host/x.git", gitToken: "t", gitSubmodules: true });
    expect(s).toContain("TUGRA: cannot derive the repo host");
  });
});

describe("prepSteps: no-cache flags for the non-Docker builders", () => {
  const nix = { ...git, buildType: "NIXPACKS" as const };
  const pack = { ...git, buildType: "HEROKU" as const };
  it("noCache adds --no-cache (nixpacks) and --clear-cache (pack)", () => {
    expect(buildRunScript(nix, "v1", true, true)).toContain("--name tugra_abc:v1 --no-cache /etc/tugra/builds/abc");
    expect(buildRunScript(pack, "v1", true, true)).toContain("--pull-policy if-not-present --clear-cache");
  });
  it("without noCache the commands are unchanged", () => {
    expect(buildRunScript(nix, "v1", true, false)).not.toContain("--no-cache");
    expect(buildRunScript(pack, "v1", true, false)).not.toContain("--clear-cache");
    expect(buildRunScript(nix, "v1", true, false)).toContain("nixpacks build -c /etc/tugra/builds/abc.plan.json --cache-key 'abc' --name tugra_abc:v1 /etc/tugra/builds/abc");
  });
});

describe("prepSteps: sourceCommitMode BUILD", () => {
  const b = { ...git, sourceCommitMode: "BUILD" as const };
  it("DOCKERFILE gets a --build-arg from the cloned SHA", () => {
    expect(buildRunScript(b, "v1")).toContain(`--build-arg "SOURCE_COMMIT=$TUGRA_C" -t tugra_abc:v1`);
  });
  it("nixpacks / pack / railpack get --env", () => {
    for (const bt of ["NIXPACKS", "HEROKU", "RAILPACK"] as const) {
      expect(buildRunScript({ ...b, buildType: bt }, "v1")).toContain(`--env "SOURCE_COMMIT=$TUGRA_C"`);
    }
  });
  it("a user SOURCE_COMMIT (build arg or env) suppresses it", () => {
    expect(buildRunScript({ ...b, buildArgs: { SOURCE_COMMIT: "x" } }, "v1")).not.toContain("SOURCE_COMMIT=$TUGRA_C\" -t");
    expect(buildRunScript({ ...b, env: { SOURCE_COMMIT: "x" } }, "v1")).not.toContain(`--build-arg "SOURCE_COMMIT=$TUGRA_C"`);
  });
  it("STATIC only logs a note", () => {
    const s = buildRunScript({ ...b, buildType: "STATIC" }, "v1");
    expect(s).toContain("sourceCommitMode BUILD has no effect on Static builds");
    expect(s).not.toContain(`--build-arg "SOURCE_COMMIT`);
  });
  it("RUNTIME / OFF / undefined add nothing to the build", () => {
    for (const m of ["RUNTIME", "OFF", undefined] as const) {
      expect(buildRunScript({ ...git, sourceCommitMode: m }, "v1")).not.toContain(`--build-arg "SOURCE_COMMIT`);
    }
  });
});

describe("prepSteps: injectEnvAsBuildArgs", () => {
  const inj = { ...git, injectEnvAsBuildArgs: true, env: { API_URL: "https://api", DB_PASSWORD: "hunter2", "bad-key": "x" } };
  it("passes env as --build-arg for DOCKERFILE and warns with key names only", () => {
    const s = buildRunScript(inj, "v1");
    expect(s).toContain("--build-arg 'API_URL=https://api'");
    expect(s).toContain("--build-arg 'DB_PASSWORD=hunter2'");
    expect(s).toContain("2 variable(s) are baked into the image history");
    expect(s).toContain("secret-looking variables are being baked into the image: DB_PASSWORD");
    expect(s).toContain("skipped 1 variable(s)");
    const echoes = s.split("\n").filter((l) => l.startsWith("echo 'TUGRA: injectEnvAsBuildArgs") || l.startsWith("echo 'TUGRA: WARNING"));
    for (const l of echoes) expect(l).not.toContain("hunter2");
  });
  it("is DOCKERFILE-only", () => {
    const s = buildRunScript({ ...inj, buildType: "NIXPACKS" }, "v1");
    expect(s).not.toContain("--build-arg");
    expect(s).not.toContain("injectEnvAsBuildArgs");
  });
  it("explicit build args win; flag off keeps the build line untouched", () => {
    expect(buildRunScript({ ...inj, buildArgs: { API_URL: "explicit" } }, "v1")).toContain("--build-arg 'API_URL=explicit'");
    const off = buildRunScript({ ...inj, injectEnvAsBuildArgs: false, buildArgs: { Z: "1" } }, "v1");
    expect(off).toContain("docker build --build-arg 'Z=1' -t tugra_abc:v1");
    expect(off).not.toContain("API_URL");
  });
  it("build secrets are never injected", () => {
    const s = buildRunScript({ ...inj, env: { NPM_TOKEN: "t", A: "1" }, buildSecrets: { NPM_TOKEN: "s" } }, "v1");
    expect(s).not.toContain("--build-arg 'NPM_TOKEN");
    expect(s).toContain("--build-arg 'A=1'");
  });
});

describe("runContainerArgs: runtime SOURCE_COMMIT", () => {
  const TOKEN = "${TUGRA_C:+-e SOURCE_COMMIT=$TUGRA_C}";
  it("RUNTIME / BUILD emit the guarded token after --env-file", () => {
    const s = buildRunScript({ ...git, env: { A: "1" }, sourceCommitMode: "RUNTIME" }, "v1");
    expect(s).toContain(`--env-file`);
    expect(s.indexOf("--env-file")).toBeLessThan(s.indexOf(TOKEN));
    expect(buildRunScript({ ...git, sourceCommitMode: "BUILD" }, "v1")).toContain(TOKEN);
    expect(s).not.toContain("TUGRA_COMMIT ");
  });
  it("a hex sourceCommit is emitted literally; a non-hex one falls back to the guard", () => {
    expect(buildRunScript({ ...git, sourceCommitMode: "RUNTIME", sourceCommit: "abc1234" }, "v1", false)).toContain("-e SOURCE_COMMIT=abc1234");
    const bad = buildRunScript({ ...git, sourceCommitMode: "RUNTIME", sourceCommit: "x; rm -rf /" }, "v1", false);
    expect(bad).not.toContain("rm -rf /");
    expect(bad).toContain(TOKEN);
  });
  it("OFF, undefined, IMAGE and a user SOURCE_COMMIT env emit nothing", () => {
    expect(buildRunScript({ ...git, sourceCommitMode: "OFF" }, "v1")).not.toContain("SOURCE_COMMIT=$");
    expect(buildRunScript(git, "v1")).not.toContain("SOURCE_COMMIT");
    expect(buildRunScript({ ...git, source: "IMAGE", image: "nginx", sourceCommitMode: "RUNTIME" }, "v1")).not.toContain("SOURCE_COMMIT");
    expect(buildRunScript({ ...git, sourceCommitMode: "RUNTIME", env: { SOURCE_COMMIT: "mine" } }, "v1")).not.toContain("SOURCE_COMMIT=$");
  });
  it("rolling and recreate re-runs carry the token", () => {
    const g = { ...git, sourceCommitMode: "RUNTIME" as const };
    expect(buildRollingDeployScript({ ...g, domain: "app.example.com" }, "v1", { probe: { kind: "stableWait" }, ...gate })).toContain(TOKEN);
    expect(buildRecreateDeployScript({ ...g, hostPort: 8080 }, "v1", { probe: { kind: "stableWait" }, ...gate })).toContain(TOKEN);
  });
  it("recreate rollback runs the previous image with the PREVIOUS commit, never the new clone's TUGRA_C", () => {
    const g = { ...git, sourceCommitMode: "RUNTIME" as const, hostPort: 8080 };
    const out = buildRecreateDeployScript(g, "v2", { prevVersion: "v1", prevCommit: "abc1234def", probe: { kind: "stableWait" }, ...gate });
    const rb = out.split("\n").find((l) => l.includes("rolled_back"))!;
    expect(rb).toContain("tugra_abc:v1");
    expect(rb).toContain("-e SOURCE_COMMIT=abc1234def");
    expect(rb).not.toContain("${TUGRA_C");
    expect(out).toContain(TOKEN); // the NEW container still reads the new clone's SHA
    // unknown / invalid previous commit (e.g. non-GIT history, null) -> no SOURCE_COMMIT at all on the rollback line
    for (const prevCommit of [null, undefined, "x; rm -rf /"]) {
      const o = buildRecreateDeployScript(g, "v2", { prevVersion: "v1", prevCommit, probe: { kind: "stableWait" }, ...gate });
      const line = o.split("\n").find((l) => l.includes("rolled_back"))!;
      expect(line).not.toContain("SOURCE_COMMIT");
      expect(line).not.toContain("TUGRA_C");
      expect(line).not.toContain("rm -rf /");
    }
  });
  it("the build-only script (build server) clones with the new flags", () => {
    const s = buildBuildOnlyScript({ ...git, gitSubmodules: true, gitLfs: false }, "v1");
    expect(s).toContain("submodule update");
    expect(s).toContain("export GIT_LFS_SKIP_SMUDGE=1");
  });
});
