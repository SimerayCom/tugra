import { describe, it, expect } from "vitest";
import { grantLive, isConsentRequired, isReadByImport, missingForApply, needsConsent, canAnswer, candidateServers, classCount, consentReady, defaultClasses, evidenceLines, matchRows, needsMatchStep, standingConsent, unsureCount } from "./coolify-agent";
import { agentReadyServers } from "./coolify-agent-connect";
import type { ImportPlan } from "./types";

const plan = (hosts: unknown[], extra: Record<string, unknown> = {}): ImportPlan =>
  ({ sourceKind: "coolify", mode: "copy", items: [], totals: { apps: 0, databases: 0, volumes: 0, blockers: 0 }, warnings: [], planHash: "a".repeat(32), preflight: { databases: [], hosts, ...extra } }) as unknown as ImportPlan;
const READ = { transport: "agent", agentServerId: "s0", schemaVersion: null, coolifyImage: null, readAt: "2026-11-26T00:00:00Z", counts: { teams: 1, projects: 1, servers: 3, applications: 0, databases: 0, services: 0 } };

describe("consent", () => {
  it("ticks the tier-1 classes the import reads and leaves tier 2 (notification tokens) and every class with no reader off", () => {
    const d = defaultClasses();
    expect(d).toEqual(expect.arrayContaining(["env", "shared_env", "db_credentials", "service_compose", "task_command"]));
    for (const off of ["notification", "git_app_key", "deploy_key", "basic_auth", "s3"]) expect(d).not.toContain(off);
  });

  it("knows which classes an import reads (the hub's own list), and which a missing one leaves an apply without", () => {
    for (const c of ["env", "shared_env", "service_compose", "db_credentials", "task_command", "notification"] as const) expect(isReadByImport(c)).toBe(true);
    for (const c of ["basic_auth", "s3", "git_app_key", "deploy_key"] as const) expect(isReadByImport(c)).toBe(false);
    expect(missingForApply(new Set(defaultClasses()))).toEqual([]);
    expect(missingForApply(new Set(["env", "service_compose"]))).toEqual(["shared_env", "db_credentials"]);
  });

  it("a grant is only 'in force' while it is active and its window has not run out", () => {
    const now = Date.parse("2026-11-28T10:00:00Z");
    expect(grantLive({ status: "active", expiresAt: "2026-11-28T10:30:00Z" }, now)).toBe(true);
    expect(grantLive({ status: "active", expiresAt: "2026-11-28T09:59:59Z" }, now)).toBe(false);
    expect(grantLive({ status: "revoked", expiresAt: "2026-11-28T10:30:00Z" }, now)).toBe(false);
    expect(grantLive({ status: "expired", expiresAt: "2026-11-28T10:30:00Z" }, now)).toBe(false);
  });

  it("is the host's name typed EXACTLY (no case folding, no trimming, never empty)", () => {
    expect(consentReady("coolify-host", "coolify-host")).toBe(true);
    for (const typed of ["", "Coolify-host", "coolify-host ", " coolify-host", "coolify", "yes"]) expect(consentReady(typed, "coolify-host")).toBe(false);
    expect(consentReady("", "")).toBe(false);
  });

  it("reads a class count only when the read reports a number", () => {
    expect(classCount({ env: 1240, s3: 2 }, "env")).toBe(1240);
    expect(classCount({ env: 1240 }, "db_credentials")).toBeNull();
    expect(classCount(undefined, "env")).toBeNull();
  });

  it("knows the consent that stands for a session from the plan, ignoring classes it does not know", () => {
    expect(standingConsent(plan([], { agentRead: READ, secretsConsent: { classes: ["env", "s3", "bogus"] } }))).toEqual(["env", "s3"]);
    expect(standingConsent(plan([], { agentRead: READ }))).toBeNull();
    expect(standingConsent(plan([], { secretsConsent: { classes: [] } }))).toBeNull();
    expect(standingConsent(null)).toBeNull();
  });

  it("an agent session needs the consent to stand before an apply; a token session and a standing consent do not", () => {
    expect(needsConsent(plan([], { agentRead: READ }))).toBe(true);
    expect(needsConsent(plan([], { agentRead: READ, secretsConsent: { classes: [] } }))).toBe(true);
    expect(needsConsent(plan([], { agentRead: READ, secretsConsent: { classes: ["env"] } }))).toBe(false);
    expect(needsConsent(plan([]))).toBe(false);
    expect(needsConsent(null)).toBe(false);
  });

  it("knows the hub's 403 consent_required, and only that", () => {
    expect(isConsentRequired({ status: 403, code: "consent_required" })).toBe(true);
    expect(isConsentRequired({ status: 403, code: "not_enabled" })).toBe(false);
    expect(isConsentRequired({ status: 400, code: "consent_required" })).toBe(false);
    expect(isConsentRequired(new Error("x"))).toBe(false);
    expect(isConsentRequired(null)).toBe(false);
  });
});

describe("evidence in plain order", () => {
  it("lists what proves it first, then what suggests it, then what never decides; a conflict is listed too", () => {
    const lines = evidenceLines([
      { kind: "hostname", equal: true },
      { kind: "ip", equal: true },
      { kind: "docker_engine_id", equal: false },
      { kind: "ssh_host_key", equal: true },
    ]);
    expect(lines.map((l) => [l.kind, l.strength, l.equal])).toEqual([
      ["ssh_host_key", "identity", true],
      ["docker_engine_id", "identity", false],
      ["ip", "address", true],
      ["hostname", "weak", true],
    ]);
  });
});

