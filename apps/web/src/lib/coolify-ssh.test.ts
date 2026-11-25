import { describe, it, expect } from "vitest";
import type { CoolifySshTargetView } from "@tugra/shared";
import { confirmText, pollInterval, runCounts, runPhase, sourceAgentGapsOf, sshCandidates, stateTone } from "./coolify-ssh";
import type { ChecklistRow } from "./coolify-takeover";

const tv = (state: CoolifySshTargetView["state"], over: Partial<CoolifySshTargetView> = {}): CoolifySshTargetView => ({
  id: state + Math.random(), runId: "r", coolifyServerUuid: "uuid" + state, name: state, state, code: null, tugraServerId: null, manualCommand: false, canRemove: false, probe: null, updatedAt: "2026-11-26T00:00:00Z", ...over,
});
const run = (...states: CoolifySshTargetView["state"][]) => ({ targets: states.map((s) => tv(s)), finished: false });

describe("runPhase", () => {
  it("is probing while any target is planned or being probed", () => {
    expect(runPhase(run("PLANNED", "READY"))).toBe("probing");
    expect(runPhase(run("PROBING"))).toBe("probing");
  });
  it("is ready when the probe is done and the owner can install", () => {
    expect(runPhase(run("READY", "SKIPPED_PRESENT", "FAILED"))).toBe("ready");
  });
  it("is installing from the token step to the enroll, and uninstalling while a removal runs", () => {
    for (const s of ["TOKEN_MINTED", "INSTALLING", "WAIT_ENROLL"] as const) expect(runPhase(run(s, "READY"))).toBe("installing");
    expect(runPhase(run("UNINSTALLING", "ONLINE"))).toBe("uninstalling");
  });
  it("is done when nothing waits for anyone, and for no run at all", () => {
    expect(runPhase(run("ONLINE", "FAILED", "REMOVED", "SKIPPED_FOREIGN"))).toBe("done");
    expect(runPhase(null)).toBe("done");
  });
});

describe("runCounts / pollInterval", () => {
  it("counts each kind of target", () => {
    const r = { targets: [tv("READY"), tv("READY"), tv("ONLINE", { canRemove: true }), tv("FAILED"), tv("SKIPPED_PRESENT"), tv("SKIPPED_FOREIGN"), tv("INSTALLING")], finished: false };
    expect(runCounts(r)).toEqual({ total: 7, ready: 2, online: 1, skipped: 2, failed: 1, removable: 1, working: 1 });
  });
  it("polls only while something is working", () => {
    expect(pollInterval(run("PROBING"))).toBe(2500);
    expect(pollInterval(run("WAIT_ENROLL", "ONLINE"))).toBe(2500);
    expect(pollInterval(run("READY"))).toBe(false);
    expect(pollInterval(run("ONLINE", "FAILED"))).toBe(false);
    expect(pollInterval(null)).toBe(false);
  });
});

describe("sshCandidates", () => {
  const row = (state: ChecklistRow["state"]): ChecklistRow => ({ coolifyServerId: state, coolifyServerUuid: "uuid" + state, name: state, ip: "198.51.100.7", port: 22, user: "root", state, teamId: "t", tugraServerId: null, installCommand: null, expiresAt: null, ssh: "ssh root@x" });
  it("offers the servers that still have no agent, and never the Coolify host, one already in Tugra, or one the caller cannot manage", () => {
    const rows = (["this_server", "already_added", "waiting", "expired", "no_access", "not_generated", "ambiguous"] as const).map(row);
    expect(sshCandidates(rows).map((r) => r.state)).toEqual(["waiting", "expired", "not_generated", "ambiguous"]);
  });
});

describe("misc", () => {
  it("shows the typed number as the hub expects it", () => {
    expect(confirmText(7)).toBe("7");
  });
  it("gives every state a tone", () => {
    for (const s of ["PLANNED", "PROBING", "SKIPPED_PRESENT", "SKIPPED_FOREIGN", "READY", "FAILED", "TOKEN_MINTED", "INSTALLING", "WAIT_ENROLL", "ONLINE", "UNINSTALLING", "REMOVED"] as const) expect(stateTone(s)).toBeTruthy();
  });
});

describe("sourceAgentGapsOf", () => {
  const hosts = [
    { ref: "a", name: "Edge A", tugra: { serverId: "1" }, agentOnline: true },
    { ref: "b", name: "Edge B", agentOnline: false },
    { ref: "c", name: " ", tugra: { serverId: "3" }, agentOnline: false },
    { ref: "d", name: "Control", agentOnline: false },
    { ref: "e", name: "Unknown" },
  ];
  it("flags only servers that have something to move and no online agent, by name", () => {
    expect(sourceAgentGapsOf(hosts, new Set(["a", "b", "c", "e"]))).toEqual([
      { ref: "b", name: "Edge B", state: "no_agent" },
      { ref: "c", name: "c", state: "offline" },
    ]);
  });
  it("flags nothing without a verdict or without hosts", () => {
    expect(sourceAgentGapsOf(undefined, new Set(["a"]))).toEqual([]);
    expect(sourceAgentGapsOf(hosts, new Set())).toEqual([]);
  });
});
