import { AgentCoolifySource } from "./agent-coolify.source";
import { AgentCoolifyClient } from "./agent-coolify.client";
import { AgentSecretStore } from "./agent-secrets";
import { planImport } from "../import-planner";
import { ImporterService } from "../importer.service";
import { CANARY, OPENED, secretsRead } from "../__fixtures__/agent-secrets.fixture";
import { fakePort } from "../__fixtures__/agent-secrets-port";

const T1 = ["env", "shared_env", "db_credentials", "service_compose", "task_command"] as const;

function make(o: { granted?: any } = {}) {
  const port = fakePort({ granted: o.granted === undefined ? [...T1] : o.granted, opened: OPENED });
  const store = new AgentSecretStore(port, "srv-agent", "sess-1", "u1");
  const client = new AgentCoolifyClient({ read: async () => secretsRead() }, "srv-agent", { teamRef: "1" });
  return { port, store, source: new AgentCoolifySource(client, store) };
}
const refsAsked = (port: ReturnType<typeof fakePort>) => port.calls.flatMap((c) => c.refs).sort();

describe("the plan reads the compose text it needs and no more", () => {
  it("asks for the compose text of compose apps and services only: no Dockerfile or labels app, no config-file content", async () => {
    const m = make();
    await m.source.discover();
    expect(refsAsked(m.port)).toEqual(["application:app-stack", "service:svc-analytics"]);
    // the old read asked for every Dockerfile, label and file-volume ref of the whole Coolify as well
    expect(refsAsked(m.port).some((r) => r.startsWith("file_volume:") || r === "application:app-web")).toBe(false);
  });

  it("a preview of some stacks reads the compose text of those stacks only (no app)", async () => {
    const m = make();
    await m.source.discover({ stacks: new Set(["svc-analytics"]) });
    expect(refsAsked(m.port)).toEqual(["service:svc-analytics"]);
    const none = make();
    await none.source.discover({ stacks: new Set(["svc-unknown"]) });
    expect(none.port.calls).toHaveLength(0);
  });

  it("the plan hash does not move: the narrowed read hashes like the whole read", async () => {
    const narrow = make();
    const narrowHash = planImport(await narrow.source.discover(), { sourceKind: "coolify" }).planHash;
    const whole = make();
    // what the plan read before: every ref of the compose class, file contents included
    const view = await (whole.source as any).agentClient.agentView();
    await whole.store.ensure(["service_compose"], () => view.secretRefs());
    const wholeHash = planImport(await whole.source.discover(), { sourceKind: "coolify" }).planHash;
    expect(narrowHash).toBe(wholeHash);
    // and a scoped preview does not change what the plan read afterwards says: the store keeps what was read, the rest is read on demand
    const scoped = make();
    await scoped.source.discover({ stacks: new Set(["svc-analytics"]) });
    expect(planImport(await scoped.source.discover(), { sourceKind: "coolify" }).planHash).toBe(narrowHash);
    expect(refsAsked(scoped.port)).toEqual(["application:app-stack", "service:svc-analytics"]); // each ref read once
  });

  it("the apply still reads what it needs after a narrowed plan: Dockerfile, labels and file contents come at apply time", async () => {
    const m = make();
    await m.source.discover();
    const bundle = await m.source.fetchServiceBundle("svc-analytics");
    expect(bundle?.files?.[0]?.content).toBe(CANARY.confFile);
    const env = await m.source.fetchSecrets("app-web");
    expect(env.values.NODE_ENV).toBe(CANARY.nodeEnv);
    // the classes a plan did not read are read now, once each
    expect(m.port.calls.map((c) => c.classes[0]).sort()).toEqual(["db_credentials", "env", "service_compose", "service_compose", "shared_env"]);
  });
});