describe("matchRows", () => {
  const hosts = [
    { ref: "b", name: "builder", tugra: { serverId: "t2", name: "builder-1", teamId: "t1", via: "public-ip", confidence: "probable" }, match: { status: "probable", linkedBy: "auto", evidence: [{ kind: "ip", equal: true }] }, agentOnline: true },
    { ref: "e", name: "edge", tugra: { serverId: "t1", name: "edge-1", teamId: "t1", via: "reported-ip", confidence: "certain" }, match: { status: "certain", linkedBy: "auto", evidence: [{ kind: "machine_id", equal: true }, { kind: "docker_engine_id", equal: true }] }, agentOnline: true },
    { ref: "h", name: "localhost", controlPlane: true, tugra: { serverId: "s0", name: "hub-box", teamId: "t1", via: "public-ip", confidence: "certain" }, match: { status: "certain", linkedBy: "auto", evidence: [{ kind: "machine_id", equal: true }] }, agentOnline: true },
    { ref: "x", name: "unsure", match: { status: "ambiguous", linkedBy: null, evidence: [{ kind: "hostname", equal: true }] } },
    { ref: "n", name: "nothing" },
    { ref: "m", name: "mine", tugra: { serverId: "t9", name: "t-nine", teamId: "t1", via: "owner", confidence: "probable" }, match: { status: "probable", linkedBy: "user", evidence: [{ kind: "ip", equal: true }, { kind: "ssh_host_key", equal: false }] }, agentOnline: false },
  ];
  const rows = matchRows(plan(hosts, { agentRead: READ }));

  it("puts the Coolify host first, then by name, and never carries an address", () => {
    expect(rows.map((r) => r.ref)).toEqual(["h", "b", "e", "m", "n", "x"]);
    expect(JSON.stringify(rows)).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  it("classes each server: certain, probable, weak (a name or an unsure candidate set), none", () => {
    const by = Object.fromEntries(rows.map((r) => [r.ref, r]));
    expect(by.e).toMatchObject({ kind: "certain", tugraName: "edge-1", agentOnline: true, answeredByOwner: false });
    expect(by.b.kind).toBe("probable");
    expect(by.x.kind).toBe("weak");
    expect(by.n).toMatchObject({ kind: "none", tugraServerId: null, evidence: [] });
  });

  it("marks the owner's own answer, and an identity fact that differs as a conflict", () => {
    const m = rows.find((r) => r.ref === "m")!;
    expect(m).toMatchObject({ answeredByOwner: true, identityConflict: true, agentOnline: false });
    expect(rows.find((r) => r.ref === "e")!.identityConflict).toBe(false);
  });

  it("falls back to the older address verdict when the host has no match block", () => {
    const r = matchRows(plan([{ ref: "o", name: "old", tugra: { serverId: "t1", name: "n", teamId: "t", via: "public-ip", confidence: "certain" } }]));
    expect(r[0]).toMatchObject({ kind: "certain", status: "certain" });
  });

  it("answers for every server but the Coolify host, and counts the ones that still need the owner", () => {
    expect(canAnswer(rows.find((r) => r.ref === "h")!)).toBe(false);
    expect(canAnswer(rows.find((r) => r.ref === "e")!)).toBe(true);
    // probable (b), weak (x) and none (n) wait; the certain ones, the host and the owner's own answer (m) do not
    expect(unsureCount(rows)).toBe(3);
  });

  it("has nothing for a plan without hosts", () => {
    expect(matchRows(plan([]))).toEqual([]);
    expect(matchRows(null)).toEqual([]);
  });
});

describe("the step and the servers to pick", () => {
  it("is shown only for an agent read that has servers", () => {
    expect(needsMatchStep(plan([{ ref: "a", name: "a" }], { agentRead: READ }))).toBe(true);
    expect(needsMatchStep(plan([{ ref: "a", name: "a" }]))).toBe(false); // the token path
    expect(needsMatchStep(plan([], { agentRead: READ }))).toBe(false);
    expect(needsMatchStep(null)).toBe(false);
  });

  it("offers servers the user can write to, the current match first", () => {
    const servers = [
      { id: "a", name: "zeta", canWrite: true, status: "ONLINE", teamId: "t" },
      { id: "b", name: "alpha", canWrite: true, status: "OFFLINE", teamId: "t" },
      { id: "c", name: "viewer", canWrite: false, status: "ONLINE", teamId: "t" },
    ] as never[];
    expect(candidateServers(servers, { tugraServerId: "a" })).toEqual([{ id: "a", name: "zeta", online: true }, { id: "b", name: "alpha", online: false }]);
    expect(candidateServers(servers, { tugraServerId: null }).map((s) => s.name)).toEqual(["alpha", "zeta"]);
  });

  it("reads Coolify from any server the user can write to (the host may sit in any team), online ones first", () => {
    const servers = [
      { id: "a", name: "off", canWrite: true, status: "OFFLINE", teamId: "t1", capabilities: ["database"] },
      { id: "b", name: "on", canWrite: true, status: "ONLINE", teamId: "t2", capabilities: ["database"] },
      { id: "c", name: "ro", canWrite: false, status: "ONLINE", teamId: "t1", capabilities: ["database"] },
      { id: "d", name: "nodb", canWrite: true, status: "ONLINE", teamId: "t1", capabilities: ["deploy"] },
    ] as never[];
    expect(agentReadyServers(servers)).toEqual([
      { id: "d", name: "nodb", teamId: "t1", online: true, block: { code: "capability", missing: ["database"] } },
      { id: "b", name: "on", teamId: "t2", online: true, block: null },
      { id: "a", name: "off", teamId: "t1", online: false, block: { code: "offline", missing: [] } },
    ]);
  });
});
