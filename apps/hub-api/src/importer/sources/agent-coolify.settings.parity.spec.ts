import { CoolifySource, type CoolifyClient } from "./coolify.source";
import { AgentCoolifySource } from "./agent-coolify.source";
import { AgentCoolifyClient } from "./agent-coolify.client";
import { AgentSecretStore } from "./agent-secrets";
import { CANARY, OPENED, secretsRead } from "../__fixtures__/agent-secrets.fixture";
import { fakePort } from "../__fixtures__/agent-secrets-port";

/**
 * Acceptance: the settings of ONE Coolify team read through the agent equal what Coolify's REST API answers for the same team to a
 * token that may read sensitive fields. The API side below is written BY HAND in the API's own shape (not derived from the fixture rows
 * or from the mapper), so the two are independent descriptions of one team.
 */

class ApiClient implements CoolifyClient {
  constructor(private readonly routes: Record<string, unknown>) {}
  async get<T>(path: string): Promise<T> {
    if (!(path in this.routes)) throw Object.assign(new Error(`404 ${path}`), { status: 404 });
    return JSON.parse(JSON.stringify(this.routes[path])) as T;
  }
}

const apiRoutes = (): Record<string, unknown> => ({
  "/notifications/telegram": { telegram_enabled: true, telegram_token: CANARY.telegramToken, telegram_chat_id: "424242", telegram_notifications_deployment_success: true, telegram_notifications_deployment_failure: false },
  "/team/envs": [{ key: "DB_HOST", value: CANARY.dbHost, is_preview: false, is_shown_once: false }],
  "/projects": [{ uuid: "p-web", name: "Website", description: "Marketing site" }],
  "/projects/p-web": { uuid: "p-web", name: "Website", environments: [{ id: 10, name: "production" }, { id: 11, name: "staging" }] },
  "/projects/p-web/envs": [{ key: "ONLY_PROJECT", value: "CANARY-project-only", is_preview: false, is_shown_once: true }],
  "/projects/p-web/environments/production/envs": [{ key: "DB_NAME", value: CANARY.dbName, is_preview: false, is_shown_once: false }],
  "/projects/p-web/environments/staging/envs": [],
  "/s3-storages": [{ id: 1, uuid: "s3-off", name: "offsite", type: "s3", endpoint: "https://s3.example.com", bucket: "acme-backups", region: "eu-central-1" }],
  "/applications": [{ uuid: "app-web", name: "web" }, { uuid: "app-img", name: "worker" }, { uuid: "app-stack", name: "stack" }],
  "/services": [{ uuid: "svc-analytics", name: "analytics" }],
  "/databases": [{ uuid: "db-pg", name: "web-db" }, { uuid: "db-cache", name: "cache" }],
  "/servers": [{ uuid: "srv-edge", name: "edge" }, { uuid: "srv-build", name: "builder" }],
  "/applications/app-web/scheduled-tasks": [{ uuid: "tk1", name: "nightly", command: CANARY.taskCommand, frequency: "daily", container: null, timeout: 300, enabled: true }],
  "/applications/app-img/scheduled-tasks": [],
  "/applications/app-stack/scheduled-tasks": [],
  "/services/svc-analytics/scheduled-tasks": [{ uuid: "tk2", name: "svc-cron", command: "echo CANARY-svc", frequency: "every_minute", container: "plausible", timeout: 60, enabled: false }],
  "/servers/srv-edge/docker-cleanup": { docker_cleanup_frequency: "0 0 * * *", docker_cleanup_threshold: 80, delete_unused_volumes: true, delete_unused_networks: false, force_docker_cleanup: false },
  "/tags": [{ name: "prod" }],
  "/applications/app-web/tags": [{ name: "prod" }],
  "/applications/app-img/tags": [],
  "/applications/app-stack/tags": [],
  "/databases/db-pg/tags": [{ name: "prod" }],
  "/databases/db-cache/tags": [],
  "/services/svc-analytics/tags": [{ name: "prod" }],
  "/team/members": [{ email: "ada@example.com", name: "Ada", role: "owner" }, { email: "lin@example.com", name: "Lin", role: "member" }],
});

const normalize = (raw: Awaited<ReturnType<CoolifySource["readSettings"]>>) => JSON.parse(JSON.stringify(raw, (_k, v) => (Array.isArray(v) && v.length > 1 && v.every((x) => x && typeof x === "object") ? [...v].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : v)));

