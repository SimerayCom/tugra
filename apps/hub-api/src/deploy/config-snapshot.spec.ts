import { buildConfigSnapshot, diffSnapshots } from "./config-snapshot";
import type { AppSpec } from "./deploy-script";

function spec(over: Partial<AppSpec> = {}): AppSpec {
  return {
    id: "a1",
    source: "IMAGE",
    image: "nginx:1",
    buildType: "NIXPACKS",
    memoryMb: 256,
    cpus: null,
    env: { FOO: "bar", SECRET_KEY: "s3cr3t" },
    hostPort: null,
    containerPort: 80,
    ...over,
  };
}

describe("buildConfigSnapshot", () => {
  it("never stores raw env values — only fingerprints", () => {
    const snap = buildConfigSnapshot(spec());
    const blob = JSON.stringify(snap);
    expect(blob).not.toContain("s3cr3t");
    expect(blob).not.toContain("bar");
    expect(Object.keys(snap.env).sort()).toEqual(["FOO", "SECRET_KEY"]);
    expect(snap.env.FOO).toMatch(/^[0-9a-f]{12}$/);
  });

  it("records credential presence as booleans, not values", () => {
    const snap = buildConfigSnapshot(spec({ gitToken: "ghp_abc", registryAuth: { user: "u", token: "t" } }));
    expect(snap.hasGitToken).toBe(true);
    expect(snap.hasRegistryAuth).toBe(true);
    expect(JSON.stringify(snap)).not.toContain("ghp_abc");
    const bare = buildConfigSnapshot(spec());
    expect(bare.hasGitToken).toBe(false);
    expect(bare.hasRegistryAuth).toBe(false);
  });

  it("carries scalar build/runtime fields", () => {
    const snap = buildConfigSnapshot(spec({ image: "nginx:2", memoryMb: 512 }));
    expect(snap.image).toBe("nginx:2");
    expect(snap.memoryMb).toBe(512);
    expect(snap.containerPort).toBe(80);
  });

  it("records the gpus field so a GPU config change appears in the deploy diff", () => {
    expect(buildConfigSnapshot(spec({ gpus: "all" })).gpus).toBe("all");
    const changes = diffSnapshots(buildConfigSnapshot(spec()), buildConfigSnapshot(spec({ gpus: "all" })));
    expect(changes).toContainEqual(expect.objectContaining({ field: "gpus", kind: "changed", after: "all" }));
  });

  it("records the gzip field so toggling compression shows in the deploy diff", () => {
    expect(buildConfigSnapshot(spec({ gzip: true })).gzip).toBe(true);
    // diffSnapshots stringifies scalar values (see the gpus case), so the rendered change is "true".
    const changes = diffSnapshots(buildConfigSnapshot(spec({ gzip: false })), buildConfigSnapshot(spec({ gzip: true })));
    expect(changes).toContainEqual(expect.objectContaining({ field: "gzip", kind: "changed", after: "true" }));
  });

  it("records the nixpacks command overrides so changing one shows in the deploy diff", () => {
    expect(buildConfigSnapshot(spec({ nixpacksBuildCmd: "npm run build" })).nixpacksBuildCmd).toBe("npm run build");
    const changes = diffSnapshots(buildConfigSnapshot(spec()), buildConfigSnapshot(spec({ nixpacksBuildCmd: "vite build" })));
    expect(changes).toContainEqual(expect.objectContaining({ field: "nixpacksBuildCmd", kind: "changed", after: "vite build" }));
  });

  it("records the container ops/networking scalars only when set (no spurious first-deploy diff)", () => {
    const plain = buildConfigSnapshot(spec());
    for (const k of ["restartPolicy", "restartMaxRetries", "stopGracePeriodSec", "drainSec", "containerAlias", "networks"]) {
      expect(plain).not.toHaveProperty(k);
    }
    // An old snapshot (no keys) vs a new one with everything unset → no change entries.
    expect(diffSnapshots(plain, buildConfigSnapshot(spec({ stopGracePeriodSec: null, drainSec: 0, networks: [], containerAlias: null })))).toEqual([]);
    const set = buildConfigSnapshot(spec({ restartPolicy: "on-failure", restartMaxRetries: 3, stopGracePeriodSec: 30, drainSec: 5, containerAlias: "api" }));
    expect(set).toMatchObject({ restartPolicy: "on-failure", restartMaxRetries: 3, stopGracePeriodSec: 30, drainSec: 5, containerAlias: "api" });
    const changes = diffSnapshots(plain, set);
    expect(changes).toContainEqual(expect.objectContaining({ field: "stopGracePeriodSec", kind: "changed", before: "—", after: "30" }));
    expect(changes).toContainEqual(expect.objectContaining({ field: "containerAlias", after: "api" }));
  });

  it("records the extra limits only when set; an old snapshot does not diff against an all-unset new one", () => {
    const plain = buildConfigSnapshot(spec());
    for (const k of ["memorySwapMb", "pidsLimit", "shmSizeMb", "cpuShares", "cpusetCpus"]) expect(plain).not.toHaveProperty(k);
    expect(diffSnapshots(plain, buildConfigSnapshot(spec({ memorySwapMb: null, pidsLimit: null, shmSizeMb: null, cpuShares: null, cpusetCpus: "" })))).toEqual([]);
    const set = buildConfigSnapshot(spec({ memorySwapMb: -1, pidsLimit: 100, shmSizeMb: 64, cpuShares: 512, cpusetCpus: "0-1" }));
    expect(set).toMatchObject({ memorySwapMb: -1, pidsLimit: 100, shmSizeMb: 64, cpuShares: 512, cpusetCpus: "0-1" });
    const changes = diffSnapshots(plain, set);
    expect(changes).toContainEqual(expect.objectContaining({ field: "memorySwapMb", kind: "changed", before: "—", after: "-1" }));
    expect(changes).toContainEqual(expect.objectContaining({ field: "cpusetCpus", before: "—", after: "0-1" }));
    expect(diffSnapshots(set, buildConfigSnapshot(spec({ memorySwapMb: -1, pidsLimit: 200, shmSizeMb: 64, cpuShares: 512, cpusetCpus: "0-1" })))).toEqual([
      expect.objectContaining({ field: "pidsLimit", before: "100", after: "200" }),
    ]);
  });

  it("restartPolicy: an old snapshot without snapV never diffs it; two v2 snapshots do", () => {
    const { snapV: _v, ...old } = buildConfigSnapshot(spec()); // a snapshot from before restartPolicy was recorded
    expect(old).not.toHaveProperty("snapV");
    const now = buildConfigSnapshot(spec({ restartPolicy: "always" }));
    expect(now.snapV).toBe(2);
    expect(diffSnapshots(old, now).some((c) => c.field === "restartPolicy")).toBe(false);
    const d = diffSnapshots(buildConfigSnapshot(spec({ restartPolicy: "no" })), now);
    expect(d).toContainEqual({ field: "restartPolicy", kind: "changed", before: "no", after: "always" });
  });

  it("diffs extra networks as a set (added/removed), order-insensitive", () => {
    const a = buildConfigSnapshot(spec({ networks: ["b", "a"] }));
    expect(a.networks).toEqual(["a", "b"]);
    const changes = diffSnapshots(a, buildConfigSnapshot(spec({ networks: ["a", "c"] })));
    expect(changes).toContainEqual({ field: "network.c", kind: "added", after: "c" });
    expect(changes).toContainEqual({ field: "network.b", kind: "removed", before: "b" });
    expect(diffSnapshots(a, buildConfigSnapshot(spec({ networks: ["a", "b"] })))).toEqual([]);
  });

  it("fingerprints config-mount content (never stored verbatim)", () => {
    const snap = buildConfigSnapshot(
      spec({
        source: "COMPOSE",
        configMounts: [{ serviceName: "redis", target: "/etc/redis.conf", content: "requirepass hunter2\n", mode: "0644" }],
      }),
    );
    expect(snap.configMounts).toEqual([
      { target: "/etc/redis.conf", mode: "0644", fp: expect.stringMatching(/^[0-9a-f]{12}$/) },
    ]);
    expect(JSON.stringify(snap)).not.toContain("hunter2");
  });
});

