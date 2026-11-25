import { compareCompleteness, hostOf, hostsOfFqdn, isComplete, logicalVolumeName, volumeBelongsTo, type CoolifySide, type TugraSide } from "./completeness";

const capp = (over: Partial<CoolifySide["applications"][number]> = {}): CoolifySide["applications"][number] => ({
  ref: "ua1", uuid: "ua1", name: "blog", envKeys: 3, domains: ["blog.example.com"], volumes: ["ua1-data"], running: true, ...over,
});
const side = (over: Partial<CoolifySide> = {}): CoolifySide => ({ applications: [capp()], databases: [], services: [], tasks: [], backups: [], notifications: [], ...over });
const tapp = (over: Partial<TugraSide["applications"][number]> = {}): TugraSide["applications"][number] => ({
  id: "a1", name: "blog", sourceRef: null, envKeys: 3, domains: ["blog.example.com"], volumes: ["data"], tasks: [], running: true, ...over,
});
const tugra = (over: Partial<TugraSide> = {}): TugraSide => ({ applications: [tapp()], databases: [], notificationTypes: [], cutover: { "blog.example.com": true, "www.example.com": true }, ...over });
const row = (r: ReturnType<typeof compareCompleteness>, kind: string) => r.rows.find((x) => x.kind === kind)!;

describe("hostOf / hostsOfFqdn", () => {
  it("reduces a URL to its host and drops junk", () => {
    expect(hostOf("https://App.Example.com:443/path?x=1")).toBe("app.example.com");
    expect(hostOf("blog.example.com.")).toBe("blog.example.com");
    expect(hostOf("user:pw@host.example.com")).toBe("host.example.com");
    expect(hostOf("not a host")).toBeNull();
    expect(hostOf("")).toBeNull();
  });
  it("splits Coolify's comma list and de-duplicates", () => {
    expect(hostsOfFqdn("https://a.example.com, http://b.example.com,https://a.example.com/x")).toEqual(["a.example.com", "b.example.com"]);
    expect(hostsOfFqdn(null)).toEqual([]);
  });
});

describe("logicalVolumeName", () => {
  it("strips Coolify's uuid prefix", () => {
    expect(logicalVolumeName("ua1-data", "ua1")).toBe("data");
    expect(logicalVolumeName("ua1_uploads", "ua1")).toBe("uploads");
    expect(logicalVolumeName("other", "ua1")).toBe("other");
  });
  it("databases are named <name>-<uuid>: the engine data volume is Tugra's data", () => {
    expect(logicalVolumeName("postgres-data-ud1", "ud1", true)).toBe("data");
    expect(logicalVolumeName("mongodb-configdb-ud1", "ud1", true)).toBe("mongodb-configdb");
    expect(logicalVolumeName("postgres-data-ud1", "ud1", false)).toBe("postgres-data");
  });
  it("volumeBelongsTo takes uuid first or last, and nothing else", () => {
    for (const v of ["ua1-data", "ua1_data", "postgres-data-ua1", "x_ua1"]) expect(volumeBelongsTo(v, "ua1")).toBe(true);
    for (const v of ["ua10-data", "data-ua10", "other", "ua1"]) expect(volumeBelongsTo(v, "ua1")).toBe(false);
    expect(volumeBelongsTo("anything", "")).toBe(false);
  });
});

