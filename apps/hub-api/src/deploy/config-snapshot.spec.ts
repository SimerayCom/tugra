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
