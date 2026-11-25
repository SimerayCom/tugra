import { buildReport, reportOk, type ReportDb, type ReportFacts } from "./project-move-report";

const db = (over: Partial<ReportDb> = {}): ReportDb => ({
  sourceId: "d1", name: "main", configOnly: false, target: { status: "RUNNING", serverId: "s2" }, restoreOk: true, relinked: true, source: { status: "STOPPED" }, setAside: true, ...over,
});
const facts = (over: Partial<ReportFacts> = {}): ReportFacts => ({
  targetServerId: "s2",
  targetIp: "5.6.7.8",
  apps: [{ id: "a1", name: "web", serverId: "s2", status: "RUNNING", wasRunning: true, hostnames: ["Web.Example.com"] }],
  dbs: [db()],
  repointDns: false,
  retainDays: 7,
  warnings: [],
  ...over,
});
const failing = (f: ReportFacts) => buildReport(f).checks.filter((c) => !c.ok).map((c) => `${c.code}:${c.name}`);

describe("buildReport", () => {
  it("a good move has every check green and the DNS step listed", () => {
    const r = buildReport(facts());
    expect(reportOk(r)).toBe(true);
    expect(r.checks.map((c) => c.code)).toEqual(["app_running", "db_running", "db_restored", "db_relinked", "source_stopped", "safety_copy_kept"]);
    expect(r.dns).toEqual([{ hostname: "web.example.com", targetIp: "5.6.7.8", repointed: false }]);
  });

  it("an app that is not on the target, or was running and is not, fails", () => {
    expect(failing(facts({ apps: [{ id: "a1", name: "web", serverId: "s1", status: "RUNNING", wasRunning: true, hostnames: [] }] }))).toEqual(["app_running:web"]);
    expect(failing(facts({ apps: [{ id: "a1", name: "web", serverId: "s2", status: "STOPPED", wasRunning: true, hostnames: [] }] }))).toEqual(["app_running:web"]);
    expect(failing(facts({ apps: [{ id: "a1", name: "web", serverId: "s2", status: "STOPPED", wasRunning: false, hostnames: [] }] }))).toEqual([]);
  });

  it("a database copy that is not running, not restored, not relinked or whose source is still running fails each on its own line", () => {
    expect(failing(facts({ dbs: [db({ target: { status: "FAILED", serverId: "s2" } })] }))).toEqual(["db_running:main"]);
    expect(failing(facts({ dbs: [db({ restoreOk: false })] }))).toEqual(["db_restored:main"]);
    expect(failing(facts({ dbs: [db({ relinked: false })] }))).toEqual(["db_relinked:main"]);
    expect(failing(facts({ dbs: [db({ source: { status: "RUNNING" } })] }))).toEqual(["source_stopped:main"]);
    expect(failing(facts({ dbs: [db({ target: { status: "RUNNING", serverId: "s1" } })] }))).toEqual(["db_running:main"]);
  });

  it("a safety copy that is gone fails while retention is on; with retention 0 it is not expected", () => {
    expect(failing(facts({ dbs: [db({ setAside: false })] }))).toEqual(["safety_copy_kept:main"]);
    expect(buildReport(facts({ dbs: [db({ setAside: false })], retainDays: 0 })).checks.some((c) => c.code === "safety_copy_kept")).toBe(false);
  });

  it("a config-only database is checked for running on the target and nothing else", () => {
    const r = buildReport(facts({ dbs: [db({ configOnly: true, source: null, setAside: false, restoreOk: true })] }));
    expect(r.checks.filter((c) => c.itemRef === "d1").map((c) => c.code)).toEqual(["db_running"]);
  });

  it("a config-only database may still be NEW on the target, but not on the source server", () => {
    const base = { configOnly: true, source: null, setAside: false };
    expect(failing(facts({ dbs: [db({ ...base, target: { status: "NEW", serverId: "s2" } })] }))).toEqual([]);
    expect(failing(facts({ dbs: [db({ ...base, target: { status: "NEW", serverId: "s1" } })] }))).toEqual(["db_running:main"]);
    expect(failing(facts({ dbs: [db({ ...base, target: { status: "FAILED", serverId: "s2" } })] }))).toEqual(["db_running:main"]);
  });

  it("lists each hostname once, lower-cased, and marks it repointed when the move repointed DNS", () => {
    const r = buildReport(facts({ repointDns: true, apps: [{ id: "a1", name: "web", serverId: "s2", status: "RUNNING", wasRunning: true, hostnames: ["A.example.com", "a.example.com", " "] }, { id: "a2", name: "api", serverId: "s2", status: "RUNNING", wasRunning: true, hostnames: ["a.example.com", "b.example.com"] }] }));
    expect(r.dns.map((d) => d.hostname)).toEqual(["a.example.com", "b.example.com"]);
    expect(r.dns.every((d) => d.repointed)).toBe(true);
  });
});