describe("compareCompleteness", () => {
  it("is complete when every item has its counterpart", () => {
    const r = compareCompleteness(side(), tugra());
    expect(r.complete).toBe(true);
    expect(r.rows.map((x) => x.kind)).toEqual(["application", "database", "service", "domain", "traffic", "env_keys", "volume", "scheduled_task", "backup", "notification"]);
    expect(row(r, "application")).toMatchObject({ coolify: 1, tugra: 1, missing: [] });
  });

  it("lists a Coolify application Tugra does not have", () => {
    const r = compareCompleteness(side(), tugra({ applications: [] }));
    expect(r.complete).toBe(false);
    expect(row(r, "application").missing).toEqual(["blog"]);
    expect(row(r, "domain").missing).toEqual(["blog.example.com"]);
  });

  it("prefers the recorded Coolify ref over the name", () => {
    const r = compareCompleteness(side(), tugra({ applications: [tapp({ name: "renamed", sourceRef: "ua1" })] }));
    expect(row(r, "application").missing).toEqual([]);
  });

  it("a running Coolify item whose Tugra twin is not running is not complete", () => {
    const r = compareCompleteness(side(), tugra({ applications: [tapp({ running: false })] }));
    expect(row(r, "application").missing).toEqual(["blog (not running)"]);
    expect(r.complete).toBe(false);
    // a Coolify item that was stopped does not need to run in Tugra
    expect(compareCompleteness(side({ applications: [capp({ running: false })] }), tugra({ applications: [tapp({ running: false })] })).complete).toBe(true);
  });

  it("compares domains by host, case-insensitively, and reports the hostnames that did not come across", () => {
    const r = compareCompleteness(side({ applications: [capp({ domains: ["blog.example.com", "www.example.com"] })] }), tugra({ applications: [tapp({ domains: ["https://BLOG.example.com/"] })] }));
    expect(row(r, "domain")).toMatchObject({ coolify: 2, tugra: 1, missing: ["www.example.com"] });
  });

  it("fewer variable names in Tugra is missing; more is fine", () => {
    expect(row(compareCompleteness(side(), tugra({ applications: [tapp({ envKeys: 2 })] })), "env_keys")).toMatchObject({ coolify: 3, tugra: 2, missing: ["blog"] });
    expect(compareCompleteness(side(), tugra({ applications: [tapp({ envKeys: 9 })] })).complete).toBe(true);
  });

  it("volumes: a missing one is named by its logical name; an unreadable list can never be complete", () => {
    const miss = compareCompleteness(side(), tugra({ applications: [tapp({ volumes: [] })] }));
    expect(row(miss, "volume").missing).toEqual(["blog/data"]);
    const unread = compareCompleteness(side({ applications: [capp({ volumes: null })] }), tugra());
    expect(row(unread, "volume").unreadable).toBe(true);
    expect(unread.complete).toBe(false);
    expect(isComplete(unread.rows)).toBe(false);
  });

  it("databases and services (compose apps) are matched like applications", () => {
    const c = side({
      databases: [{ ref: "ud1", uuid: "ud1", name: "main-db", envKeys: 0, volumes: ["ud1-data"], running: true }],
      services: [{ ref: "us1", uuid: "us1", name: "plausible", envKeys: 2, volumes: [], running: true }],
    });
    const none = compareCompleteness(c, tugra());
    expect(row(none, "database").missing).toEqual(["main-db"]);
    expect(row(none, "service").missing).toEqual(["plausible"]);
    const ok = compareCompleteness(c, tugra({ applications: [tapp(), tapp({ id: "a2", name: "plausible", envKeys: 2, volumes: [] })], databases: [{ id: "d1", name: "main-db", sourceRef: null, volumes: ["data"], backupEnabled: false, running: true }] }));
    expect(ok.complete).toBe(true);
  });

  it("scheduled tasks are matched by owner and name", () => {
    const c = side({ tasks: [{ name: "nightly", owner: "blog" }] });
    expect(row(compareCompleteness(c, tugra()), "scheduled_task").missing).toEqual(["blog/nightly"]);
    expect(row(compareCompleteness(c, tugra({ applications: [tapp({ tasks: ["Nightly"] })] })), "scheduled_task").missing).toEqual([]);
  });

  it("an enabled Coolify backup needs the Tugra database to have backups on", () => {
    const dbs = (backupEnabled: boolean) => [{ id: "d1", name: "main-db", sourceRef: null, volumes: [], backupEnabled, running: true }];
    const c = side({ databases: [{ ref: "ud1", uuid: "ud1", name: "main-db", envKeys: 0, volumes: [], running: true }], backups: ["main-db"] });
    const apps = [tapp()];
    expect(row(compareCompleteness(c, tugra({ applications: apps, databases: dbs(false) })), "backup").missing).toEqual(["main-db"]);
    expect(row(compareCompleteness(c, tugra({ applications: apps, databases: dbs(true) })), "backup").missing).toEqual([]);
  });

  it("notifications: a channel Tugra can send must exist; one it cannot send is shown, never counted", () => {
    const c = side({ notifications: ["email", "discord", "pushover"] });
    const r = compareCompleteness(c, tugra({ notificationTypes: ["discord"] }));
    expect(row(r, "notification")).toMatchObject({ coolify: 2, tugra: 1, missing: ["email"], notCarried: ["pushover"] });
    const ok = compareCompleteness(c, tugra({ notificationTypes: ["discord", "smtp"] }));
    expect(row(ok, "notification").missing).toEqual([]);
    expect(ok.complete).toBe(true);
  });

  describe("traffic: the names must already be served by Tugra", () => {
    it("a domain that does not resolve to Tugra with a valid certificate keeps the checklist closed and names the host", () => {
      const r = compareCompleteness(side(), tugra({ cutover: { "blog.example.com": false } }));
      expect(row(r, "traffic")).toMatchObject({ coolify: 1, tugra: 0, missing: ["blog.example.com"] });
      expect(r.complete).toBe(false);
      expect(r.completeUuids).toEqual([]);
    });
    it("a check that did not run is unreadable, never complete; with no domains there is nothing to check", () => {
      const r = compareCompleteness(side(), tugra({ cutover: undefined }));
      expect(row(r, "traffic").unreadable).toBe(true);
      expect(r.complete).toBe(false);
      expect(compareCompleteness(side({ applications: [capp({ domains: [] })] }), tugra({ cutover: undefined })).complete).toBe(true);
    });
    it("one host of several failing is named, the others still count", () => {
      const r = compareCompleteness(side({ applications: [capp({ domains: ["blog.example.com", "www.example.com"] })] }), tugra({ applications: [tapp({ domains: ["blog.example.com", "www.example.com"] })], cutover: { "blog.example.com": true, "www.example.com": false } }));
      expect(row(r, "traffic")).toMatchObject({ coolify: 2, tugra: 1, missing: ["www.example.com"] });
    });
  });

  describe("completeUuids: only items matched complete one by one", () => {
    const db = { ref: "ud1", uuid: "ud1", name: "main-db", envKeys: 0, volumes: ["postgres-data-ud1"], running: true };
    const tdb = { id: "d1", name: "main-db", sourceRef: null, volumes: ["data"], backupEnabled: true, running: true };
    it("lists every item that is fully matched", () => {
      const r = compareCompleteness(side({ databases: [db] }), tugra({ databases: [tdb] }));
      expect(r.complete).toBe(true);
      expect(r.completeUuids.sort()).toEqual(["ua1", "ud1"]);
    });
    it("a database whose data volume Tugra lacks is not complete, and neither is the app next to it", () => {
      const r = compareCompleteness(side({ databases: [db] }), tugra({ databases: [{ ...tdb, volumes: [] }] }));
      expect(row(r, "volume").missing).toEqual(["main-db/data"]);
      expect(r.completeUuids).toEqual(["ua1"]);
    });
    it("an item whose volume list could not be read is never complete", () => {
      const r = compareCompleteness(side({ databases: [{ ...db, volumes: null }] }), tugra({ databases: [tdb] }));
      expect(r.completeUuids).toEqual(["ua1"]);
      expect(row(r, "volume").unreadable).toBe(true);
    });
    it("an app without its domain, variables or task is not complete; one that is not running where Coolify's was is not complete", () => {
      for (const t of [tapp({ domains: [] }), tapp({ envKeys: 0 }), tapp({ running: false })]) expect(compareCompleteness(side(), tugra({ applications: [t] })).completeUuids).toEqual([]);
      expect(compareCompleteness(side({ tasks: [{ name: "nightly", owner: "blog" }] }), tugra()).completeUuids).toEqual([]);
    });
    it("an item without a uuid is never complete", () => {
      expect(compareCompleteness(side({ applications: [capp({ uuid: "", ref: "x" })] }), tugra()).completeUuids).toEqual([]);
    });
  });

  it("an empty Coolify side with an empty Tugra side is complete (nothing to carry)", () => {
    expect(compareCompleteness(side({ applications: [] }), tugra({ applications: [] })).complete).toBe(true);
  });

  it("isComplete refuses no rows at all", () => {
    expect(isComplete([])).toBe(false);
  });
});
