import { ForbiddenException } from "@nestjs/common";
import { AgentCoolifySource } from "./agent-coolify.source";
import { AgentCoolifyClient } from "./agent-coolify.client";
import { AgentSecretStore } from "./agent-secrets";
import { planImport } from "../import-planner";
import { CANARY, OPENED, secretsRead } from "../__fixtures__/agent-secrets.fixture";
import { fakePort } from "../__fixtures__/agent-secrets-port";

const T1 = ["env", "shared_env", "db_credentials", "service_compose", "task_command"] as const;

function make(o: { granted?: any; opened?: Record<string, string>; codes?: Record<string, string>; teamRef?: string; noStore?: boolean } = {}) {
  const port = fakePort({ granted: o.granted === undefined ? [...T1] : o.granted, opened: o.opened ?? OPENED, codes: o.codes });
  const store = new AgentSecretStore(port, "srv-agent", "sess-1", "u1");
  const client = new AgentCoolifyClient({ read: async () => secretsRead() }, "srv-agent", { teamRef: o.teamRef ?? "1" });
  const source = new AgentCoolifySource(client, o.noStore ? undefined : store);
  return { port, store, source };
}

describe("AgentCoolifySource with the owner's consent: as complete as a read:sensitive token", () => {
  describe("the plan sees compose text, and nothing else of what is sealed", () => {
    it("carries a compose app's and a service's compose text when the owner consented, and not otherwise", async () => {
      const withConsent = await make().source.discover();
      expect(withConsent.apps.find((a) => a.sourceRef === "app-stack")?.composeFile).toBe(CANARY.composeStack);
      expect(withConsent.services.find((s) => s.sourceRef === "svc-analytics")?.composeFile).toBe(CANARY.composeSvc);
      const without = await make({ granted: null }).source.discover();
      expect(without.apps.find((a) => a.sourceRef === "app-stack")?.composeFile).toBeUndefined();
      expect(without.services[0].composeFile).toBeUndefined();
    });

    it("asks only for the compose class to plan, and the plan, its hash and the agent block hold no value", async () => {
      const m = make();
      const fleet = await m.source.discover();
      expect(m.port.calls.map((c) => c.classes)).toEqual([["service_compose"]]);
      const plan = planImport(fleet, { sourceKind: "coolify" });
      const extra = await m.source.agentPlan();
      const text = JSON.stringify([plan, extra]);
      expect(text).not.toContain("CANARY");
      // the labels, the Dockerfile, every env value and the settings were not even asked for
      expect(m.port.calls.flatMap((c) => c.refs).some((r) => r.startsWith("env:") || r.startsWith("scheduled_task:"))).toBe(false);
    });

    it("an app's Dockerfile and label text are only presence in the plan, never the text", async () => {
      const fleet = await make().source.discover();
      expect(JSON.stringify(fleet.apps.find((a) => a.sourceRef === "app-web"))).not.toContain("CANARY");
    });
  });

  describe("fetchSecrets: the env values of an app", () => {
    it("returns the values with the expanded shared reference, skips the preview twin, keeps the flags", async () => {
      const { source } = make();
      const r = await source.fetchSecrets("app-web");
      expect(r.values).toEqual({
        NODE_ENV: CANARY.nodeEnv,
        API_URL: CANARY.apiUrl, // literal: brace text is data
        TOKEN: CANARY.token,
        DATABASE_URL: `postgres://app:CANARY-pw@${CANARY.dbHost}:5432/${CANARY.dbName}`,
      });
      expect(r.unresolved).toEqual([]);
      expect(r.previewSkipped).toBe(1);
      expect(r.flags?.NODE_ENV).toEqual({ buildTime: true, runtime: true, literal: false, multiline: false });
    });

    it("reads every class an apply needs once, however many apps ask", async () => {
      const { source, port } = make();
      await Promise.all([source.fetchSecrets("app-web"), source.fetchSecrets("app-img"), source.fetchSecrets("app-site"), source.fetchServiceBundle("svc-analytics")]);
      const asked = port.calls.map((c) => c.classes[0]).sort();
      expect(asked).toEqual(["db_credentials", "env", "service_compose", "shared_env"]);
      expect(port.calls.every((c) => c.runId === "sess-1")).toBe(true);
    });

    it("a value that could not be opened holds back ONLY that variable (it comes back unresolved), the app next to it is whole", async () => {
      const opened = { ...OPENED };
      delete opened["env:ev1|value"];
      const { source } = make({ opened, codes: { "env:ev1|value": "bad_mac" } });
      const web = await source.fetchSecrets("app-web");
      expect(web.unresolved.map((u) => [u.key, u.reason])).toEqual([["NODE_ENV", "NO_VALUE"]]);
      expect(web.values.NODE_ENV).toBeUndefined();
      expect(web.values.DATABASE_URL).toBeDefined();
      const img = await source.fetchSecrets("app-img");
      expect(img.unresolved).toEqual([]);
      expect(img.values).toEqual({ REGION: CANARY.region, EMPTY: "" });
    });

    it("a shared reference that cannot be resolved stays an unresolved variable of its app only", async () => {
      const opened = { ...OPENED };
      delete opened["shared_env:sh1|value"];
      const web = await make({ opened }).source.fetchSecrets("app-web");
      expect(web.unresolved.map((u) => [u.key, u.reason])).toEqual([["DATABASE_URL", "SHARED_UNEXPANDED"]]);
    });

    it("without the consent every variable is unresolved: nothing is invented", async () => {
      const web = await make({ granted: null }).source.fetchSecrets("app-web");
      expect(web.values).toEqual({});
      expect(web.unresolved.length).toBeGreaterThan(0);
    });

    it("a source built without a secret store reads nothing sealed", async () => {
      const web = await make({ noStore: true }).source.fetchSecrets("app-web");
      expect(web.values).toEqual({});
    });
  });

  describe("services, Dockerfile, labels, engine config", () => {
    it("fetchServiceBundle carries the variables (the magic secrets too, the FQDN bookkeeping not) and the config files", async () => {
      const b = await make().source.fetchServiceBundle("svc-analytics");
      expect(b?.values).toEqual({ SERVICE_PASSWORD_PG: CANARY.svcPassword });
      expect(b?.files).toEqual([{ path: "conf.toml", content: CANARY.confFile }]);
    });

    it("fetchAppExtras carries the decoded labels; fetchDbConfigFile the engine config text", async () => {
      const { source } = make();
      const extras = await source.fetchAppExtras("app-web");
      expect(extras?.labels).toEqual([{ key: "traefik.enable", value: "CANARY" }]);
      expect(await source.fetchDbConfigFile("db-pg", "POSTGRES")).toBe(CANARY.confPg);
    });

    it("without consent nothing of this is carried (undefined / empty, like a token without the right)", async () => {
      const { source } = make({ granted: null });
      expect((await source.fetchAppExtras("app-web"))?.labels).toBeUndefined();
      expect(await source.fetchDbConfigFile("db-pg", "POSTGRES")).toBeUndefined();
      expect((await source.fetchServiceBundle("svc-analytics"))?.values).toEqual({});
    });
  });

  describe("readSettings: notifications, shared variables, tasks, tags, members, cleanup", () => {
    it("reads every section for the chosen team, with the values the consent covers", async () => {
      const raw = await make({ granted: [...T1, "notification"] }).source.readSettings();
      expect(raw.notifications).toMatchObject({ ok: true, items: [expect.objectContaining({ kind: "telegram", enabled: true, secretsReadable: true, config: { botToken: CANARY.telegramToken, chatId: "424242" } })] });
      expect(raw.sharedVariables).toMatchObject({ ok: true, items: expect.arrayContaining([expect.objectContaining({ scope: "team", key: "DB_HOST", value: CANARY.dbHost })]) });
      expect(raw.scheduledTasks).toMatchObject({ ok: true, items: expect.arrayContaining([expect.objectContaining({ name: "nightly", command: CANARY.taskCommand, frequency: "daily", resourceKind: "application", resourceRef: "app-web" })]) });
      expect(raw.tags).toMatchObject({ ok: true, items: [{ name: "prod", resources: expect.arrayContaining([{ kind: "application", ref: "app-web", name: "web" }, { kind: "database", ref: "db-pg", name: "web-db" }, { kind: "service", ref: "svc-analytics", name: "analytics" }]) }] });
      expect(raw.members).toEqual({ ok: true, items: [{ email: "ada@example.com", name: "Ada", role: "owner" }, { email: "lin@example.com", name: "Lin", role: "member" }] });
      expect(raw.serverSettings).toMatchObject({ ok: true, items: [expect.objectContaining({ serverRef: "srv-edge", frequency: "0 0 * * *", thresholdPct: 80, deleteVolumes: true })] });
      expect(raw.storages).toMatchObject({ ok: true, items: [expect.objectContaining({ ref: "s3-off", name: "offsite", bucket: "acme-backups" })] });
    });

    it("notification tokens are opt-in: without that class the channel is listed and its secrets are not readable", async () => {
      const raw = await make().source.readSettings(new Set(["notifications"]));
      expect(raw.notifications).toMatchObject({ ok: true, items: [expect.objectContaining({ kind: "telegram", secretsReadable: false, config: {} })] });
    });

    it("scheduled tasks need the consent: without it the section is refused (never half-read with empty commands)", async () => {
      const raw = await make({ granted: null }).source.readSettings(new Set(["scheduledTasks", "members"]));
      expect(raw.scheduledTasks).toEqual({ ok: false, reason: "forbidden" });
      expect(raw.members.ok).toBe(true); // what needs no secret is still read
    });

    it("reads only the classes of the sections asked for", async () => {
      const m = make({ granted: [...T1, "notification"] });
      await m.source.readSettings(new Set(["members", "tags"]));
      expect(m.port.calls).toEqual([]);
      await m.source.readSettings(new Set(["sharedVariables"]));
      expect(m.port.calls.map((c) => c.classes)).toEqual([["shared_env"]]);
    });

    it("with several Coolify teams and none chosen the team sections are 'not exposed' and the team is unknown", async () => {
      const m = make({ teamRef: "99" });
      const raw = await m.source.readSettings(new Set(["members", "notifications"]));
      expect(raw.members).toEqual({ ok: false, reason: "not_exposed" });
      expect(raw.notifications).toEqual({ ok: false, reason: "not_exposed" });
      expect(await m.source.currentTeam()).toBeUndefined();
    });
  });

  describe("beginApply and finishApply: the consent belongs to the import", () => {
    it("refuses (403 consent_required) with no store, and with no consent standing for this run", async () => {
      await expect(make({ noStore: true }).source.beginApply()).rejects.toMatchObject({ response: { code: "consent_required" } });
      await expect(make({ granted: null }).source.beginApply()).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("starts from a fresh read: what the plan read is forgotten", async () => {
      const m = make();
      await m.source.discover();
      expect(m.port.calls).toHaveLength(1);
      await m.source.beginApply();
      await m.source.discover();
      expect(m.port.calls).toHaveLength(2); // read again
    });

    it("finishApply ends the consent of this run and forgets every value", async () => {
      const m = make();
      await m.source.fetchSecrets("app-web");
      await m.source.finishApply();
      expect(m.port.finished).toEqual([["srv-agent", "sess-1"]]);
      expect(m.store.get("env:ev1", "value")).toBeUndefined();
    });
  });

  it("the source servers come from one cheap read, with the Coolify host marked", async () => {
    expect(await make().source.sourceServers()).toEqual([
      { ref: "srv-local", address: "host.docker.internal", controlPlane: true },
      { ref: "srv-edge", address: "198.51.100.7", controlPlane: false },
      { ref: "srv-build", address: "198.51.100.8", controlPlane: false },
    ]);
  });
});
