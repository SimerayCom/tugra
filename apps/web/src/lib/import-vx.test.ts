import { describe, it, expect } from "vitest";
import {
  PHASE_KEY,
  STATE_KEY,
  downtimeEstimate,
  errorKey,
  firstBlocker,
  formatBytes,
  formatDuration,
  gatesPass,
  isTransferLive,
  selectedDbModes,
  transferTone,
  volumeCopyCandidates,
  volumePollMs,
  volumeProgressPct,
  withVxFlags,
  vxCommandsWithFlags,
} from "./import";
import type { ImportPlan, VolumeTransferView, VxGate } from "./types";

const base: VolumeTransferView = {
  itemRef: "volume:s:a:data", resourceName: "web", mountPath: "/data", destType: "app-volume", destVolume: "data", state: "NONE", phase: null,
  partsDone: 0, bytesDone: 0, rawBytesDone: 0, rawBytesTotal: null, bps: null, etaSec: null, inventory: null, diskVerdict: null, gates: null,
  evidenceNote: "reported by the migrator", excluded: null, error: null, steps: [], canAbort: false, canReset: false,
};
const v = (o: Partial<VolumeTransferView>): VolumeTransferView => ({ ...base, ...o });

describe("formatBytes / formatDuration", () => {
  it("uses binary units and never lies about tiny or huge values", () => {
    expect([0, 512, 2048, 5 * 1024 ** 2, 1.5 * 1024 ** 3, 31.8 * 1024 ** 3].map(formatBytes)).toEqual(["0 B", "512 B", "2 KiB", "5.0 MiB", "1.5 GiB", "32 GiB"]);
    expect([formatBytes(-1), formatBytes(NaN), formatBytes(Infinity)]).toEqual(["0 B", "0 B", "0 B"]);
  });
  it("durations: seconds, minutes, hours; null for unknown or negative", () => {
    expect([30, 600, 3600 * 3 + 300].map(formatDuration)).toEqual(["30 s", "10 min", "3 h 05 min"]);
    expect([null, undefined, -5, NaN].map((x) => formatDuration(x as never))).toEqual([null, null, null, null]);
  });
});

describe("progress math", () => {
  it("percent is floor(raw done / raw total), clamped, DONE is 100, unknown total is null (no invented bar)", () => {
    expect(volumeProgressPct(v({ state: "COPYING", rawBytesDone: 400, rawBytesTotal: 1000 }))).toBe(40);
    expect(volumeProgressPct(v({ state: "COPYING", rawBytesDone: 999, rawBytesTotal: 1000 }))).toBe(99);
    expect(volumeProgressPct(v({ state: "COPYING", rawBytesDone: 2000, rawBytesTotal: 1000 }))).toBe(100);
    expect(volumeProgressPct(v({ state: "DONE", rawBytesDone: 1, rawBytesTotal: null }))).toBe(100);
    expect(volumeProgressPct(v({ state: "COPYING", rawBytesDone: 5, rawBytesTotal: null }))).toBeNull();
    expect(volumeProgressPct(v({ state: "COPYING", rawBytesDone: 5, rawBytesTotal: 0 }))).toBeNull();
  });
  it("polling is 3 s while any transfer is live, 15 s otherwise", () => {
    expect(volumePollMs([{ state: "DONE" }, { state: "COPYING" }])).toBe(3000);
    expect(volumePollMs([{ state: "APPLYING" }])).toBe(3000);
    expect(volumePollMs([{ state: "DONE" }, { state: "FAILED" }, { state: "NONE" }, { state: "EXCLUDED" }])).toBe(15000);
    expect(volumePollMs(undefined)).toBe(15000);
    expect(["PENDING", "COPYING", "COPIED", "APPLYING"].every((s) => isTransferLive(s as never))).toBe(true);
    expect(["DONE", "FAILED", "ABORTED", "NONE", "EXCLUDED"].some((s) => isTransferLive(s as never))).toBe(false);
  });
  it("tones", () => {
    expect([transferTone("DONE"), transferTone("FAILED"), transferTone("ABORTED"), transferTone("EXCLUDED"), transferTone("NONE"), transferTone("COPYING")]).toEqual(["ok", "bad", "bad", "warn", "muted", "busy"]);
  });
});

describe("error mapping uses the hub's own literals; unknown text is never guessed", () => {
  it.each([
    ["vx-fingerprint-changed", "import.vx.error.fingerprint"],
    ["vx-diverged", "import.vx.error.diverged"],
    ["another migrator run is active for this volume", "import.vx.error.busy"],
    ["vx-disk-insufficient: needs 70 GiB", "import.vx.error.disk"],
    ["vx-aborted", "import.vx.error.aborted"],
    ["aborted by the owner", "import.vx.error.aborted"],
    ["stop web first", null],
    ["the source container is running; stop it first", "import.vx.error.sourceRunning"],
    ["the volume holds device nodes", "import.vx.error.specialFiles"],
    ["the migration token expired", "import.vx.error.tokenExpired"],
    ["something nobody planned for", null],
    ["", null],
  ])("%s", (msg, key) => expect(errorKey(msg)).toBe(key));
});

