import { foreignAppToCreateInput, foreignAppToIngressPlan, foreignAppToPostCreateConfig, foreignAppToVolumes } from "./apply-map";
import { CreateAppSchema, SetVolumesSchema } from "../applications/dto";
import type { ForeignApp, ForeignVolume } from "./foreign-fleet";

const base = (over: Partial<ForeignApp>): ForeignApp => ({ sourceRef: "a", name: "app", kind: "git", buildPack: "nixpacks", ...over });
const vol = (over: Partial<ForeignVolume>): ForeignVolume => ({ mountPath: "/data", type: "named", ...over });
const appWith = (volumes: ForeignVolume[], over: Partial<ForeignApp> = {}): ForeignApp => base({ kind: "git", buildPack: "nixpacks", git: { url: "g" }, volumes, ...over });
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;

describe("foreignAppToCreateInput", () => {
  it("maps a git app (buildType, repo, server, env, deploy:false, imported tag)", () => {
    const input = foreignAppToCreateInput(
      base({ name: "web", kind: "git", buildPack: "nixpacks", git: { url: "https://git/x", branch: "main" }, ports: [3000], domains: [{ host: "a.com", https: true, primary: true }] }),
      { KEY: "val" },
      { serverId: "t-srv", environmentId: "env1", sourceTag: "coolify" },
    );
    expect(input).toMatchObject({
      name: "web",
      serverId: "t-srv",
      environmentId: "env1",
      source: "GIT",
      buildType: "NIXPACKS",
      gitUrl: "https://git/x",
      gitBranch: "main",
      env: { KEY: "val" },
      deploy: false,
      tags: ["imported", "coolify"],
      containerPort: 3000,
      domain: "a.com",
      https: true,
      exposeMode: "custom",
    });
    expect(input.image).toBeUndefined();
    expect(input.composeFile).toBeUndefined();
  });

  it("maps an image app and uses exposeMode none when there is no domain", () => {
    const input = foreignAppToCreateInput(base({ kind: "image", buildPack: "image", image: "redis:7" }), {}, { serverId: "t-srv" });
    expect(input).toMatchObject({ source: "IMAGE", image: "redis:7", exposeMode: "none", tags: ["imported"] });
    expect(input.gitUrl).toBeUndefined();
    expect(input.domain).toBeUndefined();
  });

  it("maps a compose app carrying its compose file (when resolved)", () => {
    const input = foreignAppToCreateInput(base({ kind: "compose", buildPack: "dockercompose", composeFile: "services: {}" }), {}, { serverId: "t-srv" });
    expect(input).toMatchObject({ source: "COMPOSE", composeFile: "services: {}" });
  });

  it("maps a git-sourced compose to COMPOSE + gitUrl + composePath (no baseDirectory, no composeFile) and links gitSourceId", () => {
    const input = foreignAppToCreateInput(
      base({ kind: "compose", buildPack: "dockercompose", git: { url: "https://github.com/acme/playtolk.git", branch: "main", composePath: "./docker-compose.prod.yml", provider: "github" } }),
      {},
      { serverId: "t-srv", gitSourceId: "gs-1" },
    );
    expect(input).toMatchObject({ source: "COMPOSE", gitUrl: "https://github.com/acme/playtolk.git", gitBranch: "main", composePath: "docker-compose.prod.yml", gitSourceId: "gs-1" });
    expect(input.composeFile).toBeUndefined();
    expect(input.baseDirectory).toBeUndefined();
    expect(CreateAppSchema.safeParse(input).success).toBe(true); // satisfies the dto refine (composePath only for COMPOSE+gitUrl, never both)
  });

  it("a compose with a stored composeFile never also gets a git source (dto: never both)", () => {
    const input = foreignAppToCreateInput(base({ kind: "compose", buildPack: "dockercompose", composeFile: "services: {}", git: { url: "https://x/y.git", composePath: "c.yml" } }), {}, { serverId: "t-srv", gitSourceId: "gs-1" });
    expect(input.composeFile).toBe("services: {}");
    expect(input.gitUrl).toBeUndefined();
    expect(input.composePath).toBeUndefined();
    expect(input.gitSourceId).toBeUndefined();
  });

  it("coerces empty-string optional fields to undefined (Coolify stores '') so the schema accepts them", () => {
    const input = foreignAppToCreateInput(
      base({ kind: "git", buildPack: "nixpacks", git: { url: "g" }, buildCommand: "", publishDirectory: "" }),
      {},
      { serverId: "t-srv" },
    );
    expect(input.buildCommand).toBeUndefined();
    expect(input.outputDir).toBeUndefined();
  });

  it("carries a static build's output directory + dockerfile path, normalized to Tugra's relative form", () => {
    const input = foreignAppToCreateInput(
      base({ kind: "git", buildPack: "static", git: { url: "g", dockerfilePath: "/Dockerfile" }, publishDirectory: "/dist" }),
      {},
      { serverId: "t-srv" },
    );
    // Coolify stores these absolute (leading slash); the importer strips it so the stored value matches a
    // manual create (REPO_PATH is relative-only, and the importer bypasses that DTO).
    expect(input).toMatchObject({ source: "GIT", buildType: "STATIC", outputDir: "dist", dockerfilePath: "Dockerfile" });
  });

  it("wires + normalizes the monorepo base directory (was dropped before), and treats the repo root as none", () => {
    const sub = foreignAppToCreateInput(
      base({ kind: "git", buildPack: "nixpacks", git: { url: "g", baseDirectory: "/apps/api/" } }),
      {},
      { serverId: "t-srv" },
    );
    expect(sub.baseDirectory).toBe("apps/api");
    // Coolify's default base_directory is "/" (repo root) → Tugra represents that as no base directory.
    for (const root of ["/", "", "."]) {
      const r = foreignAppToCreateInput(base({ kind: "git", buildPack: "nixpacks", git: { url: "g", baseDirectory: root } }), {}, { serverId: "t-srv" });
      expect(r.baseDirectory).toBeUndefined();
    }
  });

  it("links a git import to a resolved GitSource when opts.gitSourceId is given, and omits it otherwise", () => {
    const withLink = foreignAppToCreateInput(
      base({ kind: "git", buildPack: "nixpacks", git: { url: "https://github.com/o/r.git", provider: "github" } }),
      {},
      { serverId: "t-srv", gitSourceId: "gs-1" },
    );
    expect(withLink.gitSourceId).toBe("gs-1");
    const noLink = foreignAppToCreateInput(base({ kind: "git", buildPack: "nixpacks", git: { url: "https://github.com/o/r.git" } }), {}, { serverId: "t-srv" });
    expect(noLink.gitSourceId).toBeUndefined();
  });

  it("never attaches gitSourceId to a non-git import", () => {
    const img = foreignAppToCreateInput(base({ kind: "image", buildPack: "image", image: "redis:7" }), {}, { serverId: "t-srv", gitSourceId: "gs-1" });
    expect(img.gitSourceId).toBeUndefined();
  });
});