describe("diffSnapshots", () => {
  it("returns nothing when prev is null (first deploy)", () => {
    expect(diffSnapshots(null, buildConfigSnapshot(spec()))).toEqual([]);
  });

  it("returns nothing when config is identical", () => {
    expect(diffSnapshots(buildConfigSnapshot(spec()), buildConfigSnapshot(spec()))).toEqual([]);
  });

  it("reports a scalar change with before/after", () => {
    const changes = diffSnapshots(buildConfigSnapshot(spec()), buildConfigSnapshot(spec({ memoryMb: 512 })));
    expect(changes).toContainEqual({ field: "memoryMb", kind: "changed", before: "256", after: "512" });
  });

  it("reports env added/removed/changed without revealing values", () => {
    const prev = buildConfigSnapshot(spec({ env: { FOO: "bar", OLD: "x" } }));
    const next = buildConfigSnapshot(spec({ env: { FOO: "baz", NEW: "y" } }));
    const changes = diffSnapshots(prev, next);
    expect(changes).toContainEqual({ field: "env.NEW", kind: "added", after: "•••" });
    expect(changes).toContainEqual({ field: "env.OLD", kind: "removed", before: "•••" });
    expect(changes).toContainEqual({ field: "env.FOO", kind: "changed", before: "•••", after: "•••" });
    expect(JSON.stringify(changes)).not.toContain("baz");
  });

  it("reports volume and credential presence changes", () => {
    const prev = buildConfigSnapshot(spec({ volumes: [{ name: "data", path: "/d" }] }));
    const next = buildConfigSnapshot(spec({ volumes: [{ name: "data", path: "/data" }], gitToken: "ghp" }));
    const changes = diffSnapshots(prev, next);
    expect(changes).toContainEqual({ field: "volume.data", kind: "changed", before: "/d", after: "/data" });
    expect(changes).toContainEqual({ field: "gitToken", kind: "added" });
  });

  it("reports a config-mount content change (keyed by target) without revealing content", () => {
    const mk = (content: string) =>
      buildConfigSnapshot(spec({ source: "COMPOSE", configMounts: [{ serviceName: "r", target: "/etc/r.conf", content, mode: "0644" }] }));
    const changes = diffSnapshots(mk("x=1"), mk("x=2"));
    expect(changes).toContainEqual({ field: "configMount./etc/r.conf", kind: "changed" });
    expect(JSON.stringify(changes)).not.toContain("x=2");
    // unchanged content → no entry
    expect(diffSnapshots(mk("x=1"), mk("x=1"))).toEqual([]);
  });

  it("diffs the compose path, extra domains and per-service domains", () => {
    // composePath is a scalar field
    expect(diffSnapshots(buildConfigSnapshot(spec({ composePath: "a.yml" })), buildConfigSnapshot(spec({ composePath: "b.yml" })))).toContainEqual(
      { field: "composePath", kind: "changed", before: "a.yml", after: "b.yml" },
    );
    // extra domains are a set
    const ed = diffSnapshots(buildConfigSnapshot(spec({ extraDomains: ["a.com", "b.com"] })), buildConfigSnapshot(spec({ extraDomains: ["a.com", "c.com"] })));
    expect(ed).toContainEqual({ field: "extraDomain.c.com", kind: "added", after: "c.com" });
    expect(ed).toContainEqual({ field: "extraDomain.b.com", kind: "removed", before: "b.com" });
    // per-service domains diff by hostname → service:port
    const sd = diffSnapshots(
      buildConfigSnapshot(spec({ serviceDomains: [{ service: "web", hostname: "x.com", port: 80 }] })),
      buildConfigSnapshot(spec({ serviceDomains: [{ service: "web", hostname: "x.com", port: 8080 }] })),
    );
    expect(sd).toContainEqual({ field: "serviceDomain.x.com", kind: "changed", before: "web:80", after: "web:8080" });
    // no routing change → no entries
    expect(diffSnapshots(buildConfigSnapshot(spec({ extraDomains: ["a.com"] })), buildConfigSnapshot(spec({ extraDomains: ["a.com"] })))).toEqual([]);
  });
});

