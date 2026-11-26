import { AgentApiNotFound, buildAgentView } from "./agent-coolify.mapper";
import { fixtureRead } from "../__fixtures__/agent-coolify.fixture";
import { isSensitiveVisible } from "./coolify-sensitive";

const view = () => buildAgentView(fixtureRead(), "srv-agent");
const get = (path: string) => view().route(path) as any;

describe("agent read to API shape", () => {
  it("answers the paths the importer reads, and 404s (status 404) any other", () => {
    for (const p of ["/servers", "/applications", "/databases", "/services", "/projects", "/s3-storages", "/servers/srv-edge", "/servers/srv-edge/resources", "/applications/app-web", "/applications/app-web/envs", "/applications/app-web/storages", "/databases/db-pg/storages", "/databases/db-pg/backups", "/services/svc-analytics", "/projects/p-web"]) {
      expect(() => view().route(p)).not.toThrow();
    }
    for (const p of ["/teams/current", "/team/envs", "/notifications/discord", "/applications/nope", "/services/svc-analytics/envs", "/services/svc-analytics/storages", "/anything", "/servers/nope/resources"]) {
      try {
        view().route(p);
        throw new Error(`served ${p}`);
      } catch (e) {
        expect(e).toBeInstanceOf(AgentApiNotFound);
        expect((e as AgentApiNotFound).status).toBe(404);
        expect((e as Error).message).toMatch(/^404 /);
      }
    }
  });

  it("never serves a value: an env row has a name and flags, a secret column is only its presence", () => {
    const text = JSON.stringify([get("/applications"), get("/applications/app-web/envs"), get("/databases"), get("/services/svc-analytics")]);
    expect(text).not.toMatch(/value|password|secret|enc:|_present/i);
    expect(get("/applications/app-web/envs").every((e: any) => !("value" in e) && !("real_value" in e))).toBe(true);
  });

  it("holds back text that can carry a secret, and keeps only that it exists", () => {
    const web = get("/applications/app-web");
    expect(web).not.toHaveProperty("custom_labels");
    expect(web).not.toHaveProperty("pre_deployment_command");
    expect(web.presence).toEqual({ custom_labels: true, pre_deployment_command: true });
    // present-but-empty is the API's "visible but empty": null, not hidden
    expect(web.custom_docker_run_options).toBeNull();
    expect(web.dockerfile).toBeNull();
    expect(get("/applications/app-img").presence).toEqual({ custom_docker_run_options: true });
    expect(get("/databases/db-pg").presence).toEqual({ postgres_conf: true });
    expect(get("/databases/db-pg")).not.toHaveProperty("postgres_conf");
    // a row whose text is held back still reads as a sensitive-capable row (no false "token cannot read" warning)
    expect(isSensitiveVisible(get("/databases/db-pg"), "database")).toBe(true);
    expect(isSensitiveVisible(get("/applications/app-web"), "application")).toBe(true);
  });

  it("places each resource on the server its Docker destination belongs to", () => {
    expect(get("/servers/srv-edge/resources").map((r: any) => r.uuid)).toEqual(["app-web", "app-stack", "app-site", "db-pg", "svc-analytics"]);
    expect(get("/servers/srv-build/resources").map((r: any) => r.uuid)).toEqual(["app-img", "db-cache"]);
    expect(get("/servers/srv-local/resources")).toEqual([]);
  });

  it("the Coolify host is the row with id 0, and only the OS fields of the server metadata are kept", () => {
    expect(get("/servers/srv-local").is_coolify_host).toBe(true);
    expect(get("/servers/srv-edge")).toMatchObject({ is_coolify_host: false, unreachable_count: 3, server_metadata: { os: "Ubuntu", os_release: "24.04" } });
    expect(JSON.stringify(get("/servers/srv-edge"))).not.toContain("cpus");
  });

  it("keeps the env flags the plan reads, including the old column name and the preview twin", () => {
    const read = fixtureRead();
    read.sections.set("env_vars", [{ id: 1, key: "OLD", is_build_time: true, is_runtime: false, is_preview: false, resourceable_type: "App\\Models\\Application", resourceable_id: 7 }]);
    const envs = buildAgentView(read, "s").route("/applications/app-web/envs") as any[];
    expect(envs).toEqual([{ key: "OLD", is_buildtime: true, is_runtime: false, is_preview: false }]);
    expect(get("/applications/app-web/envs").filter((e: any) => e.is_preview)).toHaveLength(1);
    expect(get("/applications/app-web/envs").find((e: any) => e.key === "TOKEN").is_shown_once).toBe(true);
  });

  it("does not claim a variable is a shared reference: that cannot be known without decrypting it", () => {
    expect(get("/applications/app-web/envs").some((e: any) => "is_shared" in e)).toBe(false);
  });

  it("reads the project tree with the Coolify team of each project, and only the teams that have environments", () => {
    expect(get("/projects/p-web")).toMatchObject({ team: { id: "1", name: "Acme" }, environments: [{ id: 10, name: "production" }, { id: 11, name: "staging" }] });
    expect(view().teams).toEqual([{ ref: "1", name: "Acme" }, { ref: "2", name: "Beta Labs" }]);
  });

  it("names the Coolify team of each server when the read has its team row, and leaves it out when it does not", () => {
    expect(get("/servers/srv-edge").team).toEqual({ id: "1", name: "Acme" });
    expect(get("/servers").find((x: any) => x.uuid === "srv-build").team).toEqual({ id: "1", name: "Acme" });
    const read = fixtureRead();
    read.sections.set("servers", [{ id: 9, uuid: "srv-x", name: "x", ip: "198.51.100.9", team_id: 77 }]);
    expect(buildAgentView(read, "s").route("/servers/srv-x")).not.toHaveProperty("team");
  });

  it("a service's members come with the detail only (as on the API), minus none the compose dropped is kept flagged", () => {
    expect(get("/services")[0]).not.toHaveProperty("applications");
    const detail = get("/services/svc-analytics");
    expect(detail.applications.map((a: any) => [a.uuid, a.is_removed_from_compose === true])).toEqual([["sa-1", false], ["sa-old", true]]);
    expect(detail.databases.map((d: any) => d.uuid)).toEqual(["sd-1", "sd-2"]);
  });

  it("names the database engine the way the API does, and drops the section constant", () => {
    expect(get("/databases").map((d: any) => d.database_type)).toEqual(["standalone-postgresql", "standalone-redis"]);
    expect(get("/databases").some((d: any) => "type" in d)).toBe(false);
  });

  it("the meta is counts and versions only: no name, no address, no value", () => {
    const m = view().meta;
    expect(m).toMatchObject({ transport: "agent", agentServerId: "srv-agent", counts: { teams: 3, projects: 2, servers: 3, applications: 4, databases: 2, services: 1 }, schemaVersion: "2025_11_20_000000_add_something" });
    expect(m.secretCounts).toMatchObject({ env: 4, db_credentials: 1, s3: 2, service_compose: 1, deploy_key: 2 });
    expect(JSON.stringify(m)).not.toMatch(/example|198\.51|NODE_ENV|acme/i);
  });

  it("reads the version from the image tag, and nothing when it is a digest or has no tag", () => {
    expect(view().versionText()).toBe("4.0.0-beta.463");
    expect(buildAgentView(fixtureRead({ image: "ghcr.io/coollabsio/coolify@sha256:abc" }), "s").versionText()).toBeNull();
    expect(buildAgentView(fixtureRead({ image: "coolify:latest" }), "s").versionText()).toBeNull();
    expect(buildAgentView(fixtureRead({ image: null }), "s").versionText()).toBeNull();
  });

  it("warns when a section hit its row cap or a core table is missing, and stays quiet otherwise", () => {
    expect(view().warnings).toEqual([]);
    const w = buildAgentView(fixtureRead({ truncated: ["env_vars"], skipped: ["applications"] }), "s").warnings.join("\n");
    expect(w).toMatch(/row limit for env_vars/);
    expect(w).toMatch(/no applications table/);
  });

  it("an empty read still answers every list (an instance with nothing in it)", () => {
    const v = buildAgentView(fixtureRead({ sections: new Map() }), "s");
    expect(v.route("/servers")).toEqual([]);
    expect(v.route("/applications")).toEqual([]);
    expect(v.teams).toEqual([]);
    expect(v.meta.counts).toEqual({ teams: 0, projects: 0, servers: 0, applications: 0, databases: 0, services: 0 });
  });
});
