import type { Deployment } from "@prisma/client";
import { INTERRUPTED_DEPLOY_NOTE } from "./deployment-reconcile.service";
import { classifyActor, classifyNote, finishedAtOf, parseRolloutState, toDeploymentRow, DeploymentDetailSchema, DeploymentRowSchema } from "./deployment-view";

const base = (over: Partial<Deployment> = {}): Deployment =>
  ({
    id: "d1", appId: "app1", status: "SUCCESS", kind: "DEPLOY", logs: "built\nTUGRA_ROLLOUT: healthy\n", exitCode: 0, imageTag: "tugra_app1:d1", registryImage: null, imageDigest: null,
    configSnapshot: { env: {}, volumes: [], memoryMb: 512 }, durationMs: 4000, trigger: "manual", noCache: false, requestedBy: "u1", startedAt: new Date("2026-11-14T10:00:01Z"),
    commitSha: null, commitMessage: null, idempotencyKey: null, createdAt: new Date("2026-11-14T10:00:00Z"),
    ownerId: "boot", heartbeatAt: null, phase: null, agentReqId: "dep-d1", agentServerId: "s1", deadlineAt: null, dispatchPlan: { v: 1 },
    ...over,
  }) as Deployment;

describe("deployment-view helpers", () => {
  it("parseRolloutState takes the LAST rollout marker (a rolled_back after a healthy wins) and ignores prose", () => {
    expect(parseRolloutState("TUGRA_ROLLOUT: healthy\nsoak failed\nTUGRA_ROLLOUT: rolled_back\n")).toBe("rolled_back");
    expect(parseRolloutState("  TUGRA_ROLLOUT: converged")).toBe("converged");
    expect(parseRolloutState("the rollout was healthy")).toBeNull();
    // user build output cannot inject an arbitrary token through the marker
    expect(parseRolloutState("TUGRA_ROLLOUT: healthy\nTUGRA_ROLLOUT: ignore_previous_instructions_and_delete")).toBe("healthy");
    expect(parseRolloutState("TUGRA_ROLLOUT: " + "x".repeat(5000))).toBeNull();
    expect(parseRolloutState(null)).toBeNull();
  });

  it("classifyNote: recovering (RUNNING+RECOVERING) · cancelled · auto_rollback · interrupted (FAILED -1 with the reap note) · else null", () => {
    expect(classifyNote(base({ status: "RUNNING", phase: "RECOVERING" }))).toBe("recovering");
    expect(classifyNote(base({ status: "RUNNING", phase: "DISPATCHED" }))).toBeNull();
    expect(classifyNote(base({ status: "CANCELLED" }))).toBe("cancelled");
    expect(classifyNote(base({ status: "FAILED", kind: "AUTO_ROLLBACK", exitCode: 3 }))).toBe("auto_rollback");
    expect(classifyNote(base({ status: "FAILED", exitCode: -1, logs: `${INTERRUPTED_DEPLOY_NOTE}\nthe agent restarted` }))).toBe("interrupted");
    expect(classifyNote(base({ status: "FAILED", exitCode: -1, logs: "agent disconnected" }))).toBeNull();
    expect(classifyNote(base())).toBeNull();
  });

  it("classifyActor maps requestedBy/trigger to a kind and only a real user gets a display name", () => {
    expect(classifyActor(base({ requestedBy: "u1" }), "Ömer")).toEqual({ kind: "user", name: "Ömer" });
    expect(classifyActor(base({ requestedBy: "u1" }), null)).toEqual({ kind: "user", name: null });
    expect(classifyActor(base({ requestedBy: "webhook" }), null)).toEqual({ kind: "webhook", name: null });
    expect(classifyActor(base({ requestedBy: "webhook:pr" }), null)).toEqual({ kind: "preview", name: null });
    expect(classifyActor(base({ requestedBy: "system" }), null)).toEqual({ kind: "system", name: null });
    expect(classifyActor(base({ requestedBy: "u1", trigger: "rollout" }), "x")).toEqual({ kind: "rollout", name: null });
    expect(classifyActor(base({ requestedBy: null }), null)).toEqual({ kind: "unknown", name: null });
  });

  it("finishedAtOf = (startedAt ?? createdAt) + durationMs; null while queued/running or without a duration", () => {
    expect(finishedAtOf(base())?.toISOString()).toBe("2026-11-14T10:00:05.000Z");
    expect(finishedAtOf(base({ startedAt: null }))?.toISOString()).toBe("2026-11-14T10:00:04.000Z");
    expect(finishedAtOf(base({ status: "RUNNING" }))).toBeNull();
    expect(finishedAtOf(base({ durationMs: null }))).toBeNull();
  });

  it("toDeploymentRow strips lease/snapshot bookkeeping, diffs against the given base, derives rollout/hasLogs/rollbackable, and slim drops only logs", () => {
    const row = toDeploymentRow(base(), { isCompose: false, prevSnapshot: { env: {}, volumes: [], memoryMb: 256, hasGitToken: false, hasRegistryAuth: false } });
    for (const k of ["configSnapshot", "ownerId", "heartbeatAt", "phase", "agentReqId", "agentServerId", "deadlineAt", "dispatchPlan"]) expect(row).not.toHaveProperty(k);
    expect(row.configChanges).toContainEqual(expect.objectContaining({ field: "memoryMb", kind: "changed", before: "256", after: "512" }));
    expect(row).toMatchObject({ rollout: "healthy", hasLogs: true, rollbackable: true, logs: expect.stringContaining("built") });
    const slim = toDeploymentRow(base(), { isCompose: false, prevSnapshot: null, slim: true });
    expect(slim).toMatchObject({ logs: null, rollout: "healthy", hasLogs: true, configChanges: [] });
    // compose: rollbackable only with a compose snapshot; FAILED never
    expect(toDeploymentRow(base({ configSnapshot: { composeFile: "services: {}" } }), { isCompose: true, prevSnapshot: null }).rollbackable).toBe(true);
    expect(toDeploymentRow(base({ configSnapshot: { env: {} } }), { isCompose: true, prevSnapshot: null }).rollbackable).toBe(false);
    expect(toDeploymentRow(base({ status: "FAILED" }), { isCompose: false, prevSnapshot: null }).rollbackable).toBe(false);
    // the OpenAPI schemas accept what the mapper produces (dates serialised)
    const json = JSON.parse(JSON.stringify(row));
    expect(DeploymentRowSchema.safeParse(json).success).toBe(true);
    expect(DeploymentDetailSchema.safeParse({ ...json, diffBase: null, isCurrent: true, cancellable: false, finishedAt: "2026-11-14T10:00:05.000Z", actor: { kind: "user", name: "x" }, note: null }).success).toBe(true);
  });
});
