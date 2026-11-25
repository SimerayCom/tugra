import { DigitalOceanApiClient, DigitalOceanApiError } from "./digitalocean.client";

const TOKEN = "SECRET_TOKEN_should_never_leak";

function mockFetch(res: { ok: boolean; status: number; body?: unknown } | Error) {
  const fn = jest.fn();
  if (res instanceof Error) fn.mockRejectedValue(res);
  else fn.mockResolvedValue({ ok: res.ok, status: res.status, json: async () => res.body ?? {} } as Response);
  (global as unknown as { fetch: typeof fetch }).fetch = fn as unknown as typeof fetch;
  return fn;
}

describe("DigitalOceanApiClient", () => {
  const client = new DigitalOceanApiClient();
  afterEach(() => jest.restoreAllMocks());

  describe("verifyToken", () => {
    it("200 → valid, GET /v2/account with a Bearer token", async () => {
      const fn = mockFetch({ ok: true, status: 200, body: { account: {} } });
      await expect(client.verifyToken(TOKEN)).resolves.toEqual({ valid: true });
      expect(fn).toHaveBeenCalledWith(
        "https://api.digitalocean.com/v2/account",
        expect.objectContaining({ method: "GET", headers: expect.objectContaining({ authorization: `Bearer ${TOKEN}` }) }),
      );
    });
    it("401 and 403 → invalid (not a throw)", async () => {
      mockFetch({ ok: false, status: 401, body: { id: "unauthorized", message: "Unable to authenticate you" } });
      await expect(client.verifyToken(TOKEN)).resolves.toEqual({ valid: false });
      mockFetch({ ok: false, status: 403, body: {} });
      await expect(client.verifyToken(TOKEN)).resolves.toEqual({ valid: false });
    });
    it("500 → throws", async () => {
      mockFetch({ ok: false, status: 500, body: {} });
      await expect(client.verifyToken(TOKEN)).rejects.toMatchObject({ status: 500 });
    });
    it("network failure → DigitalOceanApiError status 0, token NOT in the message", async () => {
      mockFetch(new Error(`ECONNRESET ${TOKEN}`));
      await expect(client.verifyToken(TOKEN)).rejects.toBeInstanceOf(DigitalOceanApiError);
      await expect(client.verifyToken(TOKEN)).rejects.toMatchObject({ status: 0 });
      await client.verifyToken(TOKEN).catch((e) => expect((e as Error).message).not.toContain(TOKEN));
    });
  });

  describe("createServer", () => {
    const opts = { name: "srv", location: "fra1", serverType: "s-2vcpu-4gb", image: "ubuntu-24.04", userData: "#!/bin/sh\necho hi" };

    it("maps curated keys → DO values, sends raw cloud-init, no ssh_keys", async () => {
      const fn = mockFetch({ ok: true, status: 202, body: { droplet: { id: 99, networks: {} } } });
      await client.createServer(TOKEN, opts);
      const [url, init] = fn.mock.calls[0] as [string, { method: string; body: string }];
      expect(url).toBe("https://api.digitalocean.com/v2/droplets");
      expect(init.method).toBe("POST");
      const sent = JSON.parse(init.body);
      expect(sent).toMatchObject({ name: "srv", region: "fra1", size: "s-2vcpu-4gb", image: "ubuntu-24-04-x64", user_data: opts.userData });
      expect(sent.ssh_keys).toBeUndefined();
    });
    it("parses id + public v4/v6 when present", async () => {
      mockFetch({
        ok: true,
        status: 202,
        body: {
          droplet: {
            id: 99,
            networks: {
              v4: [
                { ip_address: "10.0.0.5", type: "private" },
                { ip_address: "1.2.3.4", type: "public" },
              ],
              v6: [{ ip_address: "2a03::1", type: "public" }],
            },
          },
        },
      });
      await expect(client.createServer(TOKEN, opts)).resolves.toEqual({ providerServerId: "99", publicIp: "1.2.3.4", publicIpv6: "2a03::1" });
    });
    it("no networks yet → null ips", async () => {
      mockFetch({ ok: true, status: 202, body: { droplet: { id: 7, networks: { v4: [], v6: [] } } } });
      await expect(client.createServer(TOKEN, opts)).resolves.toEqual({ providerServerId: "7", publicIp: null, publicIpv6: null });
    });
    it("2xx but no droplet.id → 502", async () => {
      mockFetch({ ok: true, status: 202, body: { droplet: {} } });
      await expect(client.createServer(TOKEN, opts)).rejects.toMatchObject({ status: 502 });
    });
    it("rejects an unknown curated key without calling the API", async () => {
      const fn = mockFetch({ ok: true, status: 202, body: {} });
      await expect(client.createServer(TOKEN, { ...opts, location: "moon" })).rejects.toMatchObject({ status: 400 });
      await expect(client.createServer(TOKEN, { ...opts, serverType: "huge" })).rejects.toMatchObject({ status: 400 });
      await expect(client.createServer(TOKEN, { ...opts, image: "templeos" })).rejects.toMatchObject({ status: 400 });
      expect(fn).not.toHaveBeenCalled();
    });
    it("provider error surfaces DO's message, never the token (even if echoed)", async () => {
      mockFetch({ ok: false, status: 422, body: { id: "unprocessable_entity", message: `size is invalid ${TOKEN}` } });
      let err: DigitalOceanApiError | undefined;
      try {
        await client.createServer(TOKEN, opts);
      } catch (e) {
        err = e as DigitalOceanApiError;
      }
      expect(err?.status).toBe(422);
      expect(err?.message).toContain("size is invalid");
      expect(err?.message).not.toContain(TOKEN);
    });
    it("network failure on createServer → status 0, token NOT in the message", async () => {
      mockFetch(new Error(`ECONNRESET ${TOKEN}`));
      const err = (await client.createServer(TOKEN, opts).then(() => null).catch((e) => e)) as DigitalOceanApiError | null;
      expect(err).toBeInstanceOf(DigitalOceanApiError);
      expect(err?.status).toBe(0);
      expect(err?.message).not.toContain(TOKEN); // non-vacuous: err is the rejection, asserted directly
    });
  });

  describe("destroyServer", () => {
    it("204 → resolves, DELETE /v2/droplets/{id}", async () => {
      const fn = mockFetch({ ok: true, status: 204 });
      await expect(client.destroyServer(TOKEN, "42")).resolves.toBeUndefined();
      expect(fn).toHaveBeenCalledWith("https://api.digitalocean.com/v2/droplets/42", expect.objectContaining({ method: "DELETE" }));
    });
    it("404 → resolves (idempotent)", async () => {
      mockFetch({ ok: false, status: 404, body: { id: "not_found", message: "not found" } });
      await expect(client.destroyServer(TOKEN, "42")).resolves.toBeUndefined();
    });
    it("500 → throws", async () => {
      mockFetch({ ok: false, status: 500, body: { message: "boom" } });
      await expect(client.destroyServer(TOKEN, "42")).rejects.toMatchObject({ status: 500 });
    });
  });
});