describe("gates, blockers, estimates", () => {
  const g = (status: VxGate["status"], id: VxGate["id"] = "credentials"): VxGate => ({ id, status, text: "x" });
  it("a physical copy needs EVERY gate to pass; unknown or an empty list never counts", () => {
    expect(gatesPass([g("pass"), g("pass", "major")])).toBe(true);
    expect(gatesPass([g("pass"), g("unknown", "major")])).toBe(false);
    expect(gatesPass([g("fail")])).toBe(false);
    expect(gatesPass([])).toBe(false);
    expect(gatesPass(null)).toBe(false);
  });
  it("firstBlocker: gates, then disk, then the inventory facts", () => {
    expect(firstBlocker(v({ gates: [g("pass"), g("fail", "layout")] }))).toEqual({ kind: "gate", gate: g("fail", "layout") });
    expect(firstBlocker(v({ diskVerdict: { ok: false, unknown: false, details: {} } }))).toEqual({ kind: "disk" });
    const inv = { found: true, rawBytes: 1, entries: 1, mountType: "volume" as const, running: false, specials: { sockets: 0, fifos: 0, devices: 0 } };
    expect(firstBlocker(v({ inventory: { ...inv, running: true } }))).toEqual({ kind: "running" });
    expect(firstBlocker(v({ inventory: { ...inv, mountType: "bind" } }))).toEqual({ kind: "bind" });
    expect(firstBlocker(v({ inventory: { ...inv, specials: { sockets: 0, fifos: 0, devices: 2 } } }))).toEqual({ kind: "devices" });
    expect(firstBlocker(v({ inventory: inv }))).toBeNull();
  });
  it("downtime estimate = size / link speed (+-30 %) + 15 min to extract; none without a measured speed", () => {
    expect(downtimeEstimate(0, 100)).toBeNull();
    expect(downtimeEstimate(10 ** 9, null)).toBeNull();
    expect(downtimeEstimate(10 ** 9, 0)).toBeNull();
    const e = downtimeEstimate(10 ** 9, 800)!; // 800 Mbit/s = 100 MB/s: 10 s of data
    expect(e.low).toBe(Math.round(10 / 1.3) + 900);
    expect(e.high).toBe(Math.round(10 / 0.7) + 900);
    expect(e.low).toBeLessThan(e.high);
  });
});

describe("command flags", () => {
  it("appends the toggles and never touches the token slot", () => {
    const cmd = "curl -fsSL https://h/install/migrator.sh | TUGRA_MIGRATION_TOKEN=tugra_mig_x sh -s -- --hub https://h --arms all";
    expect(withVxFlags(cmd, {})).toBe(cmd);
    expect(withVxFlags(cmd, { stopSource: true })).toBe(`${cmd} --stop-source`);
    expect(withVxFlags(cmd, { stopSource: true, allowBind: true })).toBe(`${cmd} --stop-source --allow-bind`);
    const all = vxCommandsWithFlags({ dryRun: `${cmd} --dry-run`, run: cmd, resume: `${cmd} --hub-outage-wait 30m` }, { allowBind: true });
    expect(all.run.endsWith("--allow-bind")).toBe(true);
    for (const c of Object.values(all)) expect(c).toContain("TUGRA_MIGRATION_TOKEN=tugra_mig_x sh -s");
  });
});

describe("data mode helpers", () => {
  const plan = {
    sourceKind: "coolify", mode: "copy", planHash: "a".repeat(32), warnings: [], totals: { apps: 0, databases: 3, volumes: 0, blockers: 0 },
    items: [
      { itemRef: "database:s:pg", kind: "database", name: "pg", proposed: { engine: "POSTGRES", dataMode: "volume" }, risks: [], dependsOn: [] },
      { itemRef: "database:s:pg2", kind: "database", name: "pg2", proposed: { engine: "POSTGRES" }, risks: [], dependsOn: [] },
      { itemRef: "database:s:my", kind: "database", name: "my", proposed: { engine: "MYSQL" }, risks: [], dependsOn: [] },
      { itemRef: "database:s:pgb", kind: "database", name: "pgb", proposed: { engine: "POSTGRES" }, risks: [{ level: "blocker", code: "x", message: "y" }], dependsOn: [] },
    ],
  } as ImportPlan;
  it("only unblocked PostgreSQL databases are candidates; the selection mirrors proposed.dataMode", () => {
    expect(volumeCopyCandidates(plan).map((i) => i.name)).toEqual(["pg", "pg2"]);
    expect(selectedDbModes(plan)).toEqual({ "database:s:pg": "volume" });
  });
});

describe("literal key maps cover every state and phase", () => {
  it("has a key for each", () => {
    expect(Object.keys(STATE_KEY).sort()).toEqual(["ABORTED", "APPLYING", "COPIED", "COPYING", "DONE", "EXCLUDED", "FAILED", "NONE", "PENDING"]);
    expect(Object.keys(PHASE_KEY).sort()).toEqual(["applying", "provisioning", "skipping", "streaming", "verifying"]);
  });
});
