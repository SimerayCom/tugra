import { ControlError, CoolifyControl, coolifyRefOf, parseCoolifyStatus, type ControlTransportResponse, type CoolifyControlTransport } from "./coolify-control";

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

  it("stop/start try POST first and fall back to GET only on 404/405", async () => {
    const post = new FakeTransport(() => ({ status: 200, body: { message: "ok" } }));
    await new CoolifyControl(post).stop("application", "abc");
    expect(post.calls).toEqual([{ method: "POST", path: "/applications/abc/stop" }]);

    const getOnly = new FakeTransport((m) => (m === "POST" ? { status: 405, body: null } : { status: 200, body: { message: "ok" } }));
    await new CoolifyControl(getOnly).start("service", "s1");
    expect(getOnly.calls).toEqual([
      { method: "POST", path: "/services/s1/start" },
      { method: "GET", path: "/services/s1/start" },
    ]);
  });

  it("does not retry a 403/401/5xx with the other verb", async () => {
    for (const [status, code] of [[403, "forbidden"], [401, "unauthorized"], [500, "unreachable"], [422, "rejected"]] as const) {
      const t = new FakeTransport(() => ({ status, body: null }));
      await expect(new CoolifyControl(t).stop("application", "abc")).rejects.toMatchObject({ code });
      expect(t.calls).toHaveLength(1);
    }
  });

  it("a resource that really does not exist is not-found after the GET fallback", async () => {
    const t = new FakeTransport(() => ({ status: 404, body: null }));
    await expect(new CoolifyControl(t).stop("application", "gone")).rejects.toMatchObject({ code: "not-found" });
    expect(t.calls.map((c) => c.method)).toEqual(["POST", "GET"]);
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
