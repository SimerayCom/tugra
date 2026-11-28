import { AgentApiNotFound, buildAgentView } from "./agent-coolify.mapper";
import { CANARY, OPENED, overlayOf, secretsRead } from "../__fixtures__/agent-secrets.fixture";

const view = (teamRef?: string) => buildAgentView(secretsRead(), "srv-agent", teamRef ? { teamRef } : {});
const sens = (path: string, overlay = overlayOf(), teamRef?: string) => view(teamRef).route(path, overlay, true) as any;

describe("agent view with the opened secrets (the answers of a token that may read sensitive fields)", () => {
  describe("what the plain read can never serve", () => {
    it("serves none of the value paths without the sensitive flag, even when an overlay is handed over", () => {
      const v = view();
      for (const p of ["/team/envs", "/team/members", "/teams/current", "/tags", "/notifications/telegram", "/services/svc-analytics/envs", "/services/svc-analytics/storages", "/applications/app-web/scheduled-tasks", "/servers/srv-edge/docker-cleanup", "/projects/p-web/envs"]) {
        expect(() => v.route(p, overlayOf())).toThrow(AgentApiNotFound);
      }
    });

    it("plain rows hold no canary: values only exist behind the overlay", () => {
      const v = view();
      const text = JSON.stringify([v.route("/applications"), v.route("/applications/app-web/envs"), v.route("/databases"), v.route("/services"), v.route("/services/svc-analytics")]);
      expect(text).not.toContain("CANARY");
    });
  });

  describe("environment values", () => {
    it("gives each variable its opened value, and drops the preview twin", () => {
      const envs = sens("/applications/app-web/envs");
      expect(envs.map((e: any) => [e.key, e.value])).toEqual([
        ["NODE_ENV", CANARY.nodeEnv],
        ["API_URL", CANARY.apiUrl],
        ["API_URL", "CANARY-preview"], // the preview twin stays a preview row: the importer drops it by its flag
        ["TOKEN", CANARY.token], // a locked variable is readable from the database
        ["DATABASE_URL", CANARY.dbUrl],
      ]);
      expect(envs.filter((e: any) => e.is_preview).map((e: any) => e.key)).toEqual(["API_URL"]);
    });

    it("expands {{team.X}} and {{environment.X}} the way Coolify does, into real_value, and keeps the written value", () => {
      const row = sens("/applications/app-web/envs").find((e: any) => e.key === "DATABASE_URL");
      expect(row.value).toBe(CANARY.dbUrl);
      expect(row.real_value).toBe(`postgres://app:CANARY-pw@${CANARY.dbHost}:5432/${CANARY.dbName}`);
    });

    it("never expands a literal row (brace text is data there)", () => {
      const row = sens("/applications/app-web/envs").find((e: any) => e.key === "API_URL" && !e.is_preview);
      expect(row.real_value).toBeUndefined();
      expect(row.value).toBe(CANARY.apiUrl);
    });

    it("leaves a reference it cannot resolve as it is (the importer then reports it as unexpanded)", () => {
      const row = sens("/applications/app-web/envs", overlayOf(OPENED, ["shared_env:sh1|value"])).find((e: any) => e.key === "DATABASE_URL");
      expect(row.value).toBe(CANARY.dbUrl);
      expect(row.real_value).toBeUndefined();
    });

    it("a value that could not be opened is absent, and the row keeps its flags (so only that variable is held back)", () => {
      const envs = sens("/applications/app-web/envs", overlayOf(OPENED, ["env:ev1|value", "env:ev4|value"]));
      const node = envs.find((e: any) => e.key === "NODE_ENV");
      expect(node).not.toHaveProperty("value");
      expect(node.is_runtime).toBe(true);
      expect(envs.find((e: any) => e.key === "TOKEN")).not.toHaveProperty("value");
      expect(envs.find((e: any) => e.key === "TOKEN").is_shown_once).toBe(true);
      expect(envs.find((e: any) => e.key === "DATABASE_URL").value).toBe(CANARY.dbUrl); // the others are untouched
    });

    it("an empty stored value is an empty variable, not a missing one", () => {
      expect(sens("/applications/app-img/envs").map((e: any) => [e.key, e.value])).toEqual([["REGION", CANARY.region], ["EMPTY", ""]]);
    });

    it("with no opened values at all (no consent) nothing has a value", () => {
      const envs = sens("/applications/app-web/envs", overlayOf({}));
      expect(envs.every((e: any) => !("value" in e))).toBe(true);
    });
  });

  describe("text of applications, databases and services", () => {
    it("puts the opened Dockerfile and label text back and clears their presence marks; the other marks stay", () => {
      const web = sens("/applications/app-web");
      expect(web.dockerfile).toContain("CANARY-dockerfile");
      expect(web.custom_labels).toBe(CANARY.labels);
      expect(web.presence).toEqual({ pre_deployment_command: true }); // not sealed by this path
    });

    it("keeps the presence mark of text that was not opened", () => {
      const web = sens("/applications/app-web", overlayOf(OPENED, ["application:app-web|custom_labels"]));
      expect(web).not.toHaveProperty("custom_labels");
      expect(web.presence).toMatchObject({ custom_labels: true });
    });

    it("gives a compose app and a service their compose text, and a database its config text", () => {
      expect(sens("/applications/app-stack").docker_compose_raw).toBe(CANARY.composeStack);
      expect(sens("/services/svc-analytics").docker_compose_raw).toBe(CANARY.composeSvc);
      expect(sens("/databases/db-pg").postgres_conf).toBe(CANARY.confPg);
      expect(sens("/databases/db-pg")).not.toHaveProperty("presence");
    });

    it("the list rows carry the same text", () => {
      expect(sens("/applications", overlayOf(), "1").find((a: any) => a.uuid === "app-stack").docker_compose_raw).toBe(CANARY.composeStack);
    });
  });

  describe("services: variables and files", () => {
    it("serves a service's variables with values, and the bookkeeping rows are left to the importer's own filter", () => {
      const envs = sens("/services/svc-analytics/envs");
      expect(envs.map((e: any) => [e.key, e.value])).toEqual([["SERVICE_PASSWORD_PG", CANARY.svcPassword], ["SERVICE_FQDN_PLAUSIBLE", "https://canary.test"]]);
    });

    it("serves a service's files with their content, and a directory without any", () => {
      const st = sens("/services/svc-analytics/storages");
      expect(st.file_storages.map((f: any) => [f.fs_path, f.is_directory, f.content])).toEqual([
        ["/data/coolify/services/svc-analytics/conf.toml", false, CANARY.confFile],
        ["/data/coolify/services/svc-analytics/dir", true, undefined],
      ]);
      expect(st.persistent_storages).toEqual([]);
    });
  });

  describe("the settings of one Coolify team", () => {
    it("with two teams that have projects and none chosen, the team routes say so (404) and the view asks for a choice", () => {
      const v = view();
      expect(v.needsTeamChoice).toBe(true);
      expect(v.currentTeam).toBeNull();
      for (const p of ["/teams/current", "/team/envs", "/team/members", "/tags", "/notifications/telegram"]) expect(() => v.route(p, overlayOf(), true)).toThrow(AgentApiNotFound);
    });

    it("answers for the chosen team and never for another", () => {
      expect(sens("/teams/current", overlayOf(), "1")).toEqual({ id: "1", name: "Acme" });
      expect(sens("/team/envs", overlayOf(), "1").map((e: any) => [e.key, e.value])).toEqual([["DB_HOST", CANARY.dbHost]]);
      expect(sens("/team/envs", overlayOf(), "2").map((e: any) => e.key)).toEqual(["OTHER_TEAM"]);
      expect(sens("/tags", overlayOf(), "1")).toEqual([{ name: "prod" }]);
      expect(sens("/team/members", overlayOf(), "1")).toEqual([{ email: "ada@example.com", name: "Ada", role: "owner" }, { email: "lin@example.com", name: "Lin", role: "member" }]);
      expect(sens("/team/members", overlayOf(), "2")).toEqual([{ email: "lin@example.com", name: "Lin", role: "owner" }]);
    });

    it("a team that is the only one with projects is the team without being chosen", () => {
      const read = secretsRead();
      read.sections.set("projects", read.sections.get("projects")!.filter((p) => p.team_id === 1));
      const v = buildAgentView(read, "s");
      expect(v.currentTeam).toEqual({ ref: "1", name: "Acme" });
      expect(v.needsTeamChoice).toBe(false);
    });

    it("an unknown team reference is not a team", () => {
      expect(view("99").currentTeam).toBeNull();
    });

    it("serves project and environment shared variables by the project's uuid and the environment's name", () => {
      expect(sens("/projects/p-web/envs").map((e: any) => [e.key, e.is_shown_once, e.value])).toEqual([["ONLY_PROJECT", true, "CANARY-project-only"]]);
      expect(sens("/projects/p-web/environments/production/envs").map((e: any) => [e.key, e.value])).toEqual([["DB_NAME", CANARY.dbName]]);
      expect(() => sens("/projects/p-web/environments/nope/envs")).toThrow(AgentApiNotFound);
      expect(() => sens("/projects/nope/envs")).toThrow(AgentApiNotFound);
    });

    it("a shared variable whose value could not be opened is listed without a value", () => {
      const rows = sens("/team/envs", overlayOf(OPENED, ["shared_env:sh1|value"]), "1");
      expect(rows).toEqual([expect.objectContaining({ key: "DB_HOST", is_shown_once: false })]);
      expect(rows[0]).not.toHaveProperty("value");
    });

    it("serves scheduled tasks per application and per service, the command only from the opened value", () => {
      expect(sens("/applications/app-web/scheduled-tasks")).toEqual([{ uuid: "tk1", name: "nightly", frequency: "daily", container: null, timeout: 300, enabled: true, command: CANARY.taskCommand }]);
      expect(sens("/services/svc-analytics/scheduled-tasks")).toEqual([expect.objectContaining({ uuid: "tk2", enabled: false, container: "plausible", command: "echo CANARY-svc" })]);
      expect(sens("/applications/app-web/scheduled-tasks", overlayOf({}))[0]).not.toHaveProperty("command");
      expect(sens("/applications/app-img/scheduled-tasks")).toEqual([]);
    });

    it("serves a notification channel: its own switches and toggles as stored, its token only from the opened value", () => {
      const row = sens("/notifications/telegram", overlayOf(), "1");
      expect(row).toMatchObject({ telegram_enabled: true, telegram_chat_id: "424242", telegram_notifications_deployment_success: true, telegram_notifications_deployment_failure: false, telegram_token: CANARY.telegramToken });
      expect(Object.keys(row).some((k) => k.endsWith("_present"))).toBe(false);
      expect(sens("/notifications/telegram", overlayOf({}), "1")).not.toHaveProperty("telegram_token");
      // another team's channel is not served, and neither is a kind this Coolify has no row for
      expect(() => sens("/notifications/discord", overlayOf(), "1")).toThrow(AgentApiNotFound);
      expect(() => sens("/notifications/slack", overlayOf(), "1")).toThrow(AgentApiNotFound);
      expect(() => sens("/notifications/__proto__", overlayOf(), "1")).toThrow(AgentApiNotFound);
    });

    it("tells a column that holds nothing (null) from one that is hidden (left out)", () => {
      // team 2's Slack was never set up: its webhook column is visible and empty, like the API of a token that may read it
      expect(sens("/notifications/slack", overlayOf({}), "2")).toMatchObject({ slack_enabled: false, slack_webhook_url: null });
      // team 1's Telegram has a token the overlay did not open: left out
      expect(sens("/notifications/telegram", overlayOf({}), "1")).not.toHaveProperty("telegram_token");
    });

    it("serves the tags of each resource kind", () => {
      expect(sens("/applications/app-web/tags")).toEqual([{ name: "prod" }]);
      expect(sens("/databases/db-pg/tags")).toEqual([{ name: "prod" }]);
      expect(sens("/services/svc-analytics/tags")).toEqual([{ name: "prod" }]);
      expect(sens("/applications/app-img/tags")).toEqual([]);
    });

    it("lists only the chosen team's own resources, servers and projects, so a task, a tag or a shared variable of another team is never read", () => {
      const uuids = (p: string, team: string) => sens(p, overlayOf(), team).map((x: any) => x.uuid);
      expect(uuids("/applications", "1")).toEqual(["app-web", "app-img", "app-stack"]);
      expect(uuids("/applications", "2")).toEqual(["app-site"]);
      expect(uuids("/databases", "1")).toEqual(["db-pg", "db-cache"]);
      expect(uuids("/databases", "2")).toEqual([]);
      expect(uuids("/services", "1")).toEqual(["svc-analytics"]);
      expect(uuids("/servers", "1")).toEqual(["srv-edge", "srv-build"]);
      expect(uuids("/projects", "1")).toEqual(["p-web"]);
      expect(uuids("/projects", "2")).toEqual(["p-lab"]);
      // with no team chosen there is no list at all
      expect(() => view().route("/applications", overlayOf(), true)).toThrow(AgentApiNotFound);
      expect(() => view().route("/projects", overlayOf(), true)).toThrow(AgentApiNotFound);
    });

    it("serves a server's docker cleanup settings, and 404s a server without any", () => {
      expect(sens("/servers/srv-edge/docker-cleanup")).toEqual({ docker_cleanup_frequency: "0 0 * * *", docker_cleanup_threshold: 80, delete_unused_volumes: true, delete_unused_networks: false, force_docker_cleanup: false });
      expect(() => sens("/servers/srv-build/docker-cleanup")).toThrow(AgentApiNotFound);
    });

    it("lists S3 storages of the chosen team with their identity (no key, no secret)", () => {
      const rows = sens("/s3-storages", overlayOf(), "1");
      expect(rows).toEqual([{ id: 1, uuid: "s3-off", name: "offsite", type: "s3", endpoint: "https://s3.example.com", bucket: "acme-backups", region: "eu-central-1" }]);
      expect(JSON.stringify(rows)).not.toMatch(/key|secret/i);
    });
  });

  describe("secretRefs: what the sealed read has to ask for", () => {
    const refs = view("1").secretRefs();

    it("names each class's refs from the rows that say a value exists, and no preview", () => {
      expect(refs.env).toEqual(["env:ev1", "env:ev2", "env:ev4", "env:ev5", "env:ev7", "env:ev8", "env:ev9"]);
      expect(refs.shared_env).toEqual(["shared_env:sh1", "shared_env:sh2", "shared_env:sh3", "shared_env:sh4"]);
      expect(refs.task_command).toEqual(["scheduled_task:tk1", "scheduled_task:tk2"]);
      expect(refs.db_credentials).toEqual(["database:db-pg"]);
      expect(refs.notification).toEqual(["notification:1"]);
    });

    it("asks for compose, Dockerfile and label text, a service's compose and a service's config files (not an application's)", () => {
      expect(refs.service_compose).toEqual(["application:app-web", "application:app-stack", "service:svc-analytics", "file_volume:11"]);
    });

    it("asks for no notification without a team, and only for refs the agent will accept", () => {
      expect(view().secretRefs().notification).toEqual([]);
      const read = secretsRead();
      read.sections.get("env_vars")!.push({ id: 99, uuid: "bad ref;drop", key: "X", is_preview: false, resourceable_type: "App\\Models\\Application", resourceable_id: 7, value_present: true });
      expect(buildAgentView(read, "s").secretRefs().env).not.toContain("env:bad ref;drop");
    });
  });
});
