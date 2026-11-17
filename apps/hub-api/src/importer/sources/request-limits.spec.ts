import {
  AUTH_401_TRIP,
  AUTH_FAILURE_TRIP,
  AuthBreaker,
  AuthPausedError,
  LimitsRegistry,
  PACED_REQUESTS_PER_MIN,
  PACE_BURST,
  RateLimitedError,
  TokenBucket,
  parseRetryAfterMs,
  type Clock,
  type LimitedResponse,
} from "./request-limits";

class FakeClock implements Clock {
  t = 1_700_000_000_000;
  slept: number[] = [];
  now() {
    return this.t;
  }
  async sleep(ms: number) {
    this.slept.push(ms);
    this.t += ms;
  }
}

const BASE = "https://coolify.example.com";

describe("parseRetryAfterMs", () => {
  it("reads delta-seconds and HTTP dates, floors at one second, and ignores junk", () => {
    expect(parseRetryAfterMs("30", 0)).toBe(30_000);
    expect(parseRetryAfterMs("0", 0)).toBe(1_000);
    expect(parseRetryAfterMs(new Date(5_000).toUTCString(), 0)).toBe(5_000);
    expect(parseRetryAfterMs(new Date(0).toUTCString(), 10_000)).toBe(1_000);
    for (const bad of [undefined, null, "", "soon"]) expect(parseRetryAfterMs(bad, 0)).toBeNull();
  });
});

describe("TokenBucket", () => {
  it("lets a burst through, then paces to the configured rate", () => {
    const c = new FakeClock();
    const b = new TokenBucket(PACED_REQUESTS_PER_MIN, PACE_BURST, c);
    for (let i = 0; i < PACE_BURST; i++) expect(b.reserve()).toBe(0);
    // 150/min = one slot every 400 ms; slots are handed out in call order so concurrent callers queue
    expect(b.reserve()).toBe(400);
    expect(b.reserve()).toBe(800);
    expect(b.reserve()).toBe(1200);
    c.t += 1200;
    expect(b.reserve()).toBe(400 * 1); // the queue drained to the pace, never faster
  });

  it("never lets a sustained caller exceed the pace (well under Coolify's 200 a minute)", async () => {
    const c = new FakeClock();
    const b = new TokenBucket(PACED_REQUESTS_PER_MIN, PACE_BURST, c);
    const start = c.t;
    let sent = 0;
    while (c.t - start < 60_000) {
      const w = b.reserve();
      if (w > 0) await c.sleep(w);
      sent++;
    }
    expect(sent).toBeLessThanOrEqual(PACED_REQUESTS_PER_MIN + PACE_BURST + 1);
    expect(sent).toBeGreaterThan(PACED_REQUESTS_PER_MIN - 5);
  });

  it("a 429's Retry-After blocks every caller until then", () => {
    const c = new FakeClock();
    const b = new TokenBucket(PACED_REQUESTS_PER_MIN, PACE_BURST, c);
    b.blockUntil(c.t + 7_000);
    expect(b.reserve()).toBe(7_000);
    c.t += 7_000;
    expect(b.reserve()).toBe(0);
  });
});

describe("AuthBreaker", () => {
  it("trips after a few consecutive 401s (an invalid token fails every request)", () => {
    const c = new FakeClock();
    const br = new AuthBreaker(c);
    for (let i = 0; i < AUTH_401_TRIP - 1; i++) br.record(401);
    expect(br.state().kind).toBe("ok");
    br.record(401);
    expect(br.state()).toMatchObject({ kind: "auth", status: 401 });
    c.t += 61_000;
    expect(br.state().kind).toBe("ok");
  });

  it("a success between 401s resets the 401 run", () => {
    const br = new AuthBreaker(new FakeClock());
    br.record(401);
    br.record(401);
    br.record(200);
    br.record(401);
    expect(br.state().kind).toBe("ok");
  });

  it("trips on many 403s inside the minute, below Coolify's own limit of 30, even with successes between", () => {
    expect(AUTH_FAILURE_TRIP).toBeLessThan(30);
    const c = new FakeClock();
    const br = new AuthBreaker(c);
    for (let i = 0; i < AUTH_FAILURE_TRIP - 1; i++) {
      br.record(403);
      br.record(200);
    }
    expect(br.state().kind).toBe("ok");
    br.record(403);
    expect(br.state()).toMatchObject({ kind: "auth", status: 403 });
  });

  it("403s spread over more than a minute never trip it; 404 and 5xx never count", () => {
    const c = new FakeClock();
    const br = new AuthBreaker(c);
    for (let i = 0; i < 100; i++) {
      br.record(403);
      c.t += 5_000;
    }
    for (let i = 0; i < 100; i++) {
      br.record(404);
      br.record(500);
    }
    expect(br.state().kind).toBe("ok");
  });
});

