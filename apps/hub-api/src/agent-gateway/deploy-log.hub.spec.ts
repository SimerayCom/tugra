import { firstValueFrom, toArray } from "rxjs";
import { DeployLogHub, type DeployLogEvent } from "./deploy-log.hub";

describe("DeployLogHub", () => {
  beforeEach(() => jest.useRealTimers());
  afterEach(() => jest.useRealTimers());

  it("replays buffered chunks to a late subscriber", () => {
    const hub = new DeployLogHub();
    hub.begin("a");
    hub.push("a", "one ");
    hub.push("a", "two");
    const sub = hub.subscribe("a")!;
    expect(sub.replay).toEqual([
      { type: "chunk", data: "one " },
      { type: "chunk", data: "two" },
    ]);
  });

  it("streams live chunks to an active subscriber and completes on finish", async () => {
    const hub = new DeployLogHub();
    hub.begin("a");
    const sub = hub.subscribe("a")!;
    const collected = firstValueFrom(sub.live.pipe(toArray()));
    hub.push("a", "live ");
    hub.finish("a", { status: "SUCCESS", exitCode: 0, deploymentId: "d1" });
    const events = await collected;
    expect(events).toEqual<DeployLogEvent[]>([
      { type: "chunk", data: "live " },
      { type: "done", status: "SUCCESS", exitCode: 0, deploymentId: "d1" },
    ]);
  });

  it("includes the done event in replay for a subscriber that joins after finish", () => {
    const hub = new DeployLogHub();
    hub.begin("a");
    hub.push("a", "x");
    hub.finish("a", { status: "FAILED", exitCode: 1, deploymentId: "d2" });
    const sub = hub.subscribe("a")!;
    expect(sub.replay).toEqual([
      { type: "chunk", data: "x" },
      { type: "done", status: "FAILED", exitCode: 1, deploymentId: "d2" },
    ]);
  });

  it("ignores pushes after finish", () => {
    const hub = new DeployLogHub();
    hub.begin("a");
    hub.finish("a", { status: "SUCCESS", exitCode: 0, deploymentId: "d1" });
    hub.push("a", "late");
    const sub = hub.subscribe("a")!;
    expect(sub.replay.filter((e) => e.type === "chunk")).toEqual([]);
  });

  it("returns null when there is no stream for the app", () => {
    const hub = new DeployLogHub();
    expect(hub.subscribe("nope")).toBeNull();
  });

  it("caps the replay buffer at 64KB but appends a truncation marker", () => {
    const hub = new DeployLogHub();
    hub.begin("a");
    hub.push("a", "x".repeat(70 * 1024));
    hub.push("a", "more");
    const sub = hub.subscribe("a")!;
    const buffered = sub.replay
      .filter((e): e is { type: "chunk"; data: string } => e.type === "chunk")
      .map((e) => e.data)
      .join("");
    expect(buffered.length).toBeLessThanOrEqual(64 * 1024 + "\n…(truncated)".length);
    expect(buffered).toContain("…(truncated)");
  });

  it("cleans up the stream entry a while after finish", () => {
    jest.useFakeTimers();
    const hub = new DeployLogHub();
    hub.begin("a");
    hub.finish("a", { status: "SUCCESS", exitCode: 0, deploymentId: "d1" });
    expect(hub.subscribe("a")).not.toBeNull();
    jest.advanceTimersByTime(30_000);
    expect(hub.subscribe("a")).toBeNull();
  });

  it("begin replaces a prior stream for the same app", () => {
    const hub = new DeployLogHub();
    hub.begin("a");
    hub.push("a", "old");
    hub.begin("a");
    const sub = hub.subscribe("a")!;
    expect(sub.replay).toEqual([]);
  });
});
