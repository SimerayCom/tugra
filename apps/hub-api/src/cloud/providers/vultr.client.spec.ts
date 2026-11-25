import { VultrApiClient, VultrApiError } from "./vultr.client";

const TOKEN = "SECRET_TOKEN_should_never_leak";

function mockFetch(res: { ok: boolean; status: number; body?: unknown } | Error) {
  const fn = jest.fn();
  if (res instanceof Error) fn.mockRejectedValue(res);
  else fn.mockResolvedValue({ ok: res.ok, status: res.status, json: async () => res.body ?? {} } as Response);
  (global as unknown as { fetch: typeof fetch }).fetch = fn as unknown as typeof fetch;
  return fn;
}

describe("VultrApiClient", () => {
  const client = new VultrApiClient();
  afterEach(() => jest.restoreAllMocks());

  describe("verifyToken", () => {
    it("200 → valid, GET /v2/account with a Bearer token", async () => {
      const fn = mockFetch({ ok: true, status: 200, body: { account: {} } });
      await expect(client.verifyToken(TOKEN)).resolves.toEqual({ valid: true });
      expect(fn).toHaveBeenCalledWith(
        "https://api.vultr.com/v2/account",
        expect.objectContaining({ method: "GET", headers: expect.objectContaining({ authorization: `Bearer ${TOKEN}` }) }),
      );
    });
    it("401 and 403 → invalid (not a throw)", async () => {
      mockFetch({ ok: false, status: 401, body: { error: "Invalid API token.", status: 401 } });
      await expect(client.verifyToken(TOKEN)).resolves.toEqual({ valid: false });
      mockFetch({ ok: false, status: 403, body: {} });
      await expect(client.verifyToken(TOKEN)).resolves.toEqual({ valid: false });
    });
    it("500 → throws", async () => {
      mockFetch({ ok: false, status: 500, body: {} });
      await expect(client.verifyToken(TOKEN)).rejects.toMatchObject({ status: 500 });
    });
    it("network failure → VultrApiError status 0, token NOT in the message", async () => {
      mockFetch(new Error(`ECONNRESET ${TOKEN}`));
      await expect(client.verifyToken(TOKEN)).rejects.toBeInstanceOf(VultrApiError);
      await expect(client.verifyToken(TOKEN)).rejects.toMatchObject({ status: 0 });
      await client.verifyToken(TOKEN).catch((e) => expect((e as Error).message).not.toContain(TOKEN));
    });
  });

  describe("createServer", () => {
    const opts = { name: "srv", location: "fra", serverType: "vc2-2c-4gb", image: "ubuntu-24.04", userData: "#!/bin/sh\necho hi" };

    it("maps curated keys → Vultr values and sends BASE64 cloud-init", async () => {
      const fn = mockFetch({ ok: true, status: 202, body: { instance: { id: "abc-123", main_ip: "0.0.0.0", v6_main_ip: "" } } });
      await client.createServer(TOKEN, opts);
      const [url, init] = fn.mock.calls[0] as [string, { method: string; body: string }];
      expect(url).toBe("https://api.vultr.com/v2/instances");
      expect(init.method).toBe("POST");
      const sent = JSON.parse(init.body);
      expect(sent).toMatchObject({ label: "srv", region: "fra", plan: "vc2-2c-4gb", os_id: 2284 });
      expect(sent.user_data).not.toBe(opts.userData);
      expect(Buffer.from(sent.user_data, "base64").toString("utf8")).toBe(opts.userData);
    });
    it("parses id + main_ip / v6_main_ip when assigned", async () => {
      mockFetch({ ok: true, status: 202, body: { instance: { id: "abc-123", main_ip: "5.6.7.8", v6_main_ip: "2001:19f0::1" } } });
      await expect(client.createServer(TOKEN, opts)).resolves.toEqual({ providerServerId: "abc-123", publicIp: "5.6.7.8", publicIpv6: "2001:19f0::1" });
    });
    it("pending placeholder (0.0.0.0 / empty) → null ips", async () => {
      mockFetch({ ok: true, status: 202, body: { instance: { id: "abc-123", main_ip: "0.0.0.0", v6_main_ip: "" } } });
      await expect(client.createServer(TOKEN, opts)).resolves.toEqual({ providerServerId: "abc-123", publicIp: null, publicIpv6: null });
    });
    it("2xx but no instance.id → 502", async () => {
      mockFetch({ ok: true, status: 202, body: { instance: {} } });
      await expect(client.createServer(TOKEN, opts)).rejects.toMatchObject({ status: 502 });
    });
    it("rejects an unknown curated key without calling the API", async () => {
      const fn = mockFetch({ ok: true, status: 202, body: {} });
      await expect(client.createServer(TOKEN, { ...opts, location: "moon" })).rejects.toMatchObject({ status: 400 });
      await expect(client.createServer(TOKEN, { ...opts, serverType: "huge" })).rejects.toMatchObject({ status: 400 });
      await expect(client.createServer(TOKEN, { ...opts, image: "templeos" })).rejects.toMatchObject({ status: 400 });
      expect(fn).not.toHaveBeenCalled();
    });
    it("provider error surfaces Vultr's message, never the token (even if echoed)", async () => {
      mockFetch({ ok: false, status: 400, body: { error: `Invalid plan ${TOKEN}`, status: 400 } });
      let err: VultrApiError | undefined;
      try {
        await client.createServer(TOKEN, opts);
      } catch (e) {
        err = e as VultrApiError;
      }
      expect(err?.status).toBe(400);
      expect(err?.message).toContain("Invalid plan");
      expect(err?.message).not.toContain(TOKEN);
    });
    it("network failure on createServer → status 0, token NOT in the message", async () => {
      mockFetch(new Error(`ECONNRESET ${TOKEN}`));
      const err = (await client.createServer(TOKEN, opts).then(() => null).catch((e) => e)) as VultrApiError | null;
      expect(err).toBeInstanceOf(VultrApiError);
      expect(err?.status).toBe(0);
      expect(err?.message).not.toContain(TOKEN); // non-vacuous: err is the rejection, asserted directly
    });
  });

  describe("destroyServer", () => {
    it("204 → resolves, DELETE /v2/instances/{id}", async () => {
      const fn = mockFetch({ ok: true, status: 204 });
      await expect(client.destroyServer(TOKEN, "abc-123")).resolves.toBeUndefined();
      expect(fn).toHaveBeenCalledWith("https://api.vultr.com/v2/instances/abc-123", expect.objectContaining({ method: "DELETE" }));
    });
    it("404 → resolves (idempotent)", async () => {
      mockFetch({ ok: false, status: 404, body: { error: "not found" } });
      await expect(client.destroyServer(TOKEN, "abc-123")).resolves.toBeUndefined();
    });
    it("500 → throws", async () => {
      mockFetch({ ok: false, status: 500, body: { error: "boom" } });
      await expect(client.destroyServer(TOKEN, "abc-123")).rejects.toMatchObject({ status: 500 });
    });
  });
});

