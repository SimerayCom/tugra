import { CONTROL_ERROR_CODES, ControlError, CoolifyControl, coolifyRefOf, parseCoolifyStatus, type ControlTransportResponse, type CoolifyControlTransport } from "./coolify-control";

class FakeTransport implements CoolifyControlTransport {
  calls: Array<{ method: string; path: string }> = [];
  constructor(private readonly answer: (method: string, path: string) => ControlTransportResponse) {}
  async request(method: "GET" | "POST", path: string): Promise<ControlTransportResponse> {
    this.calls.push({ method, path });
    return this.answer(method, path);
  }
}

describe("coolifyRefOf", () => {
  it("maps the importer itemRefs to a Coolify kind + uuid", () => {
    expect(coolifyRefOf("app:srv1:abc123")).toEqual({ kind: "application", uuid: "abc123" });
    expect(coolifyRefOf("service:_:s-9")).toEqual({ kind: "service", uuid: "s-9" });
    expect(coolifyRefOf("database:srv1:db_1")).toEqual({ kind: "database", uuid: "db_1" });
  });
  it("refuses anything that is not a plain three-part ref with a safe uuid", () => {
    for (const bad of ["app:srv1", "volume:srv1:abc:data", "app:srv1:../x", "app:srv1:a b", "app:srv1:", "app:srv1:-x", "x"]) {
      expect(coolifyRefOf(bad)).toBeNull();
    }
  });
});

describe("parseCoolifyStatus", () => {
  it.each([
    ["running:healthy", "running"],
    ["running:unhealthy", "running"],
    ["Running", "running"],
    ["exited:unhealthy", "stopped"],
    ["stopped", "stopped"],
    ["degraded:unhealthy", "unknown"],
    ["restarting", "unknown"],
    ["", "unknown"],
    [null, "unknown"],
    [42, "unknown"],
  ])("%p -> %s", (raw, want) => {
    expect(parseCoolifyStatus(raw)).toBe(want);
  });
});

