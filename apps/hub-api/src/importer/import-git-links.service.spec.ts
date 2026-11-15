import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { ImportGitLinksService } from "./import-git-links.service";
import type { GitLinkRow } from "./git-link-resolver.service";
import type { ForeignApp } from "./foreign-fleet";

const row = (over: Partial<GitLinkRow> = {}): GitLinkRow => ({ itemRef: "app:s1:a1", name: "web", repo: { host: "github.com", owner: "o", name: "r" }, status: "linked", sourceId: "gs-1", sourceName: "Acme", reason: "r", ...over });
const fleetApp = (ref: string): ForeignApp => ({ sourceRef: ref, name: `app-${ref}`, kind: "git", buildPack: "nixpacks", serverRef: "s1", git: { url: `https://github.com/o/${ref}.git` } });

function make(over: { resolveRows?: Map<string, GitLinkRow>; resolveReposRows?: Map<string, GitLinkRow>; op?: unknown; apps?: Array<Record<string, unknown>>; setSource?: jest.Mock; denyPerm?: boolean } = {}) {
  const prisma = {
    server: { findUnique: jest.fn().mockResolvedValue({ id: "srv-t", teamId: "team-1" }) },
    bulkOperation: {
      findUnique: jest.fn().mockResolvedValue(
        over.op === undefined
          ? { id: "op-1", kind: "import", actorId: "u1", meta: { serverId: "srv-t" }, tasks: [
              { kind: "app", status: "DONE", resourceType: "application", resourceId: "ap1", itemRef: "app:s1:a1" },
              { kind: "app", status: "DONE", resourceType: "application", resourceId: "ap2", itemRef: "app:s1:a2" },
              { kind: "app", status: "FAILED", resourceType: null, resourceId: null, itemRef: "app:s1:a3" },
              { kind: "database", status: "DONE", resourceType: "database", resourceId: "db1", itemRef: "database:s1:d1" },
            ] }
          : over.op,
      ),
    },
    application: { findMany: jest.fn().mockResolvedValue(over.apps ?? [
      { id: "ap1", name: "web", gitUrl: "https://github.com/o/a1.git", gitSourceId: null },
      { id: "ap2", name: "api", gitUrl: "https://github.com/o/a2.git", gitSourceId: "already" },
    ]) },
  };
  const access = { requirePermission: jest.fn().mockImplementation(async () => { if (over.denyPerm) throw new ForbiddenException("no"); }) };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const fleet = { apps: [fleetApp("a1"), fleetApp("a2"), fleetApp("a3")] };
  const source = { discover: jest.fn().mockResolvedValue(fleet), close: jest.fn().mockResolvedValue(undefined) };
  const importer = { openSession: jest.fn().mockResolvedValue({ source }) };
  const resolver = {
    resolve: jest.fn().mockResolvedValue(over.resolveRows ?? new Map([["a1", row()], ["a3", row({ itemRef: "app:s1:a3", name: "app-a3", status: "needs_source", sourceId: undefined, sourceName: undefined })]])),
    resolveRepos: jest.fn().mockResolvedValue(over.resolveReposRows ?? new Map([["ap1", row()]])),
  };
  const apps = { setSource: over.setSource ?? jest.fn().mockResolvedValue({ warnings: [] }) };
  const svc = new ImportGitLinksService(prisma as never, access as never, audit as never, importer as never, resolver as never, apps as never);
  return { svc, prisma, access, audit, importer, source, resolver, apps };
}

describe("ImportGitLinksService.list", () => {
  it("authorizes the session and the TARGET server's team, resolves against that team and returns rows in fleet order + owner groups", async () => {
    const h = make();
    const out = await h.svc.list("u1", { sessionId: "s", targetServerId: "srv-t" });
    expect(h.importer.openSession).toHaveBeenCalledWith("u1", "s");
    expect(h.access.requirePermission).toHaveBeenCalledWith("u1", "team-1", "apps:config");
    expect(h.resolver.resolve).toHaveBeenCalledWith("team-1", expect.any(Array));
    expect(out.rows.map((r) => r.itemRef)).toEqual(["app:s1:a1", "app:s1:a3"]);
    expect(out.groups).toEqual([
      { host: "github.com", owner: "o", apps: 1, status: "linked", sourceName: "Acme" },
      { host: "github.com", owner: "o", apps: 1, status: "needs_source" },
    ]);
    expect(h.source.close).toHaveBeenCalled();
  });

  it("an unknown target server is 404 and the source is still closed; no credential field in the response", async () => {
    const h = make();
    h.prisma.server.findUnique.mockResolvedValue(null);
    await expect(h.svc.list("u1", { sessionId: "s", targetServerId: "nope" })).rejects.toBeInstanceOf(NotFoundException);
    expect(h.source.close).toHaveBeenCalled();
    const ok = await make().svc.list("u1", { sessionId: "s", targetServerId: "srv-t" });
    expect(JSON.stringify(ok)).not.toMatch(/token|secret|privateKey/i);
  });

  it("denied on the target team => 403 before any discover", async () => {
    const h = make({ denyPerm: true });
    await expect(h.svc.list("u1", { sessionId: "s", targetServerId: "srv-t" })).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.source.discover).not.toHaveBeenCalled();
  });
});

