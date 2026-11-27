import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { planDelta, recoveryOf, sessionGone } from "./import-recovery";
import type { ImportPlan } from "./types";

const plan = (items: Array<{ itemRef: string; name?: string }>): ImportPlan => ({ items: items.map((i) => ({ kind: "app", name: i.name ?? i.itemRef, ...i })) } as unknown as ImportPlan);

describe("recoveryOf / sessionGone", () => {
  it("reads the hub's stable codes", () => {
    expect(recoveryOf(new ApiError(409, "x", "plan_changed"))).toBe("plan_changed");
    expect(recoveryOf(new ApiError(400, "x", "session_ended"))).toBe("session_ended");
    expect(recoveryOf(new ApiError(500, "x"))).toBeNull();
    expect(recoveryOf(new Error("nope"))).toBeNull();
    expect(recoveryOf(null)).toBeNull();
  });

  it("only an ended or unknown session is gone: an outage, a 5xx, a refused read or a network error keeps it", () => {
    expect(sessionGone(new ApiError(400, "x", "session_ended"))).toBe(true);
    expect(sessionGone(new ApiError(404, "import session not found"))).toBe(true);
    for (const e of [new ApiError(503, "agent offline"), new ApiError(409, "x", "agent_offline"), new ApiError(403, "x", "not_enabled"), new ApiError(500, "boom"), new ApiError(400, "x", "agent_read_failed"), new TypeError("Failed to fetch")]) {
      expect(sessionGone(e)).toBe(false);
    }
  });
});

describe("planDelta", () => {
  it("counts the items that are new, gone or changed since the last read", () => {
    const a = plan([{ itemRef: "app:s:1" }, { itemRef: "app:s:2" }, { itemRef: "app:s:3", name: "old" }]);
    const b = plan([{ itemRef: "app:s:1" }, { itemRef: "app:s:3", name: "new" }, { itemRef: "app:s:4" }]);
    expect(planDelta(a, b)).toEqual({ added: 1, removed: 1, changed: 1 });
    expect(planDelta(a, a)).toEqual({ added: 0, removed: 0, changed: 0 });
    expect(planDelta(null, a)).toEqual({ added: 0, removed: 0, changed: 0 });
  });
});
