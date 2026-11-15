import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { ImporterService } from "./importer.service";
import { CoolifySource } from "./sources/coolify.source";
import type { AdoptableContainer } from "../migrator/migrator.service";

const localContainer: AdoptableContainer = {
  id: "c1",
  name: "web",
  image: "nginx:1",
  state: "running",
  ports: [{ host: 80, container: 80, protocol: "tcp" }],
  env: [{ key: "K", value: "SECRETVAL" }],
  mounts: [],
  restartPolicy: "always",
  isTugra: false,
  composeProject: null,
  adoptable: true,
};

/** A fake Coolify client whose GETs resolve from a route map (missing → throws, like a 404). */
const coolifyRoutes: Record<string, unknown> = {
  "/servers": [{ uuid: "srv-a", name: "box" }],
  "/servers/srv-a/resources": [{ uuid: "app-1" }],
  "/applications": [{ uuid: "app-1", name: "web", build_pack: "nixpacks", git_repository: "o/r" }],
  "/databases": [],
};
const makeFakeClient = () => ({
  get: jest.fn(async (p: string) => {
    if (p in coolifyRoutes) return coolifyRoutes[p];
    throw new Error(`404 ${p}`);
  }),
});

function make(over: { session?: unknown; clientGet?: jest.Mock } = {}) {
  const migrator = { discover: jest.fn().mockResolvedValue({ containers: [localContainer] }) };
  const importSession = {
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "sess-1", ...data })),
    findUnique: jest.fn().mockResolvedValue(over.session ?? null),
    update: jest.fn().mockResolvedValue({}),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
  };
  const prisma = { importSession } as never;
  const crypto = { encrypt: jest.fn((s: string) => `enc(${s})`), decrypt: jest.fn((s: string) => s.replace(/^enc\(|\)$/g, "")) };
  const access = { requirePermission: jest.fn().mockResolvedValue(undefined) };
  const audit = { log: jest.fn() };
  const client = over.clientGet ? { get: over.clientGet } : makeFakeClient();
  // The source factory builds the adapter (a CoolifySource over the fake client), mirroring ImportSourceFactory
  // so the service's real discover/verify logic still runs against the route map.
  const sources = {
    create: jest.fn((_kind: string) => new CoolifySource(client as never)),
    label: jest.fn((k: string) => (k === "coolify" ? "Coolify" : String(k))),
  };
  const svc = new ImporterService(migrator as never, prisma, crypto as never, access as never, audit as never, sources as never);
  return { svc, migrator, importSession, crypto, access, audit, sources, client };
}

describe("ImporterService.plan — local-docker", () => {
  it("discovers via local-docker and returns a secret-free plan", async () => {
    const { svc, migrator } = make();
    const plan = await svc.plan("u1", { sourceKind: "local-docker", serverId: "srv1" });
    expect(migrator.discover).toHaveBeenCalledWith("u1", "srv1");
    expect(plan.totals.apps).toBe(1);
    expect(JSON.stringify(plan)).not.toContain("SECRETVAL");
  });
});