describe("the service preview needs no sealed read of any value", () => {
  it("names the variables and files of a stack without one sealed request, with the owner's consent standing or not", async () => {
    for (const granted of [undefined, null]) {
      const m = make({ granted });
      const names = await m.source.fetchServiceBundleNames("svc-analytics");
      expect(m.port.calls).toHaveLength(0);
      expect(names).toBeDefined();
      expect(Object.keys(names!.values).sort()).toEqual(["SERVICE_PASSWORD_PG"]);
      expect(Object.values(names!.values).every((v) => v === "")).toBe(true);
      expect(names!.files?.map((f) => f.path)).toEqual(["conf.toml"]);
      expect(names!.files?.every((f) => f.content === "")).toBe(true);
      expect(JSON.stringify(names)).not.toContain("CANARY");
    }
  });

  it("answers with the same variable names as the full read, so the card says the same thing", async () => {
    const m = make();
    const names = await m.source.fetchServiceBundleNames("svc-analytics");
    const full = await m.source.fetchServiceBundle("svc-analytics");
    expect(Object.keys(names!.values).sort()).toEqual(Object.keys(full!.values).sort());
    expect(names!.unresolved).toEqual(full!.unresolved);
    expect(names!.files?.map((f) => f.path)).toEqual(full!.files?.map((f) => f.path));
  });
});

describe("ImporterService.previewServices over the agent source: what the sealed pipeline is asked", () => {
  function importer(o: { granted?: any } = {}) {
    const m = make(o);
    const session = { id: "sess-1", teamId: "t1", actorId: "u1", sourceKind: "coolify", baseUrl: "agent://srv-agent", tokenEnc: "", transport: "agent", agentServerId: "srv-agent", scopeKey: "", status: "active", expiresAt: new Date(Date.now() + 3_600_000), createdAt: new Date(), hostLinks: null, sourceTeamRef: null, teamMap: null };
    const prisma = {
      importSession: { findUnique: jest.fn().mockResolvedValue(session), update: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      coolifyInventory: { findFirst: jest.fn().mockResolvedValue({ id: "i" }) },
      application: { findMany: jest.fn().mockResolvedValue([]) },
      server: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const access = { requirePermission: jest.fn(), requireRole: jest.fn() };
    const sources = { createAgent: jest.fn(() => m.source), finishAgentRun: jest.fn() };
    const svc = new ImporterService({} as never, prisma as never, { encrypt: (s: string) => s, decrypt: (s: string) => s } as never, access as never, { log: jest.fn() } as never, sources as never);
    return { svc, ...m };
  }

  it("a preview makes no sealed request for a variable, a shared variable, a database setting or a file's content", async () => {
    const m = importer();
    const fleet = await m.source.discover({ stacks: new Set() });
    const itemRef = `service:${fleet.services[0].serverRef}:svc-analytics`;
    m.port.calls.length = 0;
    m.store.reset();
    const res = await m.svc.previewServices("u1", { sessionId: "sess-1", sourceKind: "coolify", itemRefs: [itemRef] } as never);
    expect(refsAsked(m.port)).toEqual(["service:svc-analytics"]);
    expect(res.services).toHaveLength(1);
    const classes = m.port.calls.flatMap((c) => c.classes);
    expect(classes.every((c) => c === "service_compose")).toBe(true);
    expect(refsAsked(m.port).every((r) => r.startsWith("service:"))).toBe(true);
  });

  it("a second preview of the same stacks (another choice) asks the sealed pipeline nothing: it was read once", async () => {
    const m = importer();
    await m.svc.previewServices("u1", { sessionId: "sess-1", sourceKind: "coolify", itemRefs: ["service:srv-local:svc-analytics"] } as never).catch(() => undefined);
    const after = m.port.calls.length;
    await m.svc.previewServices("u1", { sessionId: "sess-1", sourceKind: "coolify", itemRefs: ["service:srv-local:svc-analytics"] } as never).catch(() => undefined);
    expect(m.port.calls.length).toBe(after);
  });

  it("after the plan has read the compose text, a preview of any stack asks the sealed pipeline nothing", async () => {
    const m = importer();
    await m.source.discover(); // what the plan of the same session does
    const after = m.port.calls.length;
    await m.svc.previewServices("u1", { sessionId: "sess-1", sourceKind: "coolify" } as never);
    expect(m.port.calls.length).toBe(after);
  });
});