describe("git/build settings in the snapshot", () => {
  const git = (over: Partial<AppSpec> = {}) => spec({ source: "GIT", gitUrl: "https://x/y.git", ...over });
  it("captures the six settings for a GIT spec", () => {
    const snap = buildConfigSnapshot(git({ gitSubmodules: true, gitLfs: false, gitShallowClone: true, disableBuildCache: true, injectEnvAsBuildArgs: false, sourceCommitMode: "BUILD" }));
    expect(snap).toMatchObject({ gitSubmodules: true, gitLfs: false, gitShallowClone: true, disableBuildCache: true, injectEnvAsBuildArgs: false, sourceCommitMode: "BUILD" });
  });
  it("a pre-upgrade snapshot (keys absent) vs a default-valued new one is not a change", () => {
    const before = buildConfigSnapshot(git());
    const after = buildConfigSnapshot(git({ gitSubmodules: false, gitLfs: false, gitShallowClone: true, disableBuildCache: false, injectEnvAsBuildArgs: false, sourceCommitMode: "RUNTIME" }));
    expect(diffSnapshots(before, after)).toEqual([]);
  });
  it("non-GIT snapshots (all undefined) never diff", () => {
    expect(diffSnapshots(buildConfigSnapshot(spec()), buildConfigSnapshot(spec()))).toEqual([]);
  });
  it("a real toggle shows up", () => {
    const d = diffSnapshots(buildConfigSnapshot(git({ gitLfs: false })), buildConfigSnapshot(git({ gitLfs: true, gitShallowClone: false })));
    expect(d).toContainEqual({ field: "gitLfs", kind: "changed", before: "false", after: "true" });
    expect(d).toContainEqual({ field: "gitShallowClone", kind: "changed", before: "true", after: "false" });
  });
  it("never records injected env as build args (no buildArgs in the snapshot)", () => {
    expect(JSON.stringify(buildConfigSnapshot(git({ injectEnvAsBuildArgs: true, buildArgs: { LEAK: "zzz" } })))).not.toContain("zzz");
  });
});