describe("ImporterService.connect — coolify", () => {
  it("verifies, stores an ENCRYPTED session, audits without the token, returns the id", async () => {
    const { svc, importSession, crypto, access, audit } = make();
    const res = await svc.connect("u1", { sourceKind: "coolify", teamId: "t1", baseUrl: "https://coolify.example.com", token: "COOLIFY_TOKEN" });
    expect(access.requirePermission).toHaveBeenCalledWith("u1", "t1", "apps:config");
    expect(crypto.encrypt).toHaveBeenCalledWith("COOLIFY_TOKEN");
    const stored = importSession.create.mock.calls[0][0].data;
    expect(stored.tokenEnc).toBe("enc(COOLIFY_TOKEN)"); // the stored value is the crypto output, not the raw token
    expect(stored.baseUrl).toBe("https://coolify.example.com");
    expect(res.sessionId).toBe("sess-1");
    expect(JSON.stringify((audit.log as jest.Mock).mock.calls)).not.toContain("COOLIFY_TOKEN");
  });

  it("rejects when the instance is unreachable / token invalid (no session stored)", async () => {
    const { svc, importSession } = make({ clientGet: jest.fn().mockRejectedValue(new Error("401")) });
    await expect(
      svc.connect("u1", { sourceKind: "coolify", teamId: "t1", baseUrl: "https://coolify.example.com", token: "bad" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(importSession.create).not.toHaveBeenCalled();
  });

  it("rejects a non-http(s) / credential-bearing / loopback-literal base URL as a 400", async () => {
    const { svc } = make();
    for (const baseUrl of ["file:///etc/passwd", "https://user:pass@c.example.com", "http://169.254.169.254/", "http://127.0.0.1:5432/"]) {
      await expect(svc.connect("u1", { sourceKind: "coolify", teamId: "t1", baseUrl, token: "x" })).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it("forbids a caller without apps:config before any network call", async () => {
    const { svc, sources } = make();
    (svc as unknown as { access: { requirePermission: jest.Mock } }).access.requirePermission.mockRejectedValue(new ForbiddenException("no"));
    await expect(svc.connect("u1", { sourceKind: "coolify", teamId: "t1", baseUrl: "https://c.example.com", token: "x" })).rejects.toBeInstanceOf(ForbiddenException);
    expect(sources.create).not.toHaveBeenCalled();
  });
});

describe("ImporterService.plan — coolify session", () => {
  const liveSession = { id: "sess-1", sourceKind: "coolify", actorId: "u1", teamId: "t1", baseUrl: "https://c.example.com", tokenEnc: "enc(TOK)", status: "active", expiresAt: new Date(Date.now() + 60_000) };

  it("resolves the owned session, decrypts the token, discovers, and plans", async () => {
    const { svc, crypto, sources, importSession } = make({ session: liveSession });
    const plan = await svc.plan("u1", { sourceKind: "coolify", sessionId: "sess-1" });
    expect(crypto.decrypt).toHaveBeenCalledWith("enc(TOK)");
    expect(sources.create).toHaveBeenCalledWith("coolify", "https://c.example.com", "TOK");
    expect(plan.sourceKind).toBe("coolify");
    expect(plan.items.some((i) => i.itemRef === "app:srv-a:app-1")).toBe(true);
    expect(importSession.update).toHaveBeenCalled(); // lastUsedAt bumped
  });

  it("404s an unknown session, forbids another user's, rejects an expired one", async () => {
    await expect(make({ session: null }).svc.plan("u1", { sourceKind: "coolify", sessionId: "x" })).rejects.toBeInstanceOf(NotFoundException);
    await expect(make({ session: { ...liveSession, actorId: "u2" } }).svc.plan("u1", { sourceKind: "coolify", sessionId: "sess-1" })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      make({ session: { ...liveSession, expiresAt: new Date(Date.now() - 1000) } }).svc.plan("u1", { sourceKind: "coolify", sessionId: "sess-1" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("404s a session whose stored kind is not a remote source (a local-docker session can't be opened as a remote plan)", async () => {
    const { svc, sources } = make({ session: { ...liveSession, sourceKind: "local-docker" } });
    await expect(svc.plan("u1", { sourceKind: "coolify", sessionId: "sess-1" })).rejects.toBeInstanceOf(NotFoundException);
    expect(sources.create).not.toHaveBeenCalled();
  });
});

describe("ImporterService.plan — coverage (G3-C)", () => {
  const session = (kind: string) => ({ id: "sess-1", sourceKind: kind, actorId: "u1", teamId: "t1", baseUrl: "https://c.example.com", tokenEnc: "enc(TOK)", status: "active", expiresAt: new Date(Date.now() + 60_000) });
  const app = { sourceRef: "web-1", name: "web", kind: "git" as const, buildPack: "nixpacks" as const, git: { url: "https://git/x" }, serverRef: "s1", notCarried: [{ field: "registry", level: "info" as const, reason: "r" }] };
  const stubSource = () => ({
    discover: jest.fn().mockResolvedValue({ servers: [], apps: [app], databases: [], services: [], volumes: [], sharedEnv: [], warnings: [] }),
    close: jest.fn().mockResolvedValue(undefined),
  });

  it.each(["coolify", "dokploy"] as const)("a %s plan carries preflight.coverage (presence-only, per app) and the planHash ignores it", async (kind) => {
    const { svc, sources } = make({ session: session(kind) });
    (sources.create as jest.Mock).mockReturnValue(stubSource());
    const plan = await svc.plan("u1", { sourceKind: kind, sessionId: "sess-1" });
    expect(plan.preflight?.coverage).toEqual({
      apps: [{ itemRef: "app:s1:web-1", name: "web", notCarried: [{ field: "registry", reason: "r", level: "info" }] }],
      // Coolify only: the repo-shape summary (Dokploy's coverage stays byte-identical)
      ...(kind === "coolify" ? { git: { apps: 1, https: 1, ssh: 0, githubApp: 0 } } : {}),
    });
    // same fleet without notCarried → identical hash
    const { svc: svc2, sources: sources2 } = make({ session: session(kind) });
    const bare = stubSource();
    bare.discover.mockResolvedValue({ servers: [], apps: [{ ...app, notCarried: undefined }], databases: [], services: [], volumes: [], sharedEnv: [], warnings: [] });
    (sources2.create as jest.Mock).mockReturnValue(bare);
    expect((await svc2.plan("u1", { sourceKind: kind, sessionId: "sess-1" })).planHash).toBe(plan.planHash);
  });

  it("omits coverage when nothing is not carried, and for local-docker", async () => {
    const { svc, sources } = make({ session: session("coolify") });
    (sources.create as jest.Mock).mockReturnValue({ discover: jest.fn().mockResolvedValue({ servers: [], apps: [{ ...app, notCarried: undefined }], databases: [], services: [], volumes: [], sharedEnv: [], warnings: [] }), close: jest.fn() });
    // Coolify: only the repo-shape summary remains (no notCarried entries, no env report)
    expect((await svc.plan("u1", { sourceKind: "coolify", sessionId: "sess-1" })).preflight?.coverage).toEqual({ apps: [], git: { apps: 1, https: 1, ssh: 0, githubApp: 0 } });
    const { svc: dk, sources: dkSources } = make({ session: session("dokploy") });
    (dkSources.create as jest.Mock).mockReturnValue({ discover: jest.fn().mockResolvedValue({ servers: [], apps: [{ ...app, notCarried: undefined }], databases: [], services: [], volumes: [], sharedEnv: [], warnings: [] }), close: jest.fn() });
    expect((await dk.plan("u1", { sourceKind: "dokploy", sessionId: "sess-1" })).preflight).not.toHaveProperty("coverage");
    const local = await make().svc.plan("u1", { sourceKind: "local-docker", serverId: "srv1" });
    expect(local.preflight).not.toHaveProperty("coverage");
  });

  it("a session minted for one source still 404s through the other source's plan", async () => {
    const { svc, sources } = make({ session: session("dokploy") });
    await expect(svc.plan("u1", { sourceKind: "coolify", sessionId: "sess-1" })).rejects.toBeInstanceOf(NotFoundException);
    expect(sources.create).not.toHaveBeenCalled();
  });
});

describe("ImporterService.previewServices", () => {
  const liveSession = { id: "sess-1", sourceKind: "coolify", actorId: "u1", teamId: "t1", baseUrl: "https://c.example.com", tokenEnc: "enc(TOK)", status: "active", expiresAt: new Date(Date.now() + 60_000) };
  const SECRET = "SYNTH-SECRET-VALUE";
  const raw = "services:\n  meilisearch:\n    image: 'getmeili/meilisearch:latest'\n    environment:\n      - SERVICE_URL_MEILISEARCH_7700\n      - 'MEILI_MASTER_KEY=${SERVICE_PASSWORD_MEILISEARCH}'\n    volumes:\n      - 'meilisearch-data:/meili_data'\n";
  const routes = (envs: unknown): Record<string, unknown> => ({
    "/servers": [{ uuid: "srv-a", name: "box" }],
    "/servers/srv-a/resources": [{ uuid: "svc1" }],
    "/applications": [],
    "/databases": [],
    "/services": [{ uuid: "svc1", name: "search", service_type: "meilisearch", docker_compose_raw: raw, applications: [{ uuid: "m1", name: "meilisearch", fqdn: null }], databases: [] }],
    "/services/svc1/envs": envs,
    "/services/svc1/storages": { file_storages: [] },
  });
  const getFrom = (r: Record<string, unknown>) => jest.fn(async (p: string) => {
    if (p in r) {
      if (r[p] instanceof Error) throw r[p];
      return r[p];
    }
    throw new Error(`404 ${p}`);
  });

  it("returns a secret-free card per service: verdict, members, env NAMES resolved, volumes, hints", async () => {
    const { svc } = make({ session: liveSession, clientGet: getFrom(routes([{ key: "SERVICE_PASSWORD_MEILISEARCH", value: SECRET }])) });
    const res = await svc.previewServices("u1", { sessionId: "sess-1" });
    expect(res.services).toHaveLength(1);
    const card = res.services[0];
    expect(card).toMatchObject({ name: "search", verdict: "importable", compat: "template", hold: false, floating: ["meilisearch"] });
    expect(card.env).toEqual({ resolved: ["SERVICE_PASSWORD_MEILISEARCH"], missing: [], secretsAvailable: true });
    expect(card.members).toEqual([{ name: "meilisearch", status: "kept" }]);
    expect(card.volumes).toEqual([{ key: "meilisearch-data", origin: "named", policy: "copy", dataPlane: "hub-staged", mounts: [{ service: "meilisearch", path: "/meili_data" }] }]);
    expect(card.domainHints).toEqual([{ service: "meilisearch", port: 7700 }]);
    expect(JSON.stringify(res)).not.toContain(SECRET);
  });

  it("when the token cannot read the variables the card says so and lists the NAMES it would need", async () => {
    const { svc } = make({ session: liveSession, clientGet: getFrom(routes(Object.assign(new Error("Coolify API error 403"), { status: 403 }))) });
    const card = (await svc.previewServices("u1", { sessionId: "sess-1" })).services[0];
    expect(card.env).toEqual({ resolved: [], missing: ["SERVICE_PASSWORD_MEILISEARCH"], secretsAvailable: false });
  });

  it("a read error degrades to secretsAvailable:false and never echoes the error text", async () => {
    const { svc } = make({ session: liveSession, clientGet: getFrom(routes(new Error(`boom ${SECRET}`))) });
    const res = await svc.previewServices("u1", { sessionId: "sess-1" });
    expect(res.services[0].env.secretsAvailable).toBe(false);
    expect(JSON.stringify(res)).not.toContain(SECRET);
  });

  it("applies the choices (rename, volume policy, hostname rows) and rejects unknown keys with a 400", async () => {
    const { svc } = make({ session: liveSession, clientGet: getFrom(routes([])) });
    const ref = "service:srv-a:svc1";
    const card = (await svc.previewServices("u1", { sessionId: "sess-1", choices: { [ref]: { name: "My Search", volumes: { "meilisearch-data": { policy: "skip" } }, serviceDomains: [{ service: "meilisearch", hostname: "s.example.test", port: 7700 }] } } })).services[0];
    expect(card.name).toBe("My Search");
    expect(card.verdict).toBe("partial");
    expect(card.volumes[0]).toMatchObject({ policy: "skip", dataPlane: "not-carried" });
    expect(card.domains).toEqual([{ service: "meilisearch", hostname: "s.example.test", port: 7700 }]);
    await expect(svc.previewServices("u1", { sessionId: "sess-1", choices: { "service:x:y": { skip: true } } })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.previewServices("u1", { sessionId: "sess-1", choices: { [ref]: { volumes: { nope: { policy: "skip" } } } } })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("enforces session ownership like plan", async () => {
    await expect(make({ session: { ...liveSession, actorId: "u2" }, clientGet: getFrom(routes([])) }).svc.previewServices("u1", { sessionId: "sess-1" })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(make({ session: null }).svc.previewServices("u1", { sessionId: "x" })).rejects.toBeInstanceOf(NotFoundException);
  });
});
