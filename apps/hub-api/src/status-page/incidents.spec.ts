import { deriveIncidents, maintenanceState, overallStatus, settleIncidents, uptimeOver, type Beat } from "./incidents";

const at = (min: number) => new Date(Date.UTC(2026, 10, 24, 12, min));
const beat = (monitorId: string, status: Beat["status"], min: number, important = true): Beat => ({ monitorId, status, important, ts: at(min) });

describe("deriveIncidents", () => {
  it("opens on the first DOWN and closes on the next UP", () => {
    const out = deriveIncidents([beat("a", "DOWN", 0), beat("a", "UP", 10)]);
    expect(out).toEqual([{ monitorId: "a", startedAt: at(0), resolvedAt: at(10) }]);
  });

  it("ignores re-sent DOWN beats and non-important beats", () => {
    const out = deriveIncidents([beat("a", "DOWN", 0), beat("a", "DOWN", 5), beat("a", "PENDING", 6, false), beat("a", "UP", 20)]);
    expect(out).toHaveLength(1);
    expect(out[0].startedAt).toEqual(at(0));
    expect(out[0].resolvedAt).toEqual(at(20));
  });

  it("keeps an unresolved incident open and orders newest first across monitors", () => {
    const out = deriveIncidents([beat("a", "DOWN", 0), beat("a", "UP", 1), beat("b", "DOWN", 30), beat("a", "DOWN", 40)]);
    expect(out.map((i) => [i.monitorId, i.resolvedAt === null])).toEqual([["a", true], ["b", true], ["a", false]]);
  });

  it("ignores a recovery whose DOWN fell before the window, whatever the input order", () => {
    expect(deriveIncidents([beat("a", "UP", 3)])).toEqual([]);
    expect(deriveIncidents([beat("a", "UP", 10), beat("a", "DOWN", 0)])).toHaveLength(1);
  });
});

describe("settleIncidents", () => {
  it("closes an open incident whose monitor is not DOWN any more", () => {
    const now = at(99);
    const open = { monitorId: "a", startedAt: at(0), resolvedAt: null };
    expect(settleIncidents([open], new Map([["a", "UP"]]), now)[0].resolvedAt).toEqual(now);
    expect(settleIncidents([open], new Map([["a", "DOWN"]]), now)[0].resolvedAt).toBeNull();
  });
});

describe("overallStatus / maintenanceState / uptimeOver", () => {
  it("summarises the page", () => {
    expect(overallStatus(["up", "up"], false)).toBe("operational");
    expect(overallStatus(["up", "down"], false)).toBe("partial");
    expect(overallStatus(["down", "down", "paused"], false)).toBe("outage");
    expect(overallStatus(["down"], true)).toBe("maintenance");
    expect(overallStatus([], false)).toBe("unknown");
    expect(overallStatus(["paused"], false)).toBe("unknown");
    expect(overallStatus(["checking"], false)).toBe("operational");
  });

  it("classifies a maintenance window", () => {
    const w = { startsAt: at(10), endsAt: at(20) };
    expect(maintenanceState(w, at(5))).toBe("scheduled");
    expect(maintenanceState(w, at(10))).toBe("active");
    expect(maintenanceState(w, at(20))).toBe("completed");
  });

  it("computes uptime over buckets", () => {
    expect(uptimeOver([])).toBeNull();
    expect(uptimeOver([{ up: 99, total: 100 }, { up: 100, total: 100 }])).toBe(99.5);
  });
});