describe("foreignAppToVolumes", () => {
  it("maps a named volume to an empty AppVolume, deriving the name from the path (source name ignored)", () => {
    const m = foreignAppToVolumes(appWith([vol({ name: "7f3e_Data", mountPath: "/data", type: "named" })]));
    expect(m.volumes).toEqual([{ name: "data", path: "/data" }]);
    expect(m.skipped).toEqual([]);
  });

  it("maps a bind mount to an empty named volume at the same container path, never reflecting the source host path", () => {
    const m = foreignAppToVolumes(appWith([vol({ hostPath: "/srv/media", mountPath: "/media", type: "bind" })]));
    expect(m.volumes).toEqual([{ name: "media", path: "/media" }]);
    expect(JSON.stringify(m)).not.toContain("srv"); // the source host path must not leak into the mapping
  });

  it("skips empty / root mount paths as no-mount-path", () => {
    const m = foreignAppToVolumes(appWith([vol({ mountPath: "" }), vol({ mountPath: "/" }), vol({ mountPath: "//" })]));
    expect(m.volumes).toEqual([]);
    expect(m.skipped.map((s) => s.reason)).toEqual(["no-mount-path", "no-mount-path", "no-mount-path"]);
  });

  it("skips paths that break the deploy-shell grammar as invalid-path", () => {
    const bad = ["/a/../etc", "/x y", "/x;rm", "/x:ro", "/x,y", "/x=y", "/x$HOME", "/.", `/${"a".repeat(600)}`];
    const m = foreignAppToVolumes(appWith(bad.map((p) => vol({ mountPath: p }))));
    expect(m.volumes).toEqual([]);
    expect(m.skipped).toHaveLength(bad.length);
    expect(m.skipped.every((s) => s.reason === "invalid-path")).toBe(true);
  });

  it("dedupes mounts that canonicalize to the same path (first wins)", () => {
    const m = foreignAppToVolumes(appWith([vol({ mountPath: "/data" }), vol({ mountPath: "/data/" }), vol({ mountPath: "/data//" })]));
    expect(m.volumes).toEqual([{ name: "data", path: "/data" }]);
    expect(m.skipped.map((s) => s.reason)).toEqual(["duplicate-path", "duplicate-path"]);
  });

  it("resolves name collisions between distinct paths that slug the same", () => {
    const m = foreignAppToVolumes(appWith([vol({ mountPath: "/a/b" }), vol({ mountPath: "/a-b" })]));
    expect(m.volumes.map((v) => v.name).sort()).toEqual(["a-b", "a-b-2"]);
    expect(new Set(m.volumes.map((v) => v.name)).size).toBe(2); // unique
    expect(m.volumes.map((v) => v.path).sort()).toEqual(["/a-b", "/a/b"]);
  });

  it("caps at 20 volumes and reports the rest as over-limit", () => {
    const m = foreignAppToVolumes(appWith(Array.from({ length: 25 }, (_, i) => vol({ mountPath: `/m${i}` }))));
    expect(m.volumes).toHaveLength(20);
    expect(m.skipped.filter((s) => s.reason === "over-limit")).toHaveLength(5);
  });

  it("skips file mounts (config-file content is out of scope)", () => {
    const m = foreignAppToVolumes(appWith([vol({ mountPath: "/etc/app.conf", type: "file" }), vol({ mountPath: "/data", type: "named" })]));
    expect(m.volumes).toEqual([{ name: "data", path: "/data" }]);
    expect(m.skipped).toEqual([{ mountPath: "/etc/app.conf", reason: "file-mount" }]);
  });

  it("declares nothing for a compose app (its volumes live in the compose file)", () => {
    const m = foreignAppToVolumes(appWith([vol({ mountPath: "/data" }), vol({ mountPath: "/x" })], { kind: "compose", buildPack: "dockercompose", composeFile: "services: {}" }));
    expect(m.volumes).toEqual([]);
    expect(m.skipped.map((s) => s.reason)).toEqual(["compose-managed", "compose-managed"]);
  });

  it("returns empty for an app with no volumes (undefined or [])", () => {
    expect(foreignAppToVolumes(appWith([]))).toEqual({ volumes: [], skipped: [] });
    expect(foreignAppToVolumes(base({ git: { url: "g" } }))).toEqual({ volumes: [], skipped: [] });
  });

  it("is deterministic and independent of discovery order", () => {
    const vols = [vol({ mountPath: "/c" }), vol({ mountPath: "/a" }), vol({ mountPath: "/b" })];
    const forward = foreignAppToVolumes(appWith([...vols]));
    const reversed = foreignAppToVolumes(appWith([...vols].reverse()));
    expect(forward).toEqual(reversed);
    expect(forward.volumes.map((v) => v.path)).toEqual(["/a", "/b", "/c"]);
  });

  it("truncates a long slug to a schema-valid name", () => {
    const longPath = `/${"abcdefghij".repeat(6)}`; // 61-char path, well under the 512 limit
    const m = foreignAppToVolumes(appWith([vol({ mountPath: longPath })]));
    expect(m.volumes).toHaveLength(1);
    expect(m.volumes[0].name.length).toBeLessThanOrEqual(41);
    expect(NAME_RE.test(m.volumes[0].name)).toBe(true);
  });

  it("every produced volume satisfies SetVolumesSchema and the name regex (property check)", () => {
    const fixtures: ForeignApp[] = [
      appWith([vol({ name: "7f3e_Data", mountPath: "/data" }), vol({ hostPath: "/srv/x", mountPath: "/media", type: "bind" })]),
      appWith([vol({ mountPath: "/a/b" }), vol({ mountPath: "/a-b" })]),
      appWith(Array.from({ length: 25 }, (_, i) => vol({ mountPath: `/m${i}` }))),
      appWith([vol({ mountPath: `/${"abcdefghij".repeat(6)}` })]),
    ];
    for (const app of fixtures) {
      const { volumes } = foreignAppToVolumes(app);
      expect(SetVolumesSchema.safeParse({ volumes }).success).toBe(true);
      for (const v of volumes) expect(NAME_RE.test(v.name)).toBe(true);
    }
  });
});

