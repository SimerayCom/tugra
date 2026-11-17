import {
  buildDomainTargets,
  checkRebootSchedule,
  domainStatusIsUp,
  evaluateVerification,
  failureReport,
  isExpectedBack,
  rebootTiming,
  snapshotContainers,
  type RebootSnapshot,
  type SnapshotContainer,
  type VerificationInput,
} from "./reboot-logic";
import type { DomainProbeRead, RebootContainerState, RebootStateRead } from "./reboot-script";

const NOW = Date.UTC(2026, 10, 27, 12, 0, 0);
const min = 60_000;

describe("checkRebootSchedule", () => {
  it("accepts an instant between a minute and 7 days ahead", () => {
    const at = new Date(NOW + 2 * min).toISOString();
    const r = checkRebootSchedule(at, NOW);
    expect(r).toEqual({ ok: true, at: new Date(at) });
    expect(checkRebootSchedule(new Date(NOW + 7 * 24 * 60 * min).toISOString(), NOW).ok).toBe(true);
  });
  it("rejects the past, 'right now', more than 7 days, and garbage", () => {
    expect(checkRebootSchedule(new Date(NOW - min).toISOString(), NOW)).toEqual({ ok: false, reason: "past" });
    expect(checkRebootSchedule(new Date(NOW + 30_000).toISOString(), NOW)).toEqual({ ok: false, reason: "past" });
    expect(checkRebootSchedule(new Date(NOW + 7 * 24 * 60 * min + 1000).toISOString(), NOW)).toEqual({ ok: false, reason: "too_far" });
    expect(checkRebootSchedule("not a date", NOW)).toEqual({ ok: false, reason: "invalid" });
    expect(checkRebootSchedule(undefined, NOW)).toEqual({ ok: false, reason: "invalid" });
  });
  it("reads an offset timestamp as the instant it names (stored UTC)", () => {
    const r = checkRebootSchedule("2026-11-27T15:30:00+03:00", NOW);
    expect(r.ok && r.at.toISOString()).toBe("2026-11-27T12:30:00.000Z");
  });
});

describe("domainStatusIsUp", () => {
  it.each([
    [200, true],
    [204, true],
    [301, true],
    [302, true],
    [399, true],
    [401, true],
    [403, false],
    [404, false],
    [500, false],
    [502, false],
    [503, false],
    [0, false],
  ])("%i -> %s", (code, up) => expect(domainStatusIsUp(code)).toBe(up));
});

describe("buildDomainTargets", () => {
  const app = (o: Partial<Parameters<typeof buildDomainTargets>[0][number]> = {}) => ({ status: "RUNNING", domain: "a.example.com", https: true, extraDomains: [], pathPrefix: null, serviceDomains: [], ...o });
  it("takes RUNNING apps only, with primary, alias and per-service hosts, deduped and lowercased", () => {
    const t = buildDomainTargets([
      app({ extraDomains: ["Alias.example.com", "a.example.com"], serviceDomains: [{ hostname: "svc.example.com" }] }),
      app({ status: "STOPPED", domain: "stopped.example.com" }),
      app({ domain: "plain.example.com", https: false, pathPrefix: "docs" }),
      app({ domain: null }),
    ]);
    expect(t).toEqual([
      { host: "a.example.com", scheme: "https", path: "/" },
      { host: "alias.example.com", scheme: "https", path: "/" },
      { host: "svc.example.com", scheme: "https", path: "/" },
      { host: "plain.example.com", scheme: "http", path: "/docs" },
    ]);
  });
  it("drops hosts that are not safe curl arguments", () => {
    expect(buildDomainTargets([app({ domain: "bad host.com", extraDomains: ["x.com;ls", "*.wild.com", "-flag.com"] })])).toEqual([]);
  });
});

describe("snapshot helpers", () => {
  const c = (name: string, state: string, over: Partial<RebootContainerState> = {}): RebootContainerState => ({ name, state, health: "none", restartPolicy: "always", swarm: false, image: "img", ...over });
  it("snapshots only RUNNING containers", () => {
    const read: RebootStateRead = { bootId: "b", docker: true, complete: true, containers: [c("a", "running"), c("b", "exited"), c("c", "running", { health: "healthy" })] };
    expect(snapshotContainers(read).map((x) => x.name)).toEqual(["a", "c"]);
  });
  it("expects back only containers with a restart policy other than 'no' (and not swarm tasks)", () => {
    const sc = (restartPolicy: string, swarm = false): SnapshotContainer => ({ name: "x", image: "i", restartPolicy, health: "none", swarm });
    expect(isExpectedBack(sc("always"))).toBe(true);
    expect(isExpectedBack(sc("unless-stopped"))).toBe(true);
    expect(isExpectedBack(sc("on-failure"))).toBe(true);
    expect(isExpectedBack(sc("no"))).toBe(false);
    expect(isExpectedBack(sc(""))).toBe(false);
    expect(isExpectedBack(sc("always", true))).toBe(false);
  });
});

