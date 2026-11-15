import { AppMoveViewSchema, MoveAckSchema, MoveAppPreflightSchema, StartAppMoveSchema } from "./dto";

describe("app move DTOs", () => {
  it("MoveAckSchema defaults every ack to false and is strict", () => {
    expect(MoveAckSchema.parse({})).toEqual({ hostMounts: false, externalVolumes: false, dropPrivilegedOptions: false, dropGpus: false, resetCpuset: false, hostPortChanged: false, domainChanges: false });
    expect(MoveAckSchema.safeParse({ hostMounts: true, sneaky: true }).success).toBe(false);
    expect(MoveAckSchema.safeParse({ hostMounts: "yes" }).success).toBe(false);
  });

  it("MoveAppPreflightSchema: target required, probeLink defaults false, unknown keys rejected", () => {
    expect(MoveAppPreflightSchema.parse({ targetServerId: "s2" })).toEqual({ targetServerId: "s2", acknowledge: expect.any(Object), probeLink: false });
    expect(MoveAppPreflightSchema.safeParse({}).success).toBe(false);
    expect(MoveAppPreflightSchema.safeParse({ targetServerId: "" }).success).toBe(false);
    expect(MoveAppPreflightSchema.safeParse({ targetServerId: "s2", extra: 1 }).success).toBe(false);
  });

  it("StartAppMoveSchema: confirmName required, archiveRetainDays 0..90 integer (default 7), repointDns default false", () => {
    const ok = StartAppMoveSchema.parse({ targetServerId: "s2", confirmName: "blog" });
    expect(ok).toMatchObject({ repointDns: false, archiveRetainDays: 7 });
    expect(StartAppMoveSchema.safeParse({ targetServerId: "s2" }).success).toBe(false);
    for (const days of [-1, 91, 1.5]) expect(StartAppMoveSchema.safeParse({ targetServerId: "s2", confirmName: "b", archiveRetainDays: days }).success).toBe(false);
    for (const days of [0, 90]) expect(StartAppMoveSchema.safeParse({ targetServerId: "s2", confirmName: "b", archiveRetainDays: days }).success).toBe(true);
    expect(StartAppMoveSchema.safeParse({ targetServerId: "s2", confirmName: "b", planHash: "x" }).success).toBe(false);
  });

  it("AppMoveViewSchema accepts a serialized view (writer-only fields may be null)", () => {
    const view = {
      id: "m", appId: "a", appName: "n", phase: "COMPLETED", prevStatus: "RUNNING", sourceServerId: "s1", targetServerId: "s2",
      volumes: [{ name: "d", state: "APPLIED", sizeBytes: 1, parts: 1, partsDone: 1, bytesDone: 1 }],
      progress: { volumeIndex: 1, volumeCount: 1, bytesDone: 1, bytesTotal: 1 }, warnings: [{ code: "history_splits" }],
      failureReason: null, failurePhase: null, deploymentId: null, cutoverAt: null, finishedAt: null, archiveUntil: null, sourcePurgedAt: null,
      createdAt: new Date().toISOString(), canCancel: false, needsAttention: false, snapshotKept: false, plan: null, acks: null, logTail: null,
    };
    expect(AppMoveViewSchema.safeParse(view).success).toBe(true);
    expect(AppMoveViewSchema.safeParse({ ...view, phase: "NOPE" }).success).toBe(false);
  });
});
