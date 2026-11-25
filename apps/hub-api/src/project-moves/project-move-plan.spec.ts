import { planProjectMove, resolveSource, SELF_RESOLVED_APP_BLOCKERS, type PlanApp, type PlanDb, type PlanInput } from "./project-move-plan";

const app = (over: Partial<PlanApp> = {}): PlanApp => ({ id: "a1", name: "web", serverId: "s1", status: "RUNNING", linkedDbIds: [], ...over });
const db = (over: Partial<PlanDb> = {}): PlanDb => ({ id: "d1", name: "main", engine: "POSTGRES", serverId: "s1", status: "RUNNING", backupDestinationId: "dest1", extraVolumes: 0, pitrEnabled: false, outsideLinkedApps: [], ...over });
const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  sourceServerId: "s1",
  targetServerId: "s2",
  apps: [app()],
  dbs: [db()],
  agentOnline: { source: true, target: true },
  serversReady: { source: true, target: true },
  backupEngines: new Set(["POSTGRES", "MYSQL"]),
  activeProjectMove: false,
  appPreflight: {},
  appsWithActiveMove: new Set(),
  ...over,
});
const codes = (i: PlanInput) => planProjectMove(i).blockers.map((b) => b.code);

describe("resolveSource", () => {
  it("takes the named server, else the only one the items sit on", () => {
    expect(resolveSource("s9", [], [])).toEqual({ serverId: "s9", several: false });
    expect(resolveSource(undefined, [{ serverId: "s1" }], [{ serverId: "s1" }])).toEqual({ serverId: "s1", several: false });
  });
  it("items on several servers need the source named", () => {
    expect(resolveSource(undefined, [{ serverId: "s1" }], [{ serverId: "s3" }])).toEqual({ serverId: null, several: true });
    expect(resolveSource(undefined, [], [])).toEqual({ serverId: null, several: false });
  });
});

describe("planProjectMove", () => {
  it("a clean project plans databases first, then applications, and has no blocker", () => {
    const p = planProjectMove(input({ apps: [app(), app({ id: "a2", name: "worker" })], dbs: [db(), db({ id: "d2", name: "cache", engine: "MYSQL" })] }));
    expect(p.blockers).toEqual([]);
    expect(p.items.map((i) => `${i.kind}:${i.name}`)).toEqual(["database:main", "database:cache", "application:web", "application:worker"]);
    expect(p.items.map((i) => i.order)).toEqual([0, 1, 2, 3]);
  });

  it("moves only the items on the source and says what is left behind", () => {
    const p = planProjectMove(input({ apps: [app(), app({ id: "a2", name: "elsewhere", serverId: "s9" })], dbs: [] }));
    expect(p.items.map((i) => i.name)).toEqual(["web"]);
    expect(p.warnings).toEqual([{ code: "items_left_behind" }]);
  });

  it("refuses the same server, an empty project, an unknown source and a move already running", () => {
    expect(codes(input({ targetServerId: "s1" }))).toContain("same_server");
    expect(codes(input({ apps: [], dbs: [] }))).toContain("empty_project");
    expect(codes(input({ sourceServerId: null }))).toContain("items_on_several_servers");
    expect(codes(input({ activeProjectMove: true }))).toContain("project_move_active");
  });

  it("both ends need an agent online and a ready server", () => {
    expect(codes(input({ agentOnline: { source: false, target: true } }))).toEqual(["agent_offline_source"]);
    expect(codes(input({ agentOnline: { source: true, target: false } }))).toEqual(["agent_offline_target"]);
    expect(codes(input({ serversReady: { source: true, target: false } }))).toEqual(["server_not_ready"]);
  });

  it("a database needs a backup engine, an S3 destination, no extra volumes and no app outside the project linked to it", () => {
    expect(codes(input({ dbs: [db({ engine: "LIBSQL" })] }))).toEqual(["db_engine_unsupported"]);
    expect(codes(input({ dbs: [db({ backupDestinationId: null })] }))).toEqual(["db_needs_s3_destination"]);
    // extra volumes are carried now: a warning, never a blocker
    expect(codes(input({ dbs: [db({ extraVolumes: 2 })] }))).toEqual([]);
    expect(planProjectMove(input({ dbs: [db({ extraVolumes: 2 })] })).warnings).toContainEqual({ code: "db_extra_volumes_carried", ref: "main" });
    expect(codes(input({ dbs: [db({ outsideLinkedApps: ["other-app"] })] }))).toEqual(["db_linked_outside"]);
    expect(codes(input({ dbs: [db({ outsideLinkedApps: ["a1"] })] }))).toEqual([]); // linked only by an app of the same project
  });

  it("a database that is not running (and not new) blocks; one never deployed moves its configuration only", () => {
    expect(codes(input({ dbs: [db({ status: "FAILED" })] }))).toEqual(["db_not_ready"]);
    expect(codes(input({ dbs: [db({ status: "STOPPED" })] }))).toEqual(["db_not_ready"]);
    const p = planProjectMove(input({ dbs: [db({ status: "NEW", backupDestinationId: null, engine: "LIBSQL" })] }));
    expect(p.blockers).toEqual([]);
    expect(p.items[0]).toMatchObject({ kind: "database", configOnly: true });
    expect(p.warnings).toContainEqual({ code: "db_config_only", ref: "main" });
  });

  it("point-in-time recovery does not travel: a warning, not a blocker", () => {
    const p = planProjectMove(input({ dbs: [db({ pitrEnabled: true })] }));
    expect(p.blockers).toEqual([]);
    expect(p.warnings).toContainEqual({ code: "pitr_not_carried", ref: "main" });
  });

  it("an app's own preflight blockers come through, minus the two the project move resolves itself", () => {
    const p = planProjectMove(input({ appPreflight: { a1: ["db_links_exist", "db_network", "target_volume_exists"] } }));
    expect(p.blockers).toEqual([{ code: "app_preflight_failed", ref: "web", codes: ["target_volume_exists"] }]);
    expect(codes(input({ appPreflight: { a1: [...SELF_RESOLVED_APP_BLOCKERS] } }))).toEqual([]);
  });

  it("an app that already has a move running blocks", () => {
    expect(codes(input({ appsWithActiveMove: new Set(["a1"]) }))).toEqual(["app_move_active"]);
  });

  it("an app that uses a database gets the redeploy warning", () => {
    expect(planProjectMove(input({ apps: [app({ linkedDbIds: ["d1"] })] })).warnings).toContainEqual({ code: "app_redeploy_after_relink", ref: "web" });
  });
});