describe("env flags in the snapshot", () => {
  const git = (over: Partial<AppSpec> = {}) => spec({ source: "GIT", env: { A: "1", T: "tok" }, ...over });

  it("records tokens + build fingerprints only for flagged keys, never values; omits both when there are none", () => {
    const plain = buildConfigSnapshot(git());
    expect(plain.envFlags).toBeUndefined();
    expect(plain.buildEnv).toBeUndefined();
    const s = buildConfigSnapshot(git({ envMeta: { A: { multiline: true }, B: { buildTime: true, runtime: false } }, buildArgs: { B: "SECRETBUILDVALUE" } }));
    expect(s.envFlags).toEqual({ A: "multiline", B: "build-only" });
    expect(Object.keys(s.buildEnv!)).toEqual(["B"]);
    expect(s.buildEnv!.B).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(s)).not.toContain("SECRETBUILDVALUE");
  });

  it("an old snapshot without the fields yields no spurious diff", () => {
    const old = buildConfigSnapshot(git());
    expect(diffSnapshots(old, buildConfigSnapshot(git()))).toEqual([]);
    delete (old as { envFlags?: unknown }).envFlags;
    expect(diffSnapshots(old, buildConfigSnapshot(git()))).toEqual([]);
  });

  it("a flag-only change shows envFlags.K with readable tokens before/after", () => {
    const a = buildConfigSnapshot(git());
    const b = buildConfigSnapshot(git({ envMeta: { A: { multiline: true } } }));
    expect(diffSnapshots(a, b)).toEqual([{ field: "envFlags.A", kind: "added", after: "multiline" }]);
    const c = buildConfigSnapshot(git({ envMeta: { A: { multiline: true, literal: true } } }));
    expect(diffSnapshots(b, c)).toEqual([{ field: "envFlags.A", kind: "changed", before: "multiline", after: "literal+multiline" }]);
    expect(diffSnapshots(c, a)).toEqual([{ field: "envFlags.A", kind: "removed", before: "literal+multiline" }]);
  });

  it("buildEnv changes use fingerprints and the secret placeholder, never the value", () => {
    const mk = (v: string) => buildConfigSnapshot(git({ envMeta: { B: { buildTime: true } }, buildArgs: { B: v } }));
    const d = diffSnapshots(mk("one"), mk("two"));
    expect(d).toEqual([{ field: "buildEnv.B", kind: "changed", before: "•••", after: "•••" }]);
    expect(diffSnapshots(buildConfigSnapshot(git()), mk("one"))).toEqual([
      { field: "envFlags.B", kind: "added", after: "build" },
      { field: "buildEnv.B", kind: "added", after: "•••" },
    ]);
  });

  it("runtime:false reads as env.K removed plus envFlags.K added", () => {
    const a = buildConfigSnapshot(git({ env: { A: "1", K: "v" } }));
    const b = buildConfigSnapshot(git({ env: { A: "1" }, envMeta: { K: { buildTime: true, runtime: false } }, buildArgs: { K: "v" } }));
    const fields = diffSnapshots(a, b).map((c) => `${c.field}:${c.kind}`);
    expect(fields).toEqual(expect.arrayContaining(["env.K:removed", "envFlags.K:added", "buildEnv.K:added"]));
  });
});

