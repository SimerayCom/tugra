import { MonitorStatus } from "@prisma/client";
import { nextState, uptimePercent } from "./transition";

const opts = { retries: 1, resendEvery: 0 };
const base = { status: MonitorStatus.PENDING, failCount: 0, downCount: 0 };

describe("monitor transition", () => {
  it("goes UP on success and flags recovery as important", () => {
    const fromDown = nextState({ ...base, status: MonitorStatus.DOWN }, true, opts);
    expect(fromDown.status).toBe("UP");
    expect(fromDown.important).toBe(true);

    const fromUp = nextState({ ...base, status: MonitorStatus.UP }, true, opts);
    expect(fromUp.important).toBe(false);
  });

  it("stays PENDING until retries are exhausted, then DOWN (important once)", () => {
    const first = nextState({ ...base, status: MonitorStatus.UP }, false, opts);
    expect(first.status).toBe("PENDING");
    expect(first.important).toBe(false);

    const second = nextState(first, false, opts);
    expect(second.status).toBe("DOWN");
    expect(second.important).toBe(true);

    const third = nextState(second, false, opts);
    expect(third.status).toBe("DOWN");
    expect(third.important).toBe(false); // already down → no spam
  });

  it("re-notifies every resendEvery down beats", () => {
    let s = nextState({ ...base, status: MonitorStatus.UP }, false, { retries: 0, resendEvery: 2 });
    expect(s.status).toBe("DOWN"); // retries 0 → down immediately
    expect(s.important).toBe(true);
    s = nextState(s, false, { retries: 0, resendEvery: 2 });
    expect(s.important).toBe(true); // downCount 2 → resend
  });

  it("computes uptime percentage", () => {
    expect(uptimePercent(9, 10)).toBe(90);
    expect(uptimePercent(0, 0)).toBe(0);
  });
});