// ── evaluateVerification ──────────────────────────────────────────────────────────────────────────────────────────────
const snapshot = (over: Partial<RebootSnapshot> = {}): RebootSnapshot => ({
  version: 1,
  takenAt: "2026-11-27T12:00:00.000Z",
  bootId: "boot-old",
  hostsHub: false,
  containers: [
    { name: "web", image: "nginx", restartPolicy: "unless-stopped", health: "healthy", swarm: false },
    { name: "db", image: "postgres", restartPolicy: "always", health: "none", swarm: false },
    { name: "scratch", image: "busybox", restartPolicy: "no", health: "none", swarm: false },
  ],
  domains: [
    { host: "a.example.com", scheme: "https", path: "/" },
    { host: "b.example.com", scheme: "https", path: "/" },
  ],
  probe: "loopback",
  ...over,
});
const cs = (name: string, state: string, health = "none"): RebootContainerState => ({ name, state, health, restartPolicy: "always", swarm: false, image: "i" });
const stateRead = (containers: RebootContainerState[], over: Partial<RebootStateRead> = {}): RebootStateRead => ({ bootId: "boot-new", docker: true, complete: true, containers, ...over });
const probe = (codes: Record<string, number>, unavailable = false): DomainProbeRead => ({ unavailable, codes: new Map(Object.entries(codes)), complete: true });
const run = (o: Partial<VerificationInput> = {}) =>
  evaluateVerification({
    snapshot: snapshot(),
    state: stateRead([cs("web", "running", "healthy"), cs("db", "running")]),
    domains: probe({ "a.example.com": 200, "b.example.com": 301 }),
    rebootRequired: false,
    final: false,
    ...o,
  });