describe("VultrApiClient price reads", () => {
  const plan = (id: string, cores: number, ramMb: number, disk: number, monthly: number, locationCost: Record<string, unknown> = {}) => ({ id, vcpu_count: cores, ram: ramMb, disk, monthly_cost: monthly, location_cost: locationCost });
  const instance = (id: string, planId: string, region = "fra") => ({ id, plan: planId, region });
  const fresh = () => {
    const c = new VultrApiClient();
    (c as unknown as { reads: { gapMs: number } }).reads.gapMs = 0;
    return c;
  };
  afterEach(() => jest.restoreAllMocks());

  function mockSeq(...bodies: unknown[]) {
    const fn = jest.fn();
    for (const body of bodies) fn.mockResolvedValueOnce({ ok: true, status: 200, json: async () => body } as Response);
    (global as unknown as { fetch: typeof fetch }).fetch = fn as unknown as typeof fetch;
    return fn;
  }

  it("reads each instance's plan and USD monthly price from the plan list, with GET only", async () => {
    const fn = mockSeq(
      { instances: [instance("a1", "vc2-2c-4gb"), instance("b2", "vc2-1c-1gb", "sao")], meta: { links: { next: "" } } },
      { plans: [plan("vc2-2c-4gb", 2, 4096, 80, 20), plan("vc2-1c-1gb", 1, 1024, 25, 5, { sao: { monthly_cost: 7.5 } }), { id: "broken" }], meta: { links: { next: "" } } },
    );
    const out = await fresh().listServerPlans(TOKEN);
    expect(out).toEqual([
      { providerServerId: "a1", plan: { slug: "vc2-2c-4gb", cores: 2, memoryGb: 4, diskGb: 80, architecture: "x86" }, location: "fra", monthlyCents: 2000, currency: "USD" },
      { providerServerId: "b2", plan: { slug: "vc2-1c-1gb", cores: 1, memoryGb: 1, diskGb: 25, architecture: "x86" }, location: "sao", monthlyCents: 750, currency: "USD" },
    ]);
    expect(fn.mock.calls[0][0]).toBe("https://api.vultr.com/v2/instances?per_page=500");
    expect(fn.mock.calls[1][0]).toBe("https://api.vultr.com/v2/plans?type=all&per_page=500");
    for (const call of fn.mock.calls) expect(call[1]).toMatchObject({ method: "GET" });
  });

  it("a plan the list does not know has a null price (never a guess); no instances means no second read", async () => {
    mockSeq({ instances: [instance("a1", "vc2-9c-99gb")] }, { plans: [plan("vc2-2c-4gb", 2, 4096, 80, 20)] });
    const [p] = await fresh().listServerPlans(TOKEN);
    expect(p).toMatchObject({ providerServerId: "a1", monthlyCents: null, plan: { slug: "vc2-9c-99gb" } });
    const fn = mockSeq({ instances: [] });
    expect(await fresh().listServerPlans("another")).toEqual([]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("follows the cursor up to a bound and rejects a plan id that is not a plain slug", async () => {
    const fn = mockSeq({ instances: [instance("a1", "vc2-2c-4gb"), instance("x", "../../etc")], meta: { links: { next: "CUR 1" } } }, { instances: [instance("a2", "vc2-2c-4gb")], meta: { links: { next: "" } } }, { plans: [plan("vc2-2c-4gb", 2, 4096, 80, 20)] });
    const out = await fresh().listServerPlans(TOKEN);
    expect(out.map((p) => p.providerServerId)).toEqual(["a1", "a2"]);
    expect(fn.mock.calls[1][0]).toBe("https://api.vultr.com/v2/instances?per_page=500&cursor=CUR%201");
    const always = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ instances: [instance("a1", "vc2-2c-4gb")], meta: { links: { next: "more" } } }) } as Response);
    (global as unknown as { fetch: typeof fetch }).fetch = always as unknown as typeof fetch;
    await fresh()
      .listServerPlans("bounded")
      .catch(() => undefined);
    expect(always.mock.calls.filter((c) => String(c[0]).includes("/instances")).length).toBe(5);
  });

  it("caches a credential's read and does not cache a failure; the error never carries the token", async () => {
    const c = fresh();
    mockFetch({ ok: false, status: 429, body: { error: `rate limited ${TOKEN}` } });
    await expect(c.listServerPlans(TOKEN)).rejects.toMatchObject({ status: 429 });
    await c.listServerPlans(TOKEN).catch((e) => expect((e as Error).message).not.toContain(TOKEN));
    const fn = mockSeq({ instances: [instance("a1", "vc2-2c-4gb")] }, { plans: [plan("vc2-2c-4gb", 2, 4096, 80, 20)] });
    await c.listServerPlans(TOKEN);
    await c.listServerPlans(TOKEN);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
