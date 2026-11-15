import { FileOpLimiter } from "./fs-limiter";
import { FsRateLimitedException } from "./fs-errors";

describe("FileOpLimiter", () => {
  it("allows up to max mutations per window then 429s with Retry-After", () => {
    const l = new FileOpLimiter(3, 60_000);
    l.take("u1", 1_000);
    l.take("u1", 2_000);
    l.take("u1", 3_000);
    let err: unknown;
    try {
      l.take("u1", 4_000);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FsRateLimitedException);
    expect((err as FsRateLimitedException).getStatus()).toBe(429);
    expect((err as FsRateLimitedException).retryAfterSec).toBe(57); // oldest hit (1s) leaves the window at 61s
  });

  it("is per user and slides", () => {
    const l = new FileOpLimiter(1, 60_000);
    l.take("u1", 0);
    expect(() => l.take("u2", 1)).not.toThrow();
    expect(() => l.take("u1", 59_999)).toThrow(FsRateLimitedException);
    expect(() => l.take("u1", 60_001)).not.toThrow();
  });
});
