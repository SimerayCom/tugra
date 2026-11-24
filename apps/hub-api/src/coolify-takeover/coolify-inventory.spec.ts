import { buildInventory, CoolifyReadError, parseRead, scrubText } from "./coolify-inventory";
import { CFY } from "./coolify-read-script";
import { fixtureOutput, SECTION_ROWS } from "./coolify-fixture";

const inv = () => buildInventory(parseRead(fixtureOutput()));

describe("parseRead", () => {
  it("maps each failure marker to a typed error", () => {
    expect(() => parseRead(CFY.noDocker)).toThrow(CoolifyReadError);
    expect(() => parseRead(CFY.noCoolify)).toThrow("no_coolify");
    expect(() => parseRead(CFY.stopped)).toThrow("db_stopped");
    expect(() => parseRead("garbage")).toThrow("unreadable");
  });

  it("refuses output unless the database confirmed a read-only session", () => {
    expect(() => parseRead(fixtureOutput({ ro: "off" }))).toThrow("not_read_only");
    expect(() => parseRead(fixtureOutput({ ro: "" }))).toThrow("not_read_only");
  });

  it("needs the end marker (a truncated stream is not a read)", () => {
    expect(() => parseRead(fixtureOutput().replace(CFY.done, ""))).toThrow("unreadable");
  });

  it("tolerates a section with garbage or an error body", () => {
    const out = fixtureOutput({ sections: { teams: [], servers: [] } }).replace("[]", "not json");
    expect(parseRead(out).sections.get("teams")).toEqual([]);
  });
});

describe("buildInventory", () => {
  it("builds the whole tree: teams, projects, environments, servers and resources", () => {
    const { data, counts } = inv();
    expect(counts).toMatchObject({ teams: 2, servers: 3, projects: 1, applications: 1, databases: 2, services: 1, sharedVariables: 2, scheduledTasks: 1, backups: 1, storages: 1 });
    expect(data.instance).toEqual({ name: "Acme", fqdn: "https://coolify.example.com", ip: "203.0.113.5", image: "ghcr.io/coollabsio/coolify:4.0.0-beta.999" });
    const acme = data.teams.find((t) => t.name === "Acme")!;
    expect(acme.members).toBe(2);
    expect(data.projects[0].environments.map((e) => e.name)).toEqual(["production", "staging"]);
  });

  it("places a resource in its team, project, environment and server through the Coolify ids", () => {
    const { data } = inv();
    const app = data.applications[0];
    expect(app).toMatchObject({ teamId: "1", projectId: "1", environment: "production", serverId: "1", envCount: 2, previewEnvCount: 1 });
    const cache = data.databases.find((d) => d.name === "cache")!;
    expect(cache).toMatchObject({ type: "redis", environment: "staging", isPublic: true });
    expect(data.services[0]).toMatchObject({ components: 3, envCount: 1, serverId: "1" });
  });

  it("marks the built-in localhost server and counts what runs on each server", () => {
    const { data } = inv();
    const local = data.servers.find((s) => s.name === "localhost")!;
    expect(local.isLocal).toBe(true);
    const edge = data.servers.find((s) => s.name === "edge")!;
    expect(edge).toMatchObject({ isLocal: false, port: 2222, user: "deploy", apps: 1, databases: 2, services: 1, keyName: "edge key" });
    expect(data.servers.find((s) => s.name === "builder")!.buildServer).toBe(true);
  });

  it("summarises notification settings per team, with no webhook address", () => {
    const { data } = inv();
    expect(data.teams.find((t) => t.id === "0")!.notifications).toEqual([{ channel: "email", enabled: true, configured: true }]);
    expect(data.teams.find((t) => t.id === "1")!.notifications).toEqual([{ channel: "discord", enabled: true, configured: true }]);
  });

  it("keeps shared variable names only, scoped to their team or environment", () => {
    const { data } = inv();
    expect(data.sharedVariables).toEqual([
      { scope: "environment", teamId: "1", projectId: "1", environment: "staging", key: "STAGE" },
      { scope: "team", teamId: "1", projectId: null, environment: null, key: "REGION" },
    ]);
  });

  it("resolves tasks, backups and storages against what was read", () => {
    const { data } = inv();
    expect(data.scheduledTasks[0]).toMatchObject({ name: "nightly", target: "application", targetName: "web" });
    expect(data.backups[0]).toMatchObject({ databaseType: "postgresql", databaseName: "web-db", toS3: true, s3Name: "offsite", teamId: "1" });
    expect(data.storages[0]).toMatchObject({ name: "offsite", hasKeys: true });
  });

  it("records the sections an older Coolify does not have", () => {
    const { data } = buildInventory(parseRead(fixtureOutput({ skip: ["notify_slack", "not_a_section"] })));
    expect(data.unavailable).toEqual(["notify_slack"]);
  });

  it("never carries a secret: a hostile row cannot smuggle one into the stored inventory", () => {
    const hostile = structuredClone(SECTION_ROWS) as Record<string, Array<Record<string, unknown>>>;
    hostile.applications[0].git_repository = "https://deploy:ghp_SECRETTOKEN@github.com/acme/web.git";
    hostile.applications[0].fqdn = "https://u:pw123@www.example.com";
    hostile.applications[0].private_key = "-----BEGIN OPENSSH PRIVATE KEY-----ZZZ";
    hostile.applications[0].value = "super-secret-value";
    hostile.s3[0].secret = "s3-secret-key";
    hostile.s3[0].endpoint = "https://AKIAKEY:sekret@s3.example.com";
    hostile.servers[1].private_key = "-----BEGIN OPENSSH PRIVATE KEY-----YYY";
    hostile.teams[1].discord_webhook_url = "https://discord.com/api/webhooks/1/abcdef";
    const { data } = buildInventory(parseRead(fixtureOutput({ sections: hostile })));
    const text = JSON.stringify(data);
    for (const s of ["SECRETTOKEN", "pw123", "OPENSSH", "super-secret-value", "s3-secret-key", "sekret", "AKIAKEY", "webhooks/1/abcdef"]) expect(text).not.toContain(s);
    expect(data.applications[0].gitRepository).toBe("https://github.com/acme/web.git");
  });

  it("bounds oversized text", () => {
    const rows = structuredClone(SECTION_ROWS) as Record<string, Array<Record<string, unknown>>>;
    rows.applications[0].name = "x".repeat(5000);
    const { data } = buildInventory(parseRead(fixtureOutput({ sections: rows })));
    expect(data.applications[0].name.length).toBe(160);
  });
});

describe("scrubText", () => {
  it("strips credentials from every URL in the text", () => {
    expect(scrubText("a https://u:p@h.example.com/x, ssh://git:tok@h2/y")).toBe("a https://h.example.com/x, ssh://h2/y");
    expect(scrubText(null)).toBeNull();
  });
});