describe("DigitalOceanApiClient price reads", () => {
  const droplet = (id: number, size: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) => ({ id, size_slug: "s-2vcpu-4gb", ...(size ? { size } : {}), region: { slug: "fra1" }, ...extra });
  const size24 = { slug: "s-2vcpu-4gb", vcpus: 2, memory: 4096, disk: 80, price_monthly: 24 };
  const fresh = () => {
    const c = new DigitalOceanApiClient();
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

  it("reads each droplet's plan and USD monthly price from its own size, with GET only", async () => {
    const fn = mockSeq({ droplets: [droplet(11, size24), droplet(12, { ...size24, slug: "s-1vcpu-1gb", vcpus: 1, memory: 1024, disk: 25, price_monthly: 6 }, { size_slug: "s-1vcpu-1gb", region: { slug: "nyc3" } })], links: {} });
    const out = await fresh().listServerPlans(TOKEN);
    expect(out).toEqual([
      { providerServerId: "11", plan: { slug: "s-2vcpu-4gb", cores: 2, memoryGb: 4, diskGb: 80, architecture: "x86" }, location: "fra1", monthlyCents: 2400, currency: "USD" },
      { providerServerId: "12", plan: { slug: "s-1vcpu-1gb", cores: 1, memoryGb: 1, diskGb: 25, architecture: "x86" }, location: "nyc3", monthlyCents: 600, currency: "USD" },
    ]);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("https://api.digitalocean.com/v2/droplets?per_page=200&page=1", expect.objectContaining({ method: "GET" }));
  });

  it("falls back to the size list (one extra read) when a droplet carries no size", async () => {
    const fn = mockSeq({ droplets: [droplet(11, undefined), droplet(13, undefined)] }, { sizes: [size24, { slug: "bad" }] });
    const out = await fresh().listServerPlans(TOKEN);
    expect(out.map((p) => p.monthlyCents)).toEqual([2400, 2400]);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn.mock.calls[1][0]).toBe("https://api.digitalocean.com/v2/sizes?per_page=200&page=1");
  });

  it("follows pages up to a bound and skips malformed droplets", async () => {
    const page = (n: number, next: boolean) => ({ droplets: [droplet(n, size24), { id: undefined }, { id: null }], links: next ? { pages: { next: "x" } } : {} });
    const fn = mockSeq(page(1, true), page(2, false));
    const out = await fresh().listServerPlans(TOKEN);
    expect(out.map((p) => p.providerServerId)).toEqual(["1", "2"]);
    expect(fn).toHaveBeenCalledTimes(2);
    const always = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => page(1, true) } as Response);
    (global as unknown as { fetch: typeof fetch }).fetch = always as unknown as typeof fetch;
    await fresh().listServerPlans("other-token");
    expect(always).toHaveBeenCalledTimes(5);
  });

  it("caches a credential's read for five minutes and shares it between concurrent callers", async () => {
    const fn = mockSeq({ droplets: [droplet(11, size24)] });
    const c = fresh();
    const [a, b] = await Promise.all([c.listServerPlans(TOKEN), c.listServerPlans(TOKEN)]);
    await c.listServerPlans(TOKEN);
    expect(a).toBe(b);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failure, and the error never carries the token", async () => {
    const c = fresh();
    mockFetch({ ok: false, status: 429, body: { id: "too_many_requests", message: `slow down ${TOKEN}` } });
    await expect(c.listServerPlans(TOKEN)).rejects.toMatchObject({ status: 429 });
    await c.listServerPlans(TOKEN).catch((e) => expect((e as Error).message).not.toContain(TOKEN));
    const fn = mockSeq({ droplets: [droplet(11, size24)] });
    expect(await c.listServerPlans(TOKEN)).toHaveLength(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("paces its requests apart", async () => {
    const c = new DigitalOceanApiClient();
    const reads = (c as unknown as { reads: { gapMs: number; pace: () => Promise<void> } }).reads;
    reads.gapMs = 60;
    const t0 = Date.now();
    await reads.pace();
    await reads.pace();
    await reads.pace();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
  });
});
