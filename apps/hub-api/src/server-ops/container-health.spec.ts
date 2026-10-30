import { CONTAINER_HEALTH_SCRIPT, parseHealthOutput, diffContainerStates, COOLDOWN_MS, type ContainerSnap, type PrevState } from "./container-health";

const snap = (over: Partial<ContainerSnap> = {}): ContainerSnap => ({
  name: "tugra_app1",
  id: "c1",
  status: "running",
  exitCode: 0,
  oomKilled: false,
  restartCount: 0,
  startedAt: "2026-10-30T00:00:00Z",
  finishedAt: null,
  health: null,
  ...over,
});
const prev = (over: Partial<PrevState> = {}): PrevState => ({
  containerId: "c1",
  restartCount: 0,
  finishedAt: null,
  lastEventTs: 0,
  lastNotifiedKey: null,
  lastNotifiedAt: null,
  restartCountAtNotify: 0,
  ...over,
});
const NOW = 1_800_000_000_000;

describe("CONTAINER_HEALTH_SCRIPT", () => {
  it("is a read-only inspect + bounded events replay, numeric cursor only", () => {
    const s = CONTAINER_HEALTH_SCRIPT(1700);
    expect(s).toContain("##INSPECT");
    expect(s).toContain("##EVENTS");
    expect(s).toContain("docker inspect --format");
    expect(s).toContain("docker events --since 1700 --until");
    expect(s).toContain("--filter event=oom");
    expect(s).toContain("|| true"); // events section never fails the tick
    expect(s).toContain('[ -z "$ids" ]'); // guards an empty host
  });
  it("floors/clamps the cursor (no injection surface — only a number is interpolated)", () => {
    expect(CONTAINER_HEALTH_SCRIPT(-5)).toContain("--since 0");
    expect(CONTAINER_HEALTH_SCRIPT(12.9)).toContain("--since 12");
  });
});

describe("parseHealthOutput", () => {
  it("parses inspect rows (strips leading /, coerces, zero-time → null) and events", () => {
    const out = [
      "##INSPECT",
      "/tugra_app1\tc1\trunning\t0\tfalse\t2\t2026-10-30T00:00:00Z\t0001-01-01T00:00:00Z\thealthy",
      "/tugra_db_d1\tc2\texited\t1\tfalse\t0\t2026-10-30T00:00:00Z\t2026-10-30T01:00:00Z\t",
      "##EVENTS",
      "1700000100\ttugra_app1\toom\t137",
      "1700000050\ttugra_db_d1\tdie\t1",
    ].join("\n");
    const { containers, events } = parseHealthOutput(out);
    expect(containers).toHaveLength(2);
    expect(containers[0]).toMatchObject({ name: "tugra_app1", status: "running", restartCount: 2, health: "healthy", finishedAt: null });
    expect(containers[1]).toMatchObject({ name: "tugra_db_d1", status: "exited", exitCode: 1, finishedAt: "2026-10-30T01:00:00Z", health: null });
    expect(events).toEqual([
      { ts: 1700000100, name: "tugra_app1", action: "oom", exitCode: 137 },
      { ts: 1700000050, name: "tugra_db_d1", action: "die", exitCode: 1 },
    ]);
  });
  it("tolerates a missing events section, malformed/partial lines, and the truncation marker", () => {
    const { containers, events, truncated } = parseHealthOutput("##INSPECT\ngarbage\ntugra_x\tc\trunning\n…(truncated)");
    expect(containers).toHaveLength(0); // the partial line (<8 cols) is dropped
    expect(events).toHaveLength(0);
    expect(truncated).toBe(true);
  });
});