describe("CoolifyControl", () => {
  it("reads the state from GET /<collection>/<uuid>", async () => {
    const t = new FakeTransport(() => ({ status: 200, body: { status: "running:healthy", name: "x" } }));
    await expect(new CoolifyControl(t).state("application", "abc")).resolves.toBe("running");
    expect(t.calls).toEqual([{ method: "GET", path: "/applications/abc" }]);
    const t2 = new FakeTransport(() => ({ status: 200, body: { status: "exited" } }));
    await expect(new CoolifyControl(t2).state("database", "d1")).resolves.toBe("stopped");
    expect(t2.calls[0].path).toBe("/databases/d1");
    const t3 = new FakeTransport(() => ({ status: 200, body: { status: "degraded" } }));
    await expect(new CoolifyControl(t3).state("service", "s1")).resolves.toBe("unknown");
  });

  it("an unparseable state answer is a bad-response, never a guess", async () => {
    const t = new FakeTransport(() => ({ status: 200, body: null }));
    await expect(new CoolifyControl(t).state("application", "abc")).rejects.toMatchObject({ code: "bad-response" });
  });

  it("start tries POST; a stop sends docker_cleanup=false so Coolify does not prune the source host", async () => {
    const post = new FakeTransport(() => ({ status: 200, body: { message: "ok" } }));
    await new CoolifyControl(post).stop("application", "abc");
    await new CoolifyControl(post).stop("database", "d1");
    await new CoolifyControl(post).start("service", "s1");
    expect(post.calls).toEqual([
      { method: "POST", path: "/applications/abc/stop?docker_cleanup=false" },
      { method: "POST", path: "/databases/d1/stop?docker_cleanup=false" },
      { method: "POST", path: "/services/s1/start" },
    ]);
  });

  it("falls back to GET only on a 405 (an older Coolify exposes start/stop as GET)", async () => {
    const getOnly = new FakeTransport((m) => (m === "POST" ? { status: 405, body: null } : { status: 200, body: { message: "ok" } }));
    await new CoolifyControl(getOnly).start("service", "s1");
    expect(getOnly.calls).toEqual([
      { method: "POST", path: "/services/s1/start" },
      { method: "GET", path: "/services/s1/start" },
    ]);
  });

  it("a POST 404 stays not-found and is NOT retried as GET (4.7.5 answers 405 to every GET start/stop, which would hide it)", async () => {
    const t = new FakeTransport((m) => (m === "POST" ? { status: 404, body: { message: "Resource not found." } } : { status: 405, body: null }));
    await expect(new CoolifyControl(t).stop("application", "gone")).rejects.toMatchObject({ code: "not-found" });
    await expect(new CoolifyControl(t).start("database", "gone")).rejects.toMatchObject({ code: "not-found" });
    expect(t.calls.map((c) => c.method)).toEqual(["POST", "POST"]);
  });

  it("is idempotent on 4.7.5: 400 already stopped / already running is the wanted state", async () => {
    const stopped = new FakeTransport(() => ({ status: 400, body: { message: "Database is already stopped." } }));
    await expect(new CoolifyControl(stopped).stop("database", "d1")).resolves.toBeUndefined();
    const svcStopped = new FakeTransport(() => ({ status: 400, body: { message: "Service is already stopped." } }));
    await expect(new CoolifyControl(svcStopped).stop("service", "s1")).resolves.toBeUndefined();
    const running = new FakeTransport(() => ({ status: 400, body: { message: "Database is already running." } }));
    await expect(new CoolifyControl(running).start("database", "d1")).resolves.toBeUndefined();
    const svcRunning = new FakeTransport(() => ({ status: 400, body: { message: "Service is already running." } }));
    await expect(new CoolifyControl(svcRunning).start("service", "s1")).resolves.toBeUndefined();
    expect(running.calls).toHaveLength(1);
  });

  it("a 400 that is not the already-in-state answer is still rejected, and the wrong direction is not success", async () => {
    const other = new FakeTransport(() => ({ status: 400, body: { message: "Public port already used by another database." } }));
    await expect(new CoolifyControl(other).stop("database", "d1")).rejects.toMatchObject({ code: "rejected" });
    const wrongWay = new FakeTransport(() => ({ status: 400, body: { message: "Database is already running." } }));
    await expect(new CoolifyControl(wrongWay).stop("database", "d1")).rejects.toMatchObject({ code: "rejected" });
    const noBody = new FakeTransport(() => ({ status: 400, body: null }));
    await expect(new CoolifyControl(noBody).start("service", "s1")).rejects.toMatchObject({ code: "rejected" });
  });

  it("a 429 is the retryable rate-limited code, not a generic rejection", async () => {
    const t = new FakeTransport(() => ({ status: 429, body: { message: "Too Many Attempts." } }));
    await expect(new CoolifyControl(t).stop("application", "abc")).rejects.toMatchObject({ code: "rate-limited" });
    await expect(new CoolifyControl(t).state("application", "abc")).rejects.toMatchObject({ code: "rate-limited" });
    expect(CONTROL_ERROR_CODES).toContain("rate-limited");
  });

  it("does not retry a 403/401/5xx with the other verb", async () => {
    for (const [status, code] of [[403, "forbidden"], [401, "unauthorized"], [500, "unreachable"], [422, "rejected"]] as const) {
      const t = new FakeTransport(() => ({ status, body: null }));
      await expect(new CoolifyControl(t).stop("application", "abc")).rejects.toMatchObject({ code });
      expect(t.calls).toHaveLength(1);
    }
  });

  it("rejects an unsafe uuid before any request is made", async () => {
    const t = new FakeTransport(() => ({ status: 200, body: {} }));
    const c = new CoolifyControl(t);
    await expect(c.stop("application", "../../servers")).rejects.toBeInstanceOf(ControlError);
    await expect(c.state("application", "a/b")).rejects.toBeInstanceOf(ControlError);
    expect(t.calls).toHaveLength(0);
  });

  it("errors never carry remote text: the message is the fixed code", async () => {
    const t = new FakeTransport(() => ({ status: 403, body: { message: "token abc123secret may not stop" } }));
    const err = (await new CoolifyControl(t).stop("application", "abc").then(() => null, (e: unknown) => e)) as ControlError;
    expect(err.message).toBe("forbidden");
    expect(JSON.stringify(err)).not.toContain("abc123secret");
  });

  it("the real client refuses a loopback/metadata base URL up front (SSRF guard)", () => {
    expect(() => CoolifyControl.http("http://127.0.0.1:8000", "t")).toThrow();
    expect(() => CoolifyControl.http("http://169.254.169.254", "t")).toThrow();
    expect(() => CoolifyControl.http("ftp://coolify.example.com", "t")).toThrow();
    expect(() => CoolifyControl.http("https://user:pw@coolify.example.com", "t")).toThrow();
    expect(() => CoolifyControl.http("https://coolify.example.com", "t")).not.toThrow();
  });
});
