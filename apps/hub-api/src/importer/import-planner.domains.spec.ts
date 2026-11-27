import { planImport } from "./import-planner";
import type { ForeignApp, ForeignFleet } from "./foreign-fleet";

const fleetOf = (app: Partial<ForeignApp>): ForeignFleet => ({
  servers: [{ ref: "s1", name: "box" }],
  apps: [{ sourceRef: "a1", name: "web", kind: "git", buildPack: "nixpacks", serverRef: "s1", git: { url: "https://git/x", branch: "main" }, ...app }],
  databases: [],
  services: [],
  volumes: [],
  sharedEnv: [],
  warnings: [],
});
const note = (app: Partial<ForeignApp>) => planImport(fleetOf(app), { sourceKind: "coolify" }).items[0].risks.find((r) => r.code === "app.domain.multi");

describe("the note for an app with several hostnames says what the apply really does", () => {
  it("three hostnames: all carried, no 'add the rest by hand', the primary is the one the create step picks", () => {
    const n = note({ domains: [{ host: "a.com", primary: true }, { host: "b.com" }, { host: "c.com" }] })!;
    expect(n.level).toBe("info");
    expect(n.message).toContain('"a.com" is the primary');
    expect(n.message).toContain("2 more are added");
    expect(n.message).not.toMatch(/add the rest/);
  });

  it("names the primary the way the create step does: the domain marked primary, not the first", () => {
    expect(note({ domains: [{ host: "a.com" }, { host: "b.com", primary: true }] })!.message).toContain('"b.com" is the primary');
  });

  it("the www or bare counterpart of the primary is served already and is not reported as lost", () => {
    const n = note({ domains: [{ host: "a.com", primary: true }, { host: "www.a.com" }] })!;
    expect(n.level).toBe("info");
    expect(n.message).not.toMatch(/cannot be carried/);
  });

  it("a hostname the apply cannot carry is named, and the note is a warning", () => {
    const n = note({ domains: [{ host: "a.com", primary: true, port: 3000 }, { host: "b.com", port: 8080 }, { host: "c.com", port: 3000 }] })!;
    expect(n.level).toBe("warn");
    expect(n.message).toContain("1 cannot be carried (b.com)");
    expect(n.message).toContain("2 domains".replace("2", "3"));
  });

  it("a compose app: its per-service hostnames are carried as service domains", () => {
    const n = note({ kind: "compose", buildPack: "dockercompose", git: undefined, composeFile: "services: {}", domains: [{ host: "a.com", serviceRef: "web", port: 80 }, { host: "b.com", serviceRef: "api", port: 3000 }] })!;
    expect(n.message).toContain("1 more is added");
    expect(n.level).toBe("info");
  });

  it("one hostname has no such note", () => {
    expect(note({ domains: [{ host: "a.com", primary: true }] })).toBeUndefined();
  });
});