describe("diffContainerStates", () => {
  it("steady running → no fire", () => {
    expect(diffContainerStates(prev({ restartCount: 3 }), snap({ restartCount: 3 }), [], { now: NOW }).fire).toBeNull();
  });
  it("restartCount increase → container_crashed with the delta", () => {
    const r = diffContainerStates(prev({ restartCount: 3, restartCountAtNotify: 3 }), snap({ restartCount: 4 }), [], { now: NOW });
    expect(r.fire).toMatchObject({ type: "container_crashed", restartDelta: 1 });
  });
  it("an oom event wins over a crash in the same tick", () => {
    const r = diffContainerStates(prev({ restartCount: 3, restartCountAtNotify: 3 }), snap({ restartCount: 4 }), [{ ts: 100, name: "tugra_app1", action: "oom", exitCode: 137 }], { now: NOW });
    expect(r.fire?.type).toBe("container_oom");
  });
  it("oom fallback: OOMKilled flag + a NEW finishedAt, no event", () => {
    const r = diffContainerStates(prev({ finishedAt: "2026-10-30T00:00:00Z" }), snap({ status: "running", restartCount: 0, oomKilled: true, finishedAt: "2026-10-30T02:00:00Z" }), [], { now: NOW });
    expect(r.fire?.type).toBe("container_oom");
  });
  it("stale OOMKilled with the SAME finishedAt → no fire", () => {
    const r = diffContainerStates(prev({ finishedAt: "2026-10-30T02:00:00Z" }), snap({ oomKilled: true, finishedAt: "2026-10-30T02:00:00Z" }), [], { now: NOW });
    expect(r.fire).toBeNull();
  });
  it("exited clean (0) or stop codes (137/143) → no crash", () => {
    for (const code of [0, 137, 143]) {
      const r = diffContainerStates(prev(), snap({ status: "exited", exitCode: code }), [{ ts: 100, name: "tugra_app1", action: "die", exitCode: code }], { now: NOW });
      expect(r.fire).toBeNull();
    }
  });
  it("a die with a non-clean exit on a now-exited container → crash (restart-policy none)", () => {
    const r = diffContainerStates(prev(), snap({ status: "exited", exitCode: 1 }), [{ ts: 100, name: "tugra_app1", action: "die", exitCode: 1 }], { now: NOW });
    expect(r.fire?.type).toBe("container_crashed");
  });
  it("recreate (new containerId) with restartCount 0 → baseline reset, no fire (deploys don't alert)", () => {
    const r = diffContainerStates(prev({ containerId: "OLD", restartCount: 9 }), snap({ id: "NEW", restartCount: 0 }), [], { now: NOW });
    expect(r.fire).toBeNull();
    expect(r.next.containerId).toBe("NEW");
  });
  it("recreate already crash-looping (restartCount > 0) → fires", () => {
    const r = diffContainerStates(prev({ containerId: "OLD" }), snap({ id: "NEW", restartCount: 2 }), [], { now: NOW });
    expect(r.fire?.type).toBe("container_crashed");
  });
  it("same death key already notified → no re-fire", () => {
    const key = "c1:4:";
    const r = diffContainerStates(prev({ restartCount: 3, lastNotifiedKey: key, lastNotifiedAt: NOW - 1000, restartCountAtNotify: 3 }), snap({ restartCount: 4 }), [], { now: NOW });
    expect(r.fire).toBeNull();
  });
  it("within cooldown → suppressed but state still advances", () => {
    const r = diffContainerStates(prev({ restartCount: 4, lastNotifiedKey: "c1:4:", lastNotifiedAt: NOW - 1000, restartCountAtNotify: 4 }), snap({ restartCount: 5 }), [], { now: NOW });
    expect(r.fire).toBeNull();
    expect(r.next.restartCount).toBe(5); // advanced so the loop is tracked
  });
  it("after cooldown → fires once with the accumulated restart delta", () => {
    const r = diffContainerStates(prev({ restartCount: 4, lastNotifiedKey: "c1:4:", lastNotifiedAt: NOW - COOLDOWN_MS - 1, restartCountAtNotify: 4 }), snap({ restartCount: 9 }), [], { now: NOW });
    expect(r.fire).toMatchObject({ type: "container_crashed", restartDelta: 5 });
  });
});
