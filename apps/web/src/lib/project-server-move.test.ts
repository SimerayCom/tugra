import { describe, it, expect } from "vitest";
import { ApiError } from "./api";
import { blockersOf, moveCanCancel, moveErrorKey, moveHasSafetyCopy, moveIsActive, parseWarning, soleServerName, targetServers } from "./project-server-move";

describe("phases", () => {
  it("a move is active until it ends; cancel only before an app is cut over", () => {
    for (const phase of ["QUEUED", "PRECHECK", "MOVING", "VERIFYING", "CUTOVER", "ROLLING_BACK"] as const) expect(moveIsActive({ phase })).toBe(true);
    for (const phase of ["COMPLETED", "ROLLED_BACK", "FAILED"] as const) expect(moveIsActive({ phase })).toBe(false);
    expect(moveIsActive(null)).toBe(false);
    expect(["QUEUED", "PRECHECK", "MOVING"].every((phase) => moveCanCancel({ phase: phase as "QUEUED" }))).toBe(true);
    expect(["VERIFYING", "CUTOVER", "COMPLETED", "FAILED"].some((phase) => moveCanCancel({ phase: phase as "FAILED" }))).toBe(false);
  });
  it("only a completed move with a retention date has a safety copy", () => {
    expect(moveHasSafetyCopy({ phase: "COMPLETED", archiveUntil: "2026-12-03T00:00:00Z" })).toBe(true);
    expect(moveHasSafetyCopy({ phase: "COMPLETED", archiveUntil: null })).toBe(false);
    expect(moveHasSafetyCopy({ phase: "MOVING", archiveUntil: "2026-12-03T00:00:00Z" })).toBe(false);
  });
});

describe("errors", () => {
  it("maps the hub's codes to lines", () => {
    expect(moveErrorKey(new ApiError(409, "x", "project_move_active"))).toBe("projectMove.error.project_move_active");
    expect(moveErrorKey(new ApiError(403, "owner"))).toBe("projectMove.error.forbidden");
    expect(moveErrorKey(new ApiError(500, "x"))).toBe("projectMove.error.generic");
  });
  it("reads the blockers of a refused start, and nothing from any other error", () => {
    const blockers = [{ code: "same_server" }];
    expect(blockersOf(new ApiError(409, "x", "preflight_failed", { blockers }))).toEqual(blockers);
    expect(blockersOf(new ApiError(409, "x", "other", { blockers }))).toBeNull();
    expect(blockersOf(new Error("x"))).toBeNull();
  });
});

describe("helpers", () => {
  it("parses a stored warning", () => {
    expect(parseWarning("pitr_not_carried:main")).toEqual({ code: "pitr_not_carried", ref: "main" });
    expect(parseWarning("items_left_behind")).toEqual({ code: "items_left_behind" });
  });
  it("targets are the team's online servers except the one the project is on", () => {
    const servers = [
      { id: "1", name: "a", teamId: "t", status: "ONLINE" },
      { id: "2", name: "b", teamId: "t", status: "ONLINE" },
      { id: "3", name: "c", teamId: "t", status: "OFFLINE" },
      { id: "4", name: "d", teamId: "other", status: "ONLINE" },
    ];
    expect(targetServers(servers, "t", ["a"]).map((s) => s.id)).toEqual(["2"]);
    expect(targetServers(servers, "t", []).map((s) => s.id)).toEqual(["1", "2"]);
  });
  it("names the one server a project sits on, or none when it is spread", () => {
    expect(soleServerName([{ serverName: "a" }, { serverName: "a" }, { serverName: null }])).toEqual(["a"]);
    expect(soleServerName([{ serverName: "a" }, { serverName: "b" }])).toEqual([]);
  });
});
