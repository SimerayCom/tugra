import { CONTAINER_HEALTH_SCRIPT, parseHealthOutput, diffContainerStates, explainExit, COOLDOWN_MS, type ContainerSnap, type PrevState } from "./container-health";

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
  health: null,
  unhealthySince: null,
  healthNotifiedAt: null,
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

describe("diffContainerStates — unhealthy healthcheck alert", () => {
  it("transition healthy → unhealthy fires container_unhealthy and sets unhealthySince", () => {
    const r = diffContainerStates(prev({ health: "healthy" }), snap({ health: "unhealthy" }), [], { now: NOW });
    expect(r.healthFire).toEqual({ type: "container_unhealthy", unhealthySince: NOW });
    expect(r.next.unhealthySince).toBe(NOW);
    expect(r.next.healthNotifiedAt).toBe(NOW);
    expect(r.fire).toBeNull(); // orthogonal to crash — a healthy→unhealthy with no restart is NOT a crash
  });

  it("transition from starting/null also fires (prev was never unhealthy)", () => {
    expect(diffContainerStates(prev({ health: "starting" }), snap({ health: "unhealthy" }), [], { now: NOW }).healthFire).not.toBeNull();
    expect(diffContainerStates(prev({ health: null }), snap({ health: "unhealthy" }), [], { now: NOW }).healthFire).not.toBeNull();
  });

  it("steady unhealthy already alerted this episode → no re-fire even after the cooldown expires (one alert per episode)", () => {
    const since = NOW - COOLDOWN_MS - 5_000; // episode started long ago, cooldown since expired
    const r = diffContainerStates(prev({ health: "unhealthy", unhealthySince: since, healthNotifiedAt: since + 10 }), snap({ health: "unhealthy" }), [], { now: NOW });
    expect(r.healthFire).toBeNull(); // healthNotifiedAt >= unhealthySince ⇒ this episode is already alerted
    expect(r.next.unhealthySince).toBe(since); // continuous — not reset
  });

  it("recovery (unhealthy → healthy) clears unhealthySince and does not fire", () => {
    const r = diffContainerStates(prev({ health: "unhealthy", unhealthySince: NOW - 60_000, healthNotifiedAt: NOW - 60_000 }), snap({ health: "healthy" }), [], { now: NOW });
    expect(r.healthFire).toBeNull();
    expect(r.next.unhealthySince).toBeNull();
  });

  it("flap within cooldown is suppressed (state still advances)", () => {
    const r = diffContainerStates(prev({ health: "healthy", healthNotifiedAt: NOW - 1000 }), snap({ health: "unhealthy" }), [], { now: NOW });
    expect(r.healthFire).toBeNull();
    expect(r.next.unhealthySince).toBe(NOW); // tracked even while the alert is suppressed
  });

  it("a fresh unhealthy after the cooldown expires fires again", () => {
    const r = diffContainerStates(prev({ health: "healthy", healthNotifiedAt: NOW - COOLDOWN_MS - 1 }), snap({ health: "unhealthy" }), [], { now: NOW });
    expect(r.healthFire).not.toBeNull();
  });

  it("re-alerts a STILL-unhealthy container once the cooldown expires when the last alert predates this episode (flap-then-stuck)", () => {
    // Prior episode alerted at NOW-15m+; it recovered + re-failed 2m ago (new episode), whose transition was
    // cooldown-suppressed. Now the cooldown has expired and it is still unhealthy → it MUST fire (the gap the
    // old edge-only logic left: a flap-then-stuck container stayed silent for hours).
    const r = diffContainerStates(
      prev({ health: "unhealthy", unhealthySince: NOW - 2 * 60_000, healthNotifiedAt: NOW - COOLDOWN_MS - 1 }),
      snap({ health: "unhealthy" }),
      [],
      { now: NOW },
    );
    expect(r.healthFire).not.toBeNull();
    expect(r.next.healthNotifiedAt).toBe(NOW);
  });

  it("recreated (new containerId) that comes up unhealthy fires (baseline reset)", () => {
    const r = diffContainerStates(prev({ containerId: "old", health: "unhealthy", healthNotifiedAt: NOW - 1000 }), snap({ id: "new", health: "unhealthy" }), [], { now: NOW });
    expect(r.healthFire).not.toBeNull(); // prev health/cooldown belonged to the old container
  });

  it("no healthcheck (null health) never fires and leaves unhealthySince null", () => {
    const r = diffContainerStates(prev({ health: null }), snap({ health: null }), [], { now: NOW });
    expect(r.healthFire).toBeNull();
    expect(r.next.unhealthySince).toBeNull();
  });
});

describe("explainExit", () => {
  it("prefers OOM when the flag is set, regardless of code", () => {
    expect(explainExit(137, true)).toMatch(/out of memory/i);
    expect(explainExit(0, true)).toMatch(/out of memory/i);
  });
  it("maps the common exit codes to a human reason", () => {
    expect(explainExit(0, false)).toContain("0");
    expect(explainExit(1, false)).toMatch(/application error/i);
    expect(explainExit(137, false)).toMatch(/SIGKILL/);
    expect(explainExit(139, false)).toMatch(/segmentation/i);
    expect(explainExit(143, false)).toMatch(/SIGTERM/);
    expect(explainExit(127, false)).toMatch(/not found/i);
  });
  it("derives the signal for other 128+N codes and falls back to the raw code", () => {
    expect(explainExit(130, false)).toBe("Killed by signal 2 (130)");
    expect(explainExit(100, false)).toBe("Exit code 100");
  });
});

describe("diffContainerStates — timeline event", () => {
  it("emits a crash event on a restart increase (reason + delta), independent of the alert", () => {
    const r = diffContainerStates(prev({ restartCount: 3, restartCountAtNotify: 3 }), snap({ restartCount: 4 }), [], { now: NOW });
    expect(r.event).toMatchObject({ kind: "crash", restartDelta: 1, reason: expect.stringMatching(/clean exit|exit code 0/i) });
  });
  it("emits an oom event when OOM wins", () => {
    const r = diffContainerStates(prev({ restartCount: 3, restartCountAtNotify: 3 }), snap({ restartCount: 4, exitCode: 137 }), [{ ts: 100, name: "tugra_app1", action: "oom", exitCode: 137 }], { now: NOW });
    expect(r.event).toMatchObject({ kind: "oom", oomKilled: true });
    expect(r.event?.reason).toMatch(/out of memory/i);
  });
  it("records the episode even while the alert is in cooldown (complete history)", () => {
    const r = diffContainerStates(prev({ restartCount: 4, lastNotifiedKey: "c1:4:", lastNotifiedAt: NOW - 1000, restartCountAtNotify: 4 }), snap({ restartCount: 5 }), [], { now: NOW });
    expect(r.fire).toBeNull(); // suppressed
    expect(r.event).toMatchObject({ kind: "crash" }); // but still recorded
  });
  it("no event on a steady running container", () => {
    expect(diffContainerStates(prev({ restartCount: 3 }), snap({ restartCount: 3 }), [], { now: NOW }).event).toBeNull();
  });
});