describe("RequestLimits.run", () => {
  const make = () => {
    const clock = new FakeClock();
    const limits = new LimitsRegistry(clock).for(BASE, "tok-A");
    return { clock, limits };
  };
  const seq = (...resps: LimitedResponse[]) => {
    let i = 0;
    const calls = { n: 0 };
    return { send: async () => ((calls.n++, resps[Math.min(i++, resps.length - 1)])), calls };
  };

  it("waits out a bounded Retry-After and retries, then returns the answer", async () => {
    const { clock, limits } = make();
    const { send, calls } = seq({ status: 429, retryAfter: "5" }, { status: 429, retryAfter: "2" }, { status: 200 });
    await expect(limits.run(send)).resolves.toMatchObject({ status: 200 });
    expect(calls.n).toBe(3);
    expect(clock.slept).toEqual([5_000, 2_000]);
  });

  it("gives up after the retry budget with a stable rate-limited error", async () => {
    const { limits } = make();
    const { send, calls } = seq({ status: 429, retryAfter: "1" });
    const err = await limits.run(send).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).code).toBe("rate-limited");
    expect(calls.n).toBe(4); // first try + 3 retries
  });

  it("a Retry-After longer than the bound (a token lockout) is not waited for, and the token is then not poked again", async () => {
    const { clock, limits } = make();
    const { send, calls } = seq({ status: 429, retryAfter: "300" });
    const err = (await limits.run(send).catch((e: unknown) => e)) as RateLimitedError;
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err.retryAfterSec).toBe(300);
    expect(clock.slept).toEqual([]);
    expect(calls.n).toBe(1);
    await expect(limits.run(send)).rejects.toBeInstanceOf(RateLimitedError); // fails fast, no request sent
    expect(calls.n).toBe(1);
    clock.t += 301_000;
    await expect(limits.run(async () => ({ status: 200 }))).resolves.toMatchObject({ status: 200 });
  });

  it("a missing Retry-After uses a default wait", async () => {
    const { clock, limits } = make();
    await limits.run(seq({ status: 429 }, { status: 200 }).send);
    expect(clock.slept).toEqual([10_000]);
  });

  it("repeated 401s stop the requests so a bad token is not locked out", async () => {
    const { limits } = make();
    const { send, calls } = seq({ status: 401 });
    for (let i = 0; i < AUTH_401_TRIP; i++) await expect(limits.run(send)).resolves.toMatchObject({ status: 401 });
    await expect(limits.run(send)).rejects.toBeInstanceOf(AuthPausedError);
    expect(calls.n).toBe(AUTH_401_TRIP); // the next call was refused locally
  });

  it("a 429 on one caller holds the other callers of the same base URL back (one shared bucket), another base URL is independent", async () => {
    const clock = new FakeClock();
    const reg = new LimitsRegistry(clock);
    const a = reg.for(BASE, "tok-A");
    const b = reg.for(BASE, "tok-B");
    const other = reg.for("https://other.example.com", "tok-A");
    await a.run(seq({ status: 429, retryAfter: "20" }, { status: 200 }).send);
    expect(clock.slept).toEqual([20_000]);
    // the wait elapsed on the shared clock, so b is free again but did share the same bucket (same token count)
    const bw = await b.run(async () => ({ status: 200 }));
    expect(bw.status).toBe(200);
    // a lockout on tok-A does not pause tok-B (the breaker is per token)
    await a.run(seq({ status: 429, retryAfter: "900" }).send).catch(() => undefined);
    await expect(b.run(async () => ({ status: 200 }))).resolves.toMatchObject({ status: 200 });
    await expect(other.run(async () => ({ status: 200 }))).resolves.toMatchObject({ status: 200 });
  });

  it("concurrent callers of one base URL are paced as a group", async () => {
    const clock = new FakeClock();
    const reg = new LimitsRegistry(clock);
    const callers = Array.from({ length: 5 }, () => reg.for(BASE, "tok-A"));
    await Promise.all(Array.from({ length: PACE_BURST + 5 }, (_, i) => callers[i % 5].run(async () => ({ status: 200 }))));
    expect(clock.slept.length).toBe(5); // only the requests beyond the burst waited
    expect(clock.slept[0]).toBeGreaterThan(0);
  });
});