describe("ImportGitLinksService.relink", () => {
  it("re-resolves ONLY the DONE app tasks that are still unlinked and calls setSource with the gitSourceId only", async () => {
    const h = make();
    const out = await h.svc.relink("u1", "op-1", {});
    // ap2 is already linked, a3 failed, the database task is not an app: only ap1 is resolved
    expect(h.resolver.resolveRepos).toHaveBeenCalledWith("team-1", [{ key: "ap1", itemRef: "app:s1:a1", name: "web", url: "https://github.com/o/a1.git" }]);
    expect(h.apps.setSource).toHaveBeenCalledTimes(1);
    expect(h.apps.setSource).toHaveBeenCalledWith("u1", "ap1", { gitSourceId: "gs-1" });
    expect(out.linked).toBe(1);
    expect(out.results).toEqual(expect.arrayContaining([
      { itemRef: "app:s1:a2", name: "api", outcome: "already_linked", status: "linked" },
      { itemRef: "app:s1:a1", name: "web", outcome: "linked", status: "linked", sourceName: "Acme" },
    ]));
    expect(h.audit.log).toHaveBeenCalledWith({ actor: "u1", action: "import.git_relink", target: "op-1", meta: { candidates: 1, linked: 1, failed: 0 } });
  });

  it("an ssh repo a connected installation now covers is linked AND switched to its https twin in the same setSource call", async () => {
    const h = make({ resolveReposRows: new Map([["ap1", row({ rewriteUrl: "https://github.com/o/a1.git" })]]), apps: [{ id: "ap1", name: "web", gitUrl: "git@github.com:o/a1.git", gitSourceId: null }] });
    await h.svc.relink("u1", "op-1", {});
    expect(h.apps.setSource).toHaveBeenCalledWith("u1", "ap1", { gitSourceId: "gs-1", gitUrl: "https://github.com/o/a1.git" });
  });

  it("an ambiguous row is linked ONLY with an explicit choice that is one of its candidates", async () => {
    const amb = row({ status: "ambiguous", sourceId: undefined, sourceName: undefined, candidates: [{ id: "g1", name: "One" }, { id: "g2", name: "Two" }] });
    const h = make({ resolveReposRows: new Map([["ap1", amb]]) });
    const none = await h.svc.relink("u1", "op-1", {});
    expect(h.apps.setSource).not.toHaveBeenCalled();
    expect(none.results.find((r) => r.itemRef === "app:s1:a1")).toMatchObject({ outcome: "not_linked", status: "ambiguous" });
    const bad = await h.svc.relink("u1", "op-1", { choices: { "app:s1:a1": "g-evil" } });
    expect(h.apps.setSource).not.toHaveBeenCalled();
    expect(bad.results.find((r) => r.itemRef === "app:s1:a1")).toMatchObject({ outcome: "invalid_choice" });
    const good = await h.svc.relink("u1", "op-1", { choices: { "app:s1:a1": "g2" } });
    expect(h.apps.setSource).toHaveBeenCalledWith("u1", "ap1", { gitSourceId: "g2" });
    expect(good.results.find((r) => r.itemRef === "app:s1:a1")).toMatchObject({ outcome: "linked", sourceName: "Two" });
  });

  it("a choice never overrides a non-ambiguous status (needs_source stays unlinked)", async () => {
    const h = make({ resolveReposRows: new Map([["ap1", row({ status: "needs_source", sourceId: undefined, sourceName: undefined })]]) });
    await h.svc.relink("u1", "op-1", { choices: { "app:s1:a1": "gs-x" } });
    expect(h.apps.setSource).not.toHaveBeenCalled();
  });

  it("a setSource failure (its own team/host checks) is reported per app and never throws; the other apps still run", async () => {
    const h = make({ setSource: jest.fn().mockRejectedValue(new Error("git source not found in this team")) });
    const out = await h.svc.relink("u1", "op-1", {});
    expect(out.linked).toBe(0);
    expect(out.results.find((r) => r.itemRef === "app:s1:a1")).toMatchObject({ outcome: "failed" });
    expect(JSON.stringify(out)).not.toContain("not found in this team"); // upstream text is never echoed
    expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({ meta: { candidates: 1, linked: 0, failed: 1 } }));
  });

  it("only the owner may relink; the target team's apps:config is required; rolled-back / non-import ops are refused", async () => {
    await expect(make({ op: { id: "op-1", kind: "import", actorId: "someone-else", meta: { serverId: "srv-t" }, tasks: [] } }).svc.relink("u1", "op-1", {})).rejects.toBeInstanceOf(ForbiddenException);
    await expect(make({ op: { id: "op-1", kind: "bulk", actorId: "u1", meta: {}, tasks: [] } }).svc.relink("u1", "op-1", {})).rejects.toBeInstanceOf(NotFoundException);
    await expect(make({ op: null }).svc.relink("u1", "op-1", {})).rejects.toBeInstanceOf(NotFoundException);
    await expect(make({ op: { id: "op-1", kind: "import", actorId: "u1", meta: { serverId: "srv-t", rolledBackAt: "2026-11-15" }, tasks: [] } }).svc.relink("u1", "op-1", {})).rejects.toBeInstanceOf(ConflictException);
    await expect(make({ denyPerm: true }).svc.relink("u1", "op-1", {})).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("cross-team: apps are looked up scoped to the op's server team, so an app row from another team is never touched", async () => {
    const h = make();
    await h.svc.relink("u1", "op-1", {});
    expect(h.prisma.application.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ teamId: "team-1" }) }));
  });
});