describe("custom labels in the snapshot (D5)", () => {
  it("is absent when empty or null, so existing snapshots stay byte-identical", () => {
    const plain = JSON.stringify(buildConfigSnapshot(spec()));
    expect(JSON.stringify(buildConfigSnapshot(spec({ customLabels: null })))).toBe(plain);
    expect(JSON.stringify(buildConfigSnapshot(spec({ customLabels: {} })))).toBe(plain);
    expect(buildConfigSnapshot(spec()).snapV).toBe(2);
    expect(plain).not.toContain("customLabels");
  });

  it("stores sorted keys with value fingerprints, never raw values", () => {
    const snap = buildConfigSnapshot(spec({ customLabels: { z: "tok_SECRETVALUE", a: "1" } }));
    expect(Object.keys(snap.customLabels ?? {})).toEqual(["a", "z"]);
    expect(snap.customLabels?.z).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(snap)).not.toContain("SECRETVALUE");
    expect(snap.snapV).toBe(2);
  });

  it("diffs add / remove / change with the secret placeholder", () => {
    const mk = (l?: Record<string, string>) => buildConfigSnapshot(spec({ customLabels: l }));
    expect(diffSnapshots(mk(), mk({ team: "core" }))).toEqual([{ field: "customLabel.team", kind: "added", after: "•••" }]);
    expect(diffSnapshots(mk({ team: "core" }), mk())).toEqual([{ field: "customLabel.team", kind: "removed", before: "•••" }]);
    expect(diffSnapshots(mk({ team: "core" }), mk({ team: "edge" }))).toEqual([
      { field: "customLabel.team", kind: "changed", before: "•••", after: "•••" },
    ]);
    expect(diffSnapshots(mk({ team: "core" }), mk({ team: "core" }))).toEqual([]);
  });
});