describe("evaluateVerification", () => {
  it("everything back -> ok, settled at once, counts in the summary", () => {
    const r = run();
    expect(r).toMatchObject({ settled: true, result: "ok" });
    expect(r.report.rebooted).toBe(true);
    expect(r.report.docker).toBe("active");
    expect(r.report.rebootRequired).toBe("cleared");
    expect(r.report.summary).toEqual({ containersOk: 2, containersExpected: 2, domainsOk: 2, domainsExpected: 2 });
    expect(r.report.containers.find((c) => c.name === "scratch")?.verdict).toBe("skipped"); // restart policy "no" is not expected back
  });

  it("a missing container with a restart policy keeps polling, and is 'missing' + degraded at the end of the window", () => {
    const state = stateRead([cs("web", "running", "healthy")]);
    const open = run({ state });
    expect(open).toMatchObject({ settled: false, result: null });
    expect(open.report.containers.find((c) => c.name === "db")).toMatchObject({ verdict: "missing" });
    const done = run({ state, final: true });
    expect(done).toMatchObject({ settled: true, result: "degraded" });
  });

  it("a stopped (exited) container is missing; a created/restarting one is still coming up (pending)", () => {
    const exited = run({ state: stateRead([cs("web", "running", "healthy"), cs("db", "exited")]) });
    expect(exited.report.containers.find((c) => c.name === "db")).toMatchObject({ verdict: "missing", detail: "exited" });
    const restarting = run({ state: stateRead([cs("web", "running", "healthy"), cs("db", "restarting")]) });
    expect(restarting.report.containers.find((c) => c.name === "db")?.verdict).toBe("pending");
    expect(restarting.settled).toBe(false);
  });

  it("healthcheck: starting is allowed to settle (start period), unhealthy is not", () => {
    const starting = run({ state: stateRead([cs("web", "running", "starting"), cs("db", "running")]) });
    expect(starting.report.containers[0]).toMatchObject({ verdict: "pending", detail: "starting" });
    expect(starting.settled).toBe(false);
    const unhealthy = run({ state: stateRead([cs("web", "running", "unhealthy"), cs("db", "running")]), final: true });
    expect(unhealthy.report.containers[0]).toMatchObject({ verdict: "unhealthy" });
    expect(unhealthy.result).toBe("degraded");
    // still starting when the window ends -> counts as not ok
    const never = run({ state: stateRead([cs("web", "running", "starting"), cs("db", "running")]), final: true });
    expect(never.result).toBe("degraded");
  });

  it("a container that was already unhealthy before the reboot is judged on running only (the reboot is not blamed for it)", () => {
    const snap = snapshot({ containers: [{ name: "web", image: "nginx", restartPolicy: "always", health: "unhealthy", swarm: false }], domains: [] });
    const r = run({ snapshot: snap, state: stateRead([cs("web", "running", "unhealthy")]), domains: null });
    expect(r).toMatchObject({ settled: true, result: "ok" });
    expect(r.report.containers[0]).toMatchObject({ verdict: "ok", detail: "running (was unhealthy before the reboot)" });
    // ...but if it did not come back at all, that IS the reboot's doing
    expect(run({ snapshot: snap, state: stateRead([]), domains: null, final: true }).result).toBe("degraded");
  });

  it("a container that had no healthcheck needs only to be running", () => {
    expect(run().report.containers.find((c) => c.name === "db")).toMatchObject({ verdict: "ok", hadHealthcheck: false });
  });

  it("a routed domain that does not answer (000 / 404 / 5xx) is 'not_answering'; 401 and 3xx are up", () => {
    const r = run({ domains: probe({ "a.example.com": 502, "b.example.com": 401 }), final: true });
    expect(r.report.domains).toEqual([
      { host: "a.example.com", verdict: "not_answering", status: 502 },
      { host: "b.example.com", verdict: "ok", status: 401 },
    ]);
    expect(r.result).toBe("degraded");
    const none = run({ domains: probe({ "a.example.com": 0, "b.example.com": 404 }), final: true });
    expect(none.report.domains[0]).toMatchObject({ verdict: "not_answering", status: null });
    expect(none.report.domains[1]).toMatchObject({ verdict: "not_answering", status: 404 });
  });

  it("a domain not probed yet is pending while the window is open", () => {
    const r = run({ domains: null });
    expect(r.settled).toBe(false);
    expect(r.report.domains.every((d) => d.verdict === "pending")).toBe(true);
  });

  it("the reboot-required flag still set -> degraded at once (waiting cannot clear it)", () => {
    const r = run({ rebootRequired: true });
    expect(r).toMatchObject({ settled: true, result: "degraded" });
    expect(r.report.rebootRequired).toBe("still_set");
  });

  it("an unreadable flag is reported as unknown and does not degrade", () => {
    const r = run({ rebootRequired: null });
    expect(r).toMatchObject({ settled: true, result: "ok" });
    expect(r.report.rebootRequired).toBe("unknown");
  });

  it("docker not active is never ok: pending, then FAILED at the end of the window", () => {
    const state = stateRead([], { docker: false });
    expect(run({ state })).toMatchObject({ settled: false, result: null });
    const end = run({ state, final: true });
    expect(end.result).toBe("failed");
    expect(end.report.reason).toBe("docker_inactive");
    expect(end.report.docker).toBe("inactive");
  });

  it("a state that could not be read is failed (state_unreadable) only when the window is over", () => {
    expect(run({ state: null })).toMatchObject({ settled: false });
    const end = run({ state: null, final: true });
    expect(end).toMatchObject({ settled: true, result: "failed" });
    expect(end.report.reason).toBe("state_unreadable");
    expect(end.report.docker).toBe("unknown");
  });

  it("a probe that cannot run is reported (never a fake ok) and degrades", () => {
    const r = run({ domains: probe({}, true) });
    expect(r).toMatchObject({ settled: true, result: "degraded" });
    expect(r.report.domainsNote).toBe("probe_unavailable");
    expect(r.report.domains.every((d) => d.verdict === "unverified")).toBe(true);
    expect(r.report.summary.domainsExpected).toBe(0);
  });

  it("a proxy with no host port is noted, not probed, and does not degrade", () => {
    const r = run({ snapshot: snapshot({ probe: "skipped_no_host_port" }), domains: null });
    expect(r).toMatchObject({ settled: true, result: "ok" });
    expect(r.report.domainsNote).toBe("skipped_no_host_port");
  });

  it("the boot id decides 'rebooted'", () => {
    expect(run({ state: stateRead([cs("web", "running", "healthy"), cs("db", "running")], { bootId: "boot-old" }) }).report.rebooted).toBe(false);
  });

  it("swarm tasks are not tracked by name (their names change)", () => {
    const s = snapshot({ containers: [{ name: "svc.1.xyz", image: "i", restartPolicy: "always", health: "none", swarm: true }], domains: [] });
    const r = run({ snapshot: s, state: stateRead([]) });
    expect(r).toMatchObject({ settled: true, result: "ok" });
    expect(r.report.containers[0].verdict).toBe("skipped");
  });

  it("nothing snapshotted and docker up is ok", () => {
    expect(run({ snapshot: snapshot({ containers: [], domains: [] }), domains: null })).toMatchObject({ settled: true, result: "ok" });
  });
});

describe("failureReport + timing defaults", () => {
  it("carries the reason and what was expected, no per-item rows", () => {
    const r = failureReport("agent_never_returned", snapshot(), true);
    expect(r).toMatchObject({ reason: "agent_never_returned", rebooted: true, containers: [], domains: [], summary: { containersExpected: 2, domainsExpected: 2 } });
  });
  it("the verification window is 10 minutes and the agent deadline is longer than the no-reboot grace", () => {
    expect(rebootTiming.verifyWindowMs).toBe(10 * 60_000);
    expect(rebootTiming.agentDeadlineMs).toBeGreaterThan(rebootTiming.noRebootGraceMs);
  });
});