describe("settings: agent read vs API read of the same Coolify team (acceptance: same data)", () => {
  const agentSource = () => {
    const port = fakePort({ granted: ["env", "shared_env", "db_credentials", "service_compose", "task_command", "notification"], opened: OPENED });
    const store = new AgentSecretStore(port, "srv-agent", "sess-1", "u1");
    return { port, source: new AgentCoolifySource(new AgentCoolifyClient({ read: async () => secretsRead() }, "srv-agent", { teamRef: "1" }), store) };
  };

  it("every section answers the same, values included", async () => {
    const api = await new CoolifySource(new ApiClient(apiRoutes())).readSettings();
    const agent = await agentSource().source.readSettings();
    expect(normalize(agent)).toEqual(normalize(api));
    // and the comparison is not vacuous: the values are really there
    expect(JSON.stringify(agent)).toContain(CANARY.telegramToken);
    expect(JSON.stringify(agent)).toContain(CANARY.taskCommand);
    expect(JSON.stringify(agent)).toContain(CANARY.dbHost);
  });

  it("is not vacuous the other way: a changed task command or a dropped channel breaks the equality", async () => {
    const api = await new CoolifySource(new ApiClient(apiRoutes())).readSettings();
    const r = apiRoutes();
    (r["/applications/app-web/scheduled-tasks"] as Array<Record<string, unknown>>)[0].command = "changed";
    delete r["/notifications/telegram"];
    const other = await new CoolifySource(new ApiClient(r)).readSettings();
    expect(normalize(other)).not.toEqual(normalize(api));
  });

  it("the other team's settings never leak into the chosen team's read", async () => {
    const agent = JSON.stringify(await agentSource().source.readSettings());
    for (const other of ["OTHER_TEAM", "CANARY-other-team", "app-site", "p-lab", "discord"]) expect(agent).not.toContain(other);
  });
});

describe("apply-time reads: agent read vs API read of the same Coolify (acceptance: same values)", () => {
  const flags = (b: boolean, r: boolean, l: boolean) => ({ is_buildtime: b, is_runtime: r, is_literal: l, is_multiline: false, is_shown_once: false, is_preview: false });
  const routes = (): Record<string, unknown> => ({
    "/applications/app-web/envs": [
      { key: "NODE_ENV", value: CANARY.nodeEnv, ...flags(true, true, false) },
      { key: "API_URL", value: CANARY.apiUrl, ...flags(false, true, true) },
      { key: "API_URL", value: "CANARY-preview", ...flags(false, true, true), is_preview: true },
      { key: "TOKEN", value: CANARY.token, ...flags(false, true, false), is_shown_once: true },
      { key: "DATABASE_URL", value: CANARY.dbUrl, real_value: `postgres://app:CANARY-pw@${CANARY.dbHost}:5432/${CANARY.dbName}`, ...flags(false, true, false) },
    ],
    "/services/svc-analytics/envs": [
      { key: "SERVICE_PASSWORD_PG", value: CANARY.svcPassword, is_runtime: true, is_literal: false, is_preview: false },
      { key: "SERVICE_FQDN_PLAUSIBLE", value: "https://canary.test", is_runtime: true, is_preview: false },
    ],
    "/services/svc-analytics/storages": {
      persistent_storages: [],
      file_storages: [
        { fs_path: "/data/coolify/services/svc-analytics/conf.toml", content: CANARY.confFile, is_directory: false },
        { fs_path: "/data/coolify/services/svc-analytics/dir", is_directory: true },
      ],
    },
    "/databases/db-pg": { uuid: "db-pg", database_type: "standalone-postgresql", postgres_conf: CANARY.confPg },
    "/applications/app-web": { uuid: "app-web", build_pack: "nixpacks", custom_labels: CANARY.labels },
  });
  const agent = () => {
    const port = fakePort({ granted: ["env", "shared_env", "db_credentials", "service_compose"], opened: OPENED });
    const store = new AgentSecretStore(port, "srv-agent", "sess-1", "u1");
    return new AgentCoolifySource(new AgentCoolifyClient({ read: async () => secretsRead() }, "srv-agent", { teamRef: "1" }), store);
  };

  it("env values (with the shared references expanded), service variables and files, engine config and labels answer the same", async () => {
    const api = new CoolifySource(new ApiClient(routes()));
    const a = agent();
    expect(await a.fetchSecrets("app-web")).toEqual(await api.fetchSecrets("app-web"));
    expect(await a.fetchServiceBundle("svc-analytics")).toEqual(await api.fetchServiceBundle("svc-analytics"));
    expect(await a.fetchDbConfigFile("db-pg", "POSTGRES")).toEqual(await api.fetchDbConfigFile("db-pg", "POSTGRES"));
    expect((await a.fetchAppExtras("app-web"))?.labels).toEqual((await api.fetchAppExtras("app-web"))?.labels);
  });
});

