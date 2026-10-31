import { foreignAppToCreateInput } from "./apply-map";
import type { ForeignApp } from "./foreign-fleet";

const base = (over: Partial<ForeignApp>): ForeignApp => ({ sourceRef: "a", name: "app", kind: "git", buildPack: "nixpacks", ...over });

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
