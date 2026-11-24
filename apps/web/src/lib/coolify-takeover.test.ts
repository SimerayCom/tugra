import { describe, it, expect } from "vitest";
import { allCommands, coolifyVersion, groupByTeam, importHref, statusTone, type ChecklistRow, type CoolifyInventoryData } from "./coolify-takeover";

const DATA: CoolifyInventoryData = {
  v: 1,
  instance: { name: "Acme", fqdn: "https://coolify.example.com", ip: null, image: "ghcr.io/coollabsio/coolify:4.0.0-beta.9" },
  teams: [
    { id: "0", name: "Root", description: null, personal: true, members: 1, notifications: [] },
    { id: "1", name: "Acme", description: null, personal: false, members: 2, notifications: [{ channel: "discord", enabled: true, configured: true }] },
  ],
  servers: [
    { id: "0", uuid: "u0", name: "localhost", description: null, ip: "host.docker.internal", port: 22, user: "root", teamId: "0", isLocal: true, reachable: true, usable: true, buildServer: false, swarm: false, keyName: null, apps: 0, databases: 0, services: 0 },
    { id: "1", uuid: "u1", name: "edge", description: null, ip: "198.51.100.7", port: 22, user: "root", teamId: "1", isLocal: false, reachable: true, usable: true, buildServer: false, swarm: false, keyName: null, apps: 1, databases: 1, services: 0 },
  ],
  projects: [{ id: "1", uuid: "p1", name: "Website", description: null, teamId: "1", environments: [] }],
  applications: [
    { id: "7", uuid: "a", name: "web", fqdn: "https://www.example.com", gitRepository: null, gitBranch: null, buildPack: null, image: null, status: "running:healthy", envCount: 2, previewEnvCount: 0, hasCompose: false, teamId: "1", projectId: "1", environment: "production", serverId: "1" },
  ],
  databases: [{ id: "3", uuid: "d", name: "db", type: "postgresql", image: "postgres:16", status: "exited", isPublic: false, teamId: "1", projectId: "1", environment: "production", serverId: "1" }],
  services: [{ id: "5", uuid: "s", name: "stray", kind: "plausible", components: 1, envCount: 0, teamId: null, projectId: null, environment: null, serverId: null }],
  sharedVariables: [{ scope: "team", teamId: "1", projectId: null, environment: null, key: "REGION" }],
  scheduledTasks: [],
  backups: [],
  storages: [],
  gitSources: [],
  unavailable: [],
};

describe("groupByTeam", () => {
  it("groups servers, projects and resources under their Coolify team, apps before databases", () => {
    const groups = groupByTeam(DATA);
    const acme = groups.find((g) => g.team?.name === "Acme")!;
    expect(acme.servers.map((s) => s.name)).toEqual(["edge"]);
    expect(acme.projects).toHaveLength(1);
    expect(acme.projects[0].name).toBe("Website");
    expect(acme.projects[0].items.map((i) => [i.kind, i.name, i.server])).toEqual([["application", "web", "edge"], ["database", "db", "edge"]]);
    expect(acme.sharedVariables.map((v) => v.key)).toEqual(["REGION"]);
  });

  it("puts a resource that sits in no team into a team-less group instead of dropping it", () => {
    const none = groupByTeam(DATA).find((g) => g.team === null)!;
    expect(none.projects[0].items.map((i) => i.name)).toEqual(["stray"]);
  });

  it("keeps an empty team (a team with nothing in it is still part of the inventory)", () => {
    expect(groupByTeam(DATA).some((g) => g.team?.name === "Root")).toBe(true);
  });
});

describe("helpers", () => {
  it("reads the Coolify version from the image tag", () => {
    expect(coolifyVersion("ghcr.io/coollabsio/coolify:4.0.0-beta.9")).toBe("4.0.0-beta.9");
    expect(coolifyVersion("ghcr.io/coollabsio/coolify")).toBeNull();
    expect(coolifyVersion(null)).toBeNull();
  });

  it("carries the Coolify address into the import, only when it is a plain http(s) address", () => {
    expect(importHref("https://coolify.example.com")).toBe("/import?url=https%3A%2F%2Fcoolify.example.com");
    expect(importHref("https://a.example.com, https://b.example.com")).toBe("/import?url=https%3A%2F%2Fa.example.com");
    expect(importHref("javascript:alert(1)")).toBe("/import");
    expect(importHref(null)).toBe("/import");
  });

  it("maps Coolify status strings to a tone", () => {
    expect(statusTone("running:healthy")).toBe("ok");
    expect(statusTone("running:unhealthy")).toBe("warn");
    expect(statusTone("exited:unhealthy")).toBe("warn");
    expect(statusTone(null)).toBe("muted");
  });

  it("joins the pending commands with a comment saying where to run each", () => {
    const row = (name: string, state: ChecklistRow["state"], cmd: string | null): ChecklistRow => ({
      coolifyServerId: name, name, ip: "203.0.113.1", port: 22, user: "root", state, teamId: "t", tugraServerId: "s", installCommand: cmd, expiresAt: null, ssh: `ssh root@${name}`,
    });
    const text = allCommands([row("a", "waiting", "curl a | sh"), row("b", "already_added", null), row("c", "waiting", "curl c | sh")]);
    expect(text).toBe("# a (ssh root@a)\ncurl a | sh\n\n# c (ssh root@c)\ncurl c | sh");
  });
});
