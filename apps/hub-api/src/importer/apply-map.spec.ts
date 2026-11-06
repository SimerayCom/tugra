import { foreignAppToCreateInput, foreignAppToVolumes } from "./apply-map";
import { SetVolumesSchema } from "../applications/dto";
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