describe("foreignAppToPostCreateConfig", () => {
  it("is empty for an app with none of the L1 fields", () => {
    expect(foreignAppToPostCreateConfig(base({}))).toEqual({ unmapped: [] });
  });

  it("carries autoDeploy, watchPaths, limits, exec-form command to their setter inputs", () => {
    const cfg = foreignAppToPostCreateConfig(
      base({
        autoDeploy: false,
        watchPaths: ["src/**", "!docs/**"],
        limits: { memoryMb: 512, cpus: 1.5, reserveMemoryMb: 256, reserveCpus: 0.5 },
        containerEntrypoint: ["node"],
        containerCommand: ["server.js", "--port=3000"],
        replicas: 3,
      }),
    );
    expect(cfg.autoDeploy).toBe(false);
    expect(cfg.watchPaths).toEqual(["src/**", "!docs/**"]);
    expect(cfg.limits).toEqual({ memoryMb: 512, cpus: 1.5, reserveMemoryMb: 256, reserveCpus: 0.5 });
    expect(cfg.containerCommand).toEqual({ containerEntrypoint: ["node"], containerCommand: ["server.js", "--port=3000"] });
    expect(cfg.replicas).toBe(3);
    expect(cfg.unmapped).toEqual([]);
  });

  it("a Dockerfile build target becomes a schema-valid setBuild input carrying the create-time build fields", () => {
    const cfg = foreignAppToPostCreateConfig(base({ buildPack: "dockerfile", dockerBuildTarget: "prod", git: { url: "g", dockerfilePath: "/docker/Dockerfile", baseDirectory: "/apps/api" } }));
    expect(cfg.build).toEqual({ buildType: "DOCKERFILE", dockerfilePath: "docker/Dockerfile", dockerBuildTarget: "prod", baseDirectory: "apps/api" });
    // a target on a non-Dockerfile build is reported, not applied
    const nix = foreignAppToPostCreateConfig(base({ buildPack: "nixpacks", dockerBuildTarget: "prod" }));
    expect(nix.build).toBeUndefined();
    expect(nix.unmapped.map((u) => u.field)).toEqual(["dockerBuildTarget"]);
  });

  it("a tag trigger turns auto-deploy OFF (never push-to-deploy by accident) and is reported", () => {
    const cfg = foreignAppToPostCreateConfig(base({ autoDeploy: true, triggerType: "tag" }));
    expect(cfg.autoDeploy).toBe(false);
    expect(cfg.unmapped.map((u) => u.field)).toEqual(["triggerType"]);
    expect(foreignAppToPostCreateConfig(base({ autoDeploy: true, triggerType: "push" })).autoDeploy).toBe(true);
  });

  it("reports (never silently drops) invalid watch paths / out-of-range limits / no-target fields", () => {
    const cfg = foreignAppToPostCreateConfig(base({ watchPaths: ["has space"], limits: { memoryMb: 4 }, dockerContextPath: "./svc", staticSpa: false }));
    expect(cfg.watchPaths).toBeUndefined();
    expect(cfg.limits).toBeUndefined();
    expect(cfg.unmapped.map((u) => u.field).sort()).toEqual(["dockerContextPath", "limits", "staticSpa", "watchPaths"]);
  });

  it("does not apply a container command to a compose app (its YAML owns it)", () => {
    const cfg = foreignAppToPostCreateConfig(base({ kind: "compose", buildPack: "dockercompose", containerCommand: ["x"] }));
    expect(cfg.containerCommand).toBeUndefined();
    expect(cfg.unmapped.map((u) => u.field)).toEqual(["containerCommand"]);
  });
});

