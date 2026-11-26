import { CoolifySource, type CoolifyClient } from "./coolify.source";
import { AgentCoolifySource } from "./agent-coolify.source";
import { AgentCoolifyClient } from "./agent-coolify.client";
import { planImport } from "../import-planner";
import { buildPreflight } from "../preflight";
import { buildCoverage } from "../coverage";
import { apiRoutes, fixtureRead } from "../__fixtures__/agent-coolify.fixture";
import type { ForeignFleet, ImportPlan, ImportPreflight } from "../foreign-fleet";

class ApiClient implements CoolifyClient {
  constructor(private readonly routes: Record<string, unknown>) {}
  async get<T>(path: string): Promise<T> {
    if (!(path in this.routes)) throw Object.assign(new Error(`404 ${path}`), { status: 404 });
    return JSON.parse(JSON.stringify(this.routes[path])) as T; // what travels over HTTP is JSON
  }
}

async function readBothWays(): Promise<{ api: ForeignFleet; agent: ForeignFleet; agentSource: AgentCoolifySource }> {
  const api = await new CoolifySource(new ApiClient(apiRoutes())).discover();
  const agentSource = new AgentCoolifySource(new AgentCoolifyClient({ read: async () => fixtureRead() }, "srv-agent"));
  const agent = await agentSource.discover();
  return { api, agent, agentSource };
}

const plan = (fleet: ForeignFleet): ImportPlan => planImport(fleet, { sourceKind: "coolify" });
const preflight = (fleet: ForeignFleet): ImportPreflight => {
  const coverage = buildCoverage(fleet, { sourceKind: "coolify" });
  return { ...buildPreflight(fleet, { sourceKind: "coolify" }), ...(coverage ? { coverage } : {}) };
};

/** What only the agent read knows: the Coolify team of a project and of a server. Everything else must be equal. */
function withoutAgentOnly(f: ForeignFleet): ForeignFleet {
  return { ...f, projects: f.projects?.map(({ team: _team, ...p }) => p), servers: f.servers.map(({ team: _team, ...s }) => s) };
}
function preflightWithoutAgentOnly(p: ImportPreflight): ImportPreflight {
  const { agentRead: _a, teams: _t, unreadable: _u, ...rest } = p;
  return { ...rest, projects: rest.projects?.map(({ team: _team, ...x }) => x), hosts: rest.hosts?.map(({ team: _team, ...h }) => h) };
}

describe("agent read vs API read of the same Coolify (acceptance: same plan shape)", () => {
  it("yields the same planHash, the same plan items and the same preflight", async () => {
    const { api, agent } = await readBothWays();
    const a = plan(api);
    const b = plan(agent);
    expect(b.planHash).toBe(a.planHash);
    expect(b.items).toEqual(a.items);
    expect(b.totals).toEqual(a.totals);
    expect(preflightWithoutAgentOnly(preflight(agent))).toEqual(preflight(api));
  });

  it("builds the same fleet apart from the Coolify team of each project and server", async () => {
    const { api, agent } = await readBothWays();
    expect(withoutAgentOnly(agent)).toEqual({ ...api, warnings: agent.warnings });
  });

  it("the fleet is not trivially empty: the fixture exercises apps, databases, a service, volumes, domains and placement", async () => {
    const { agent } = await readBothWays();
    expect(agent.apps.map((a) => a.sourceRef).sort()).toEqual(["app-img", "app-site", "app-stack", "app-web"]);
    expect(agent.databases.map((d) => d.sourceRef).sort()).toEqual(["db-cache", "db-pg"]);
    expect(agent.services.map((s) => s.sourceRef)).toEqual(["svc-analytics"]);
    const web = agent.apps.find((a) => a.sourceRef === "app-web")!;
    expect(web).toMatchObject({ serverRef: "srv-edge", buildPack: "nixpacks", containerPrefix: "web-prod", installCommand: "npm ci", domainRedirect: "www", projectRef: "p-web", environmentRef: "p-web#10" });
    expect((web.domains ?? []).map((d) => d.host)).toEqual(["www.example.com", "example.com"]);
    expect((web.env ?? []).map((e) => e.key)).toEqual(["NODE_ENV", "API_URL", "TOKEN"]); // the preview twin is dropped
    expect(web.volumes).toEqual([{ name: "app-web-uploads", mountPath: "/app/uploads", type: "named", ownerRef: "app-web" }]);
    expect(web.sourceExtras).toEqual({ labels: true }); // label TEXT is not read: only that there is some
    expect(agent.apps.find((a) => a.sourceRef === "app-site")).toMatchObject({ buildPack: "static" });
    expect(agent.databases.find((d) => d.sourceRef === "db-pg")).toMatchObject({ engine: "POSTGRES", externalPort: 15432, tls: { enabled: true, mode: "require" }, hasConfigFile: true, backupSchedule: { schedules: 1, s3: true, targets: ["offsite"] } });
    expect(agent.databases.find((d) => d.sourceRef === "db-cache")).toMatchObject({ engine: "REDIS", serverRef: "srv-build" });
    expect(agent.servers.find((s) => s.ref === "srv-local")).toMatchObject({ controlPlane: true });
    expect(agent.servers.find((s) => s.ref === "srv-edge")).toMatchObject({ unreachableCount: 3, os: "Ubuntu 24.04" });
  });

  it("carries the Coolify team of each project on the plan (the API path cannot)", async () => {
    const { api, agent } = await readBothWays();
    expect(agent.projects).toEqual([
      expect.objectContaining({ ref: "p-web", team: { ref: "1", name: "Acme" } }),
      expect.objectContaining({ ref: "p-lab", team: { ref: "2", name: "Beta Labs" } }),
    ]);
    expect(api.projects?.every((p) => p.team === undefined)).toBe(true);
    const p = preflight(agent);
    expect(p.projects?.map((x) => [x.name, x.team?.name])).toEqual([["Lab", "Beta Labs"], ["Website", "Acme"]]);
  });

  it("the comparison is not vacuous: a changed domain or a dropped volume row breaks the equality", async () => {
    const { api } = await readBothWays();
    const read = fixtureRead();
    const apps = read.sections.get("applications")!;
    apps[0] = { ...apps[0], fqdn: "https://changed.example.com" };
    const changed = await new AgentCoolifySource(new AgentCoolifyClient({ read: async () => read }, "srv-agent")).discover();
    expect(plan(changed).planHash).not.toBe(plan(api).planHash);
    const read2 = fixtureRead();
    read2.sections.set("volumes", []);
    const noVol = await new AgentCoolifySource(new AgentCoolifyClient({ read: async () => read2 }, "srv-agent")).discover();
    expect(withoutAgentOnly(noVol)).not.toEqual({ ...api, warnings: noVol.warnings });
  });

  it("is not read-sensitive to row order (a shuffled read gives the same plan hash)", async () => {
    const { agent } = await readBothWays();
    const read = fixtureRead();
    for (const rows of read.sections.values()) rows.reverse();
    const shuffled = await new AgentCoolifySource(new AgentCoolifyClient({ read: async () => read }, "srv-agent")).discover();
    expect(plan(shuffled).planHash).toBe(plan(agent).planHash);
  });

  it("a source whose compose text is not read yet says so without asking for a token", async () => {
    const { agent } = await readBothWays();
    expect(agent.warnings.join("\n")).not.toMatch(/read:sensitive/);
    expect(agent.warnings.join("\n")).toMatch(/sealed secret step/);
  });
});
