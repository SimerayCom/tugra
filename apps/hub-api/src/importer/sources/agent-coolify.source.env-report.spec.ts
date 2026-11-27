import { AgentCoolifySource } from "./agent-coolify.source";
import { AgentCoolifyClient } from "./agent-coolify.client";
import { AgentSecretStore } from "./agent-secrets";
import { AgentSecretsAdapter } from "../agent-secrets.adapter";
import { planImport, ENV_RISK_CONSENT_REQUIRED, ENV_RISK_TOKEN_READ_ONLY } from "../import-planner";
import { secretsRead, OPENED } from "../__fixtures__/agent-secrets.fixture";
import { fakePort } from "../__fixtures__/agent-secrets-port";
import type { ForeignFleet } from "../foreign-fleet";

const ALL = ["env", "shared_env", "db_credentials", "service_compose", "task_command"] as const;

function make(granted: readonly string[] | null, opts: { noStore?: boolean } = {}) {
  const port = fakePort({ granted: granted === null ? null : ([...granted] as never), opened: OPENED });
  const store = new AgentSecretStore(port, "srv-agent", "sess-2", "u1");
  const client = new AgentCoolifyClient({ read: async () => secretsRead() }, "srv-agent", { teamRef: "1" });
  return { port, source: new AgentCoolifySource(client, opts.noStore ? undefined : store) };
}

const codes = (fleet: ForeignFleet): Record<string, string[]> => {
  const plan = planImport(fleet, { sourceKind: "coolify" });
  return Object.fromEntries(plan.items.filter((i) => i.kind === "app").map((i) => [i.name, i.risks.filter((r) => r.code.startsWith("app.env.")).map((r) => r.code)]));
};

describe("an agent session's env report: no API token is involved", () => {
  it("with the owner's consent for the values, no app is blocked as 'the API token cannot read values'", async () => {
    const { source } = make(ALL);
    const fleet = await source.discover();
    const withEnv = fleet.apps.filter((a) => a.envReport && a.envReport.total > 0);
    expect(withEnv.length).toBeGreaterThan(0); // the fixture has apps with variables: the check below is not vacuous
    for (const a of withEnv) expect(a.envReport!.tokenReadOnly).toBe(false);
    const all = Object.values(codes(fleet)).flat();
    expect(all).not.toContain(ENV_RISK_TOKEN_READ_ONLY);
    expect(all).not.toContain(ENV_RISK_CONSENT_REQUIRED);
  });

  it("with the consent, only what is known without a value stays a per-key blocker (LOCKED), never NO_VALUE", async () => {
    const fleet = await make(ALL).source.discover();
    const web = fleet.apps.find((a) => a.sourceRef === "app-web")!;
    expect(web.envReport!.unresolved).toEqual([{ key: "TOKEN", reason: "LOCKED" }]);
  });

  it("without the consent the blocker says to allow secret values, not to create a token", async () => {
    const { source } = make(null);
    const fleet = await source.discover();
    const plan = planImport(fleet, { sourceKind: "coolify" });
    const web = plan.items.find((i) => i.itemRef.endsWith(":app-web"))!;
    const risk = web.risks.find((r) => r.code === ENV_RISK_CONSENT_REQUIRED)!;
    expect(risk.level).toBe("blocker");
    expect(risk.message).toMatch(/allow reading secret values/);
    expect(risk.message).not.toMatch(/token|read:sensitive|reconnect/i);
    expect(web.risks.some((r) => r.code === ENV_RISK_TOKEN_READ_ONLY)).toBe(false);
  });

  it("a consent that does not cover the env class is the same: allow it, no token", async () => {
    const fleet = await make(["service_compose"]).source.discover();
    const all = Object.values(codes(fleet)).flat();
    expect(all).toContain(ENV_RISK_CONSENT_REQUIRED);
    expect(all).not.toContain(ENV_RISK_TOKEN_READ_ONLY);
  });

  it("a source without a secret store has no consent either", async () => {
    const fleet = await make(ALL, { noStore: true }).source.discover();
    expect(Object.values(codes(fleet)).flat()).toContain(ENV_RISK_CONSENT_REQUIRED);
  });

  it("opens no value to plan: the variable values are read at apply time, not here", async () => {
    const { source, port } = make(ALL);
    await source.discover();
    expect(port.calls.flatMap((c) => c.classes)).not.toContain("env");
  });
});

describe("the consent is bound to the session the team pick made (the second one), not the first", () => {
  function adapterWith(grant: { runId: string; classes: string[] } | null) {
    const grants = { activeSecretsGrant: jest.fn().mockResolvedValue(grant), finishRunByRunId: jest.fn() };
    return new AgentSecretsAdapter({} as never, grants as never, { decrypt: (s: string) => s } as never);
  }
  const sourceFor = (a: AgentSecretsAdapter, sessionId: string) =>
    new AgentCoolifySource(new AgentCoolifyClient({ read: async () => secretsRead() }, "srv-agent", { teamRef: "1" }), a.stores.forRun("srv-agent", sessionId, "u1"));

  it("the grant made for session 2 clears session 2's plan and leaves session 1's asking for it", async () => {
    const a = adapterWith({ runId: "sess-2", classes: [...ALL] });
    expect(Object.values(codes(await sourceFor(a, "sess-2").discover())).flat()).not.toContain(ENV_RISK_CONSENT_REQUIRED);
    expect(Object.values(codes(await sourceFor(a, "sess-1").discover())).flat()).toContain(ENV_RISK_CONSENT_REQUIRED);
    expect((await sourceFor(a, "sess-2").agentPlan()).secretsConsent).toEqual({ classes: [...ALL] });
    expect((await sourceFor(a, "sess-1").agentPlan()).secretsConsent).toBeUndefined();
  });
});