describe("foreignAppToIngressPlan", () => {
  const d = (host: string, over: Partial<NonNullable<ForeignApp["domains"]>[number]> = {}) => ({ host, https: true, port: 3000, certType: "le-http" as const, ...over });

  it("is empty for an app with no domains / ports", () => {
    expect(foreignAppToIngressPlan(base({}))).toEqual({ extraDomains: [], serviceDomains: [], extraPorts: [], unmapped: [] });
    expect(foreignAppToIngressPlan(base({ domains: [d("a.com", { primary: true })], ports: [3000] }))).toEqual({ extraDomains: [], serviceDomains: [], extraPorts: [], unmapped: [] });
  });

  it("a classic multi-domain app carries every non-primary host as an extra domain (normalized, deduped)", () => {
    const plan = foreignAppToIngressPlan(base({ ports: [3000], domains: [d("a.com", { primary: true }), d("B.Example.com"), d("b.example.com"), d("c.example.com")] }));
    expect(plan).toEqual({ extraDomains: ["b.example.com", "c.example.com"], serviceDomains: [], extraPorts: [], unmapped: [] });
  });

  it("never re-adds the primary's www/bare counterpart (Tugra serves it, the setter rejects it) — reported", () => {
    const plan = foreignAppToIngressPlan(base({ domains: [d("a.com", { primary: true }), d("www.a.com")] }));
    expect(plan.extraDomains).toEqual([]);
    expect(plan.unmapped.map((u) => u.field)).toEqual(["domain:www.a.com alias"]);
  });

  it("a compose app routes serviceRef domains to per-service domains; the rest become extra domains", () => {
    const plan = foreignAppToIngressPlan(
      base({
        kind: "compose",
        buildPack: "dockercompose",
        domains: [d("a.com", { primary: true, serviceRef: "web", port: 80 }), d("api.a.com", { serviceRef: "api", port: 8080 }), d("misc.a.com")],
      }),
    );
    expect(plan.serviceDomains).toEqual([{ service: "api", hostname: "api.a.com", port: 8080 }]);
    expect(plan.extraDomains).toEqual(["misc.a.com"]);
    // the compose primary keeps create-time (inferred web service) routing — reported, not dropped
    expect(plan.unmapped.map((u) => u.field)).toEqual(["domain:a.com serviceRef"]);
  });

  it("a service domain with no routing port or with a path is reported, not applied", () => {
    const plan = foreignAppToIngressPlan(
      base({ kind: "compose", buildPack: "dockercompose", domains: [d("a.com", { primary: true }), d("x.a.com", { serviceRef: "x", port: undefined }), d("y.a.com", { serviceRef: "y", port: 81, path: "/p" })] }),
    );
    expect(plan.serviceDomains).toEqual([]);
    expect(plan.unmapped.map((u) => u.field).sort()).toEqual(["domain:x.a.com port", "domain:y.a.com path"]);
  });

  it("the primary domain's path becomes pathPrefix + stripPrefix (strip is FALSE when the source is silent — Dokploy strips only when set — and honors stripPath)", () => {
    expect(foreignAppToIngressPlan(base({ domains: [d("a.com", { primary: true, path: "/api/" })] })).domainOptions).toEqual({ pathPrefix: "/api", stripPrefix: false });
    expect(foreignAppToIngressPlan(base({ domains: [d("a.com", { primary: true, path: "/v1", stripPath: true })] })).domainOptions).toEqual({ pathPrefix: "/v1", stripPrefix: true });
    expect(foreignAppToIngressPlan(base({ domains: [d("a.com", { primary: true, path: "/v1", stripPath: false })] })).domainOptions).toEqual({ pathPrefix: "/v1", stripPrefix: false });
    const bad = foreignAppToIngressPlan(base({ domains: [d("a.com", { primary: true, path: "/has space" })] }));
    expect(bad.domainOptions).toBeUndefined();
    expect(bad.unmapped.map((u) => u.field)).toEqual(["domain:a.com path"]);
  });

  it("an alias on a different port or path than the primary is reported (Tugra has one port + an app-wide path)", () => {
    const plan = foreignAppToIngressPlan(base({ ports: [3000], domains: [d("a.com", { primary: true }), d("p.a.com", { port: 9000 }), d("q.a.com", { path: "/q" }), d("ok.a.com")] }));
    expect(plan.extraDomains).toEqual(["ok.a.com"]);
    expect(plan.unmapped.map((u) => u.field).sort()).toEqual(["domain:p.a.com port", "domain:q.a.com path"]);
  });

  it("publishedPorts become extraPorts minus the HTTP ingress port (reported); a domain-less app keeps all of them", () => {
    const pub = [
      { hostPort: 8080, containerPort: 3000, protocol: "tcp" as const },
      { hostPort: 2222, containerPort: 22, protocol: "tcp" as const },
      { hostPort: 5353, containerPort: 53, protocol: "udp" as const },
    ];
    const withDomain = foreignAppToIngressPlan(base({ ports: [3000], domains: [d("a.com", { primary: true })], publishedPorts: pub }));
    expect(withDomain).toEqual({
      extraDomains: [],
      serviceDomains: [],
      extraPorts: [pub[1], pub[2]],
      unmapped: [{ field: "port:8080/tcp", reason: expect.stringContaining("HTTP ingress port") }],
    });
    const noDomain = foreignAppToIngressPlan(base({ ports: [3000], publishedPorts: pub }));
    expect(noDomain.extraPorts).toEqual(pub);
  });

  it("a compose app's published ports are reported (declared in its compose file)", () => {
    const plan = foreignAppToIngressPlan(base({ kind: "compose", buildPack: "dockercompose", publishedPorts: [{ hostPort: 1, containerPort: 2, protocol: "tcp" }] }));
    expect(plan.extraPorts).toEqual([]);
    expect(plan.unmapped.map((u) => u.field)).toEqual(["ports"]);
  });

  it("reports le-dns / custom-cert / https-off / redirect / non-compose serviceRef honestly (carry, never drop)", () => {
    const plan = foreignAppToIngressPlan(
      base({
        ports: [3000],
        domains: [d("a.com", { primary: true, certType: "le-dns" }), d("b.com", { certType: "custom" }), d("c.com", { https: false, certType: "none" }), d("e.com", { redirectTo: "a.com" }), d("f.com", { serviceRef: "svc" })],
      }),
    );
    expect(plan.unmapped.map((u) => u.field).sort()).toEqual(
      ["domain:a.com dns-01", "domain:b.com custom-cert", "domain:c.com https", "domain:e.com redirect", "domain:f.com serviceRef"].sort(),
    );
    // the hosts themselves are still carried as aliases where Tugra can route them
    expect(plan.extraDomains).toEqual(["b.com", "c.com", "e.com", "f.com"]);
  });

  it("corrects the container port when the primary's routing port differs from the create-time guess (classic only)", () => {
    expect(foreignAppToIngressPlan(base({ ports: [8080], domains: [d("a.com", { primary: true, port: 3000 })] })).containerPort).toBe(3000);
    expect(foreignAppToIngressPlan(base({ ports: [3000], domains: [d("a.com", { primary: true, port: 3000 })] })).containerPort).toBeUndefined();
    expect(foreignAppToIngressPlan(base({ kind: "compose", buildPack: "dockercompose", ports: [8080], domains: [d("a.com", { primary: true, port: 3000 })] })).containerPort).toBeUndefined();
  });

  it("enforces Tugra's caps (10 extra domains, 20 extra ports) by reporting the overflow", () => {
    const many = Array.from({ length: 12 }, (_, i) => d(`h${i}.a.com`));
    const plan = foreignAppToIngressPlan(base({ domains: [d("a.com", { primary: true }), ...many] }));
    expect(plan.extraDomains).toHaveLength(10);
    expect(plan.unmapped.filter((u) => u.field.endsWith(" limit"))).toHaveLength(2);
    const ports = Array.from({ length: 22 }, (_, i) => ({ hostPort: 3000 + i, containerPort: 4000 + i, protocol: "tcp" as const }));
    const pp = foreignAppToIngressPlan(base({ publishedPorts: ports }));
    expect(pp.extraPorts).toHaveLength(20);
    expect(pp.unmapped).toHaveLength(2);
  });

  it("a UDP mapping on the same container number as the TCP ingress port is CARRIED (HTTP ingress is TCP only)", () => {
    const plan = foreignAppToIngressPlan(base({ ports: [3000], domains: [d("a.com", { primary: true })], publishedPorts: [{ hostPort: 3000, containerPort: 3000, protocol: "udp" }, { hostPort: 8080, containerPort: 3000, protocol: "tcp" }] }));
    expect(plan.extraPorts).toEqual([{ hostPort: 3000, containerPort: 3000, protocol: "udp" }]);
    expect(plan.unmapped.map((u) => u.field)).toEqual(["port:8080/tcp"]);
  });

  it("a second row for the same host with a different path/port is REPORTED (dup), a true duplicate is dropped silently", () => {
    const plan = foreignAppToIngressPlan(
      base({
        ports: [3000],
        domains: [d("a.com", { primary: true }), d("x.a.com"), d("X.a.com"), d("x.a.com", { port: 9000 }), d("x.a.com", { path: "/p" }), d("a.com", { path: "/other" })],
      }),
    );
    expect(plan.extraDomains).toEqual(["x.a.com"]);
    expect(plan.unmapped.map((u) => u.field)).toEqual(["domain:x.a.com dup", "domain:x.a.com dup", "domain:a.com dup"]);
    expect(plan.unmapped[0].reason).toMatch(/different path\/port\/service/);
  });

  it("redirects pass through to the plan (validated, capped at 20); an invalid rule is reported and does not cost the valid ones", () => {
    const r = { regex: "^http://a/(.*)", replacement: "https://a/$1", permanent: true };
    expect(foreignAppToIngressPlan(base({ redirects: [r] }))).toEqual({ extraDomains: [], serviceDomains: [], extraPorts: [], redirects: [r], unmapped: [] });
    const mixed = foreignAppToIngressPlan(base({ redirects: [r, { regex: "multi\nline", replacement: "x", permanent: false }] }));
    expect(mixed.redirects).toEqual([r]);
    expect(mixed.unmapped.map((u) => u.field)).toEqual(["redirects"]);
    const many = foreignAppToIngressPlan(base({ redirects: Array.from({ length: 22 }, (_, i) => ({ ...r, regex: `^/${i}` })) }));
    expect(many.redirects).toHaveLength(20);
    expect(many.unmapped.map((u) => u.field)).toEqual(["redirects limit"]);
    expect(foreignAppToIngressPlan(base({})).redirects).toBeUndefined();
  });

  it("bounds a source-supplied host interpolated into a persisted unmapped field/reason to 200 chars", () => {
    const long = `${"h".repeat(300)}.example.com`;
    const plan = foreignAppToIngressPlan(base({ domains: [d("a.com", { primary: true }), d(long, { certType: "custom" })] }));
    const u = plan.unmapped.find((x) => x.field.endsWith("custom-cert"))!;
    expect(u.field.length).toBeLessThanOrEqual("domain: custom-cert".length + 200);
  });
});
