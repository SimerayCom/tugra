import { CloudflareApiClient, CloudflareApiError } from "./cloudflare-api.client";

const savedFetch = global.fetch;
afterEach(() => {
  global.fetch = savedFetch;
});

/** A fake fetch returning one CF-shaped JSON envelope. */
function mockOnce(status: number, payload: unknown): jest.Mock {
  const fn = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

function envelope(result: unknown, success = true, errors: unknown[] = []) {
  return { success, errors, result };
}

const cf = new CloudflareApiClient();

describe("CloudflareApiClient.verifyToken", () => {
  it("sends Authorization: Bearer <token> and returns valid:true for an active token", async () => {
    const f = mockOnce(200, envelope({ status: "active" }));
    await expect(cf.verifyToken("tok123")).resolves.toEqual({ valid: true });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://api.cloudflare.com/client/v4/user/tokens/verify");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok123");
  });

  it("returns valid:false on a 401 instead of throwing", async () => {
    mockOnce(401, envelope(null, false, [{ message: "Invalid API Token" }]));
    await expect(cf.verifyToken("bad")).resolves.toEqual({ valid: false });
  });

  it("does NOT hit the account endpoint when no accountId is supplied (user-token path unchanged)", async () => {
    const f = mockOnce(403, envelope(null, false, [{ message: "forbidden" }]));
    await expect(cf.verifyToken("acct-tok")).resolves.toEqual({ valid: false });
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0][0]).toBe("https://api.cloudflare.com/client/v4/user/tokens/verify");
  });

  it("falls back to /accounts/{id}/tokens/verify when the user endpoint rejects (401/403) and an accountId is given", async () => {
    const responses = [
      { ok: false, status: 403, json: async () => envelope(null, false, [{ message: "forbidden" }]) },
      { ok: true, status: 200, json: async () => envelope({ status: "active" }) },
    ];
    const f = jest.fn().mockImplementation(() => Promise.resolve(responses.shift()));
    global.fetch = f as unknown as typeof fetch;
    await expect(cf.verifyToken("acct-tok", "acc123")).resolves.toEqual({ valid: true });
    expect(f).toHaveBeenCalledTimes(2);
    expect(f.mock.calls[0][0]).toBe("https://api.cloudflare.com/client/v4/user/tokens/verify");
    expect(f.mock.calls[1][0]).toBe("https://api.cloudflare.com/client/v4/accounts/acc123/tokens/verify");
  });

  it("returns valid:false when BOTH the user and the account endpoints reject", async () => {
    const f = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 403, json: async () => envelope(null, false, [{ message: "forbidden" }]) });
    global.fetch = f as unknown as typeof fetch;
    await expect(cf.verifyToken("bad", "acc123")).resolves.toEqual({ valid: false });
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe("CloudflareApiClient.findZoneId", () => {
  it("resolves the id for the exact zone-name match", async () => {
    mockOnce(200, envelope([{ id: "z1", name: "example.com" }]));
    await expect(cf.findZoneId("t", "example.com")).resolves.toBe("z1");
  });

  it("throws a 404 CloudflareApiError when no zone is returned", async () => {
    mockOnce(200, envelope([]));
    await expect(cf.findZoneId("t", "nope.com")).rejects.toMatchObject({ status: 404 });
  });
});

describe("CloudflareApiClient.createTunnel", () => {
  it("POSTs {name, config_src:'cloudflare'} and returns {tunnelId, token}", async () => {
    const f = mockOnce(200, envelope({ id: "tid", token: "connector-token" }));
    await expect(cf.createTunnel("t", "acc", "tugra-s1")).resolves.toEqual({ tunnelId: "tid", token: "connector-token" });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acc/cfd_tunnel");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ name: "tugra-s1", config_src: "cloudflare" });
  });

  it("surfaces the CF error message on a conflict", async () => {
    mockOnce(409, envelope(null, false, [{ message: "tunnel with name already exists" }]));
    await expect(cf.createTunnel("t", "a", "n")).rejects.toThrow(/already exists/);
  });
});

describe("CloudflareApiClient.putIngressConfig", () => {
  it("PUTs the ingress rules with a trailing 404 catch-all appended", async () => {
    const f = mockOnce(200, envelope({}));
    await cf.putIngressConfig("t", "acc", "tid", [{ hostname: "a.example.com", service: "http://tugra-proxy:80" }]);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acc/cfd_tunnel/tid/configurations");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      config: {
        ingress: [
          { hostname: "a.example.com", service: "http://tugra-proxy:80" },
          { service: "http_status:404" },
        ],
      },
    });
  });

  it("drops any caller-supplied catch-all so only one trailing 404 rule remains", async () => {
    const f = mockOnce(200, envelope({}));
    await cf.putIngressConfig("t", "acc", "tid", [
      { hostname: "a.example.com", service: "http://tugra-proxy:80" },
      { service: "http_status:404" },
    ]);
    const ingress = JSON.parse(f.mock.calls[0][1].body as string).config.ingress;
    expect(ingress).toEqual([
      { hostname: "a.example.com", service: "http://tugra-proxy:80" },
      { service: "http_status:404" },
    ]);
  });
});

describe("CloudflareApiClient.upsertCname", () => {
  it("PUTs (reusing the id) when an existingRecordId is known — proxied CNAME to *.cfargotunnel.com", async () => {
    const f = mockOnce(200, envelope({ id: "rec1" }));
    await expect(
      cf.upsertCname("t", "z1", { name: "*.example.com", tunnelId: "tid", existingRecordId: "rec1" }),
    ).resolves.toEqual({ recordId: "rec1" });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://api.cloudflare.com/client/v4/zones/z1/dns_records/rec1");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      type: "CNAME",
      name: "*.example.com",
      content: "tid.cfargotunnel.com",
      proxied: true,
      ttl: 1,
    });
    expect(f).toHaveBeenCalledTimes(1); // no lookup when the id is already known
  });

  it("looks up then POSTs a new record when none exists", async () => {
    const fn = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => envelope([]) }) // lookup: empty
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => envelope({ id: "recNew" }) }); // create
    global.fetch = fn as unknown as typeof fetch;
    await expect(cf.upsertCname("t", "z1", { name: "*.example.com", tunnelId: "tid" })).resolves.toEqual({
      recordId: "recNew",
    });
    expect(fn.mock.calls[0][1].method).toBe("GET"); // lookup first
    expect(fn.mock.calls[1][1].method).toBe("POST"); // then create
  });
});

describe("CloudflareApiClient teardown tolerance", () => {
  it("deleteDnsRecord tolerates an already-gone (404) record", async () => {
    mockOnce(404, envelope(null, false, [{ message: "Record does not exist" }]));
    await expect(cf.deleteDnsRecord("t", "z1", "rec1")).resolves.toBeUndefined();
  });

  it("deleteTunnel tolerates an already-gone (404) tunnel", async () => {
    mockOnce(404, envelope(null, false, [{ message: "tunnel not found" }]));
    await expect(cf.deleteTunnel("t", "acc", "tid")).resolves.toBeUndefined();
  });

  it("deleteTunnel still throws on a non-404 failure", async () => {
    mockOnce(500, envelope(null, false, [{ message: "server error" }]));
    await expect(cf.deleteTunnel("t", "acc", "tid")).rejects.toBeInstanceOf(CloudflareApiError);
  });
});

describe("CloudflareApiClient error hygiene", () => {
  it("wraps a network/timeout failure in a CloudflareApiError(status 0), not a raw TypeError", async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError("fetch failed")) as unknown as typeof fetch;
    await expect(cf.findZoneId("SUPER_SECRET_TOKEN", "z")).rejects.toMatchObject({ status: 0 });
  });

  it("never embeds the API token in a thrown error message", async () => {
    mockOnce(500, envelope(null, false, [{ message: "boom" }]));
    let msg = "";
    try {
      await cf.createTunnel("SUPER_SECRET_TOKEN", "a", "n");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).not.toContain("SUPER_SECRET_TOKEN");

    global.fetch = jest.fn().mockRejectedValue(new TypeError("fetch failed")) as unknown as typeof fetch;
    let msg2 = "";
    try {
      await cf.findZoneId("SUPER_SECRET_TOKEN", "z");
    } catch (e) {
      msg2 = (e as Error).message;
    }
    expect(msg2.length).toBeGreaterThan(0);
    expect(msg2).not.toContain("SUPER_SECRET_TOKEN");
  });
});

// ── DNS auto-setup client extensions (DNS spec S1) ──────────────────────────────────────────────
describe("CloudflareApiClient.findZoneForHostname", () => {
  it("picks the LONGEST zone-name suffix of the hostname", async () => {
    mockOnce(200, envelope([{ id: "zc", name: "co.uk" }, { id: "zf", name: "foo.co.uk" }, { id: "ze", name: "example.com" }]));
    await expect(cf.findZoneForHostname("t", "app.foo.co.uk")).resolves.toEqual({ zoneId: "zf", zoneName: "foo.co.uk" });
  });
  it("matches an exact apex hostname", async () => {
    mockOnce(200, envelope([{ id: "ze", name: "example.com" }]));
    await expect(cf.findZoneForHostname("t", "example.com")).resolves.toEqual({ zoneId: "ze", zoneName: "example.com" });
  });
  it("throws 404 when no accessible zone matches the hostname", async () => {
    mockOnce(200, envelope([{ id: "ze", name: "example.com" }]));
    await expect(cf.findZoneForHostname("t", "app.other.net")).rejects.toMatchObject({ status: 404 });
  });
});

describe("CloudflareApiClient.listDnsRecords", () => {
  it("filters by type + name in the query string", async () => {
    const f = mockOnce(200, envelope([{ id: "r1", type: "A", name: "example.com", content: "1.2.3.4" }]));
    await expect(cf.listDnsRecords("t", "z1", { type: "A", name: "example.com" })).resolves.toEqual([
      { id: "r1", type: "A", name: "example.com", content: "1.2.3.4" },
    ]);
    expect(f.mock.calls[0][0]).toBe("https://api.cloudflare.com/client/v4/zones/z1/dns_records?type=A&name=example.com");
  });
});

describe("CloudflareApiClient.upsertDnsRecord", () => {
  it("PUTs an A record (proxied defaults to false, ttl 1) when an existingRecordId is known — 1 call, action updated", async () => {
    const f = mockOnce(200, envelope({ id: "rA" }));
    await expect(
      cf.upsertDnsRecord("t", "z1", { type: "A", name: "example.com", content: "1.2.3.4", existingRecordId: "rA" }),
    ).resolves.toEqual({ recordId: "rA", action: "updated" });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://api.cloudflare.com/client/v4/zones/z1/dns_records/rA");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ type: "A", name: "example.com", content: "1.2.3.4", proxied: false, ttl: 1 });
    expect(f).toHaveBeenCalledTimes(1); // no lookup when the id is known
  });
  it("looks up then POSTs a new record (action created) when none exists", async () => {
    const fn = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => envelope([]) }) // lookup empty
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => envelope({ id: "rNew" }) }); // create
    global.fetch = fn as unknown as typeof fetch;
    await expect(cf.upsertDnsRecord("t", "z1", { type: "AAAA", name: "example.com", content: "::1", proxied: false })).resolves.toEqual({
      recordId: "rNew",
      action: "created",
    });
    expect(fn.mock.calls[0][1].method).toBe("GET");
    expect(fn.mock.calls[1][1].method).toBe("POST");
  });
  it("throws 502 when create returns no id", async () => {
    const fn = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => envelope([]) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => envelope({}) });
    global.fetch = fn as unknown as typeof fetch;
    await expect(cf.upsertDnsRecord("t", "z1", { type: "A", name: "x.com", content: "1.1.1.1" })).rejects.toMatchObject({ status: 502 });
  });
});

describe("CloudflareApiClient.createDnsRecord", () => {
  it("POSTs a new record directly (no find-first) — for reconciling sibling records at one name", async () => {
    const f = mockOnce(200, envelope({ id: "rNew" }));
    await expect(cf.createDnsRecord("t", "z1", { type: "A", name: "example.com", content: "198.51.100.9" })).resolves.toEqual({ recordId: "rNew" });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://api.cloudflare.com/client/v4/zones/z1/dns_records");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ type: "A", name: "example.com", content: "198.51.100.9", proxied: false, ttl: 1 });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("throws 502 when create returns no id", async () => {
    mockOnce(200, envelope({}));
    await expect(cf.createDnsRecord("t", "z1", { type: "A", name: "x.com", content: "1.1.1.1" })).rejects.toMatchObject({ status: 502 });
  });
});

describe("CloudflareApiClient.getZoneSslMode", () => {
  it("returns the zone SSL/TLS mode value", async () => {
    mockOnce(200, envelope({ id: "ssl", value: "full" }));
    await expect(cf.getZoneSslMode("t", "z1")).resolves.toBe("full");
  });
  it("returns 'unknown' when the setting value is absent", async () => {
    mockOnce(200, envelope({ id: "ssl" }));
    await expect(cf.getZoneSslMode("t", "z1")).resolves.toBe("unknown");
  });
});

// upsertCname still behaves identically after delegating to upsertDnsRecord (regression).
describe("CloudflareApiClient.upsertCname (post-refactor regression)", () => {
  it("PUTs the proxied CNAME to *.cfargotunnel.com with the known id, 1 call", async () => {
    const f = mockOnce(200, envelope({ id: "rec1" }));
    await expect(cf.upsertCname("t", "z1", { name: "*.example.com", tunnelId: "tid", existingRecordId: "rec1" })).resolves.toEqual({ recordId: "rec1" });
    expect(JSON.parse(f.mock.calls[0][1].body as string)).toEqual({ type: "CNAME", name: "*.example.com", content: "tid.cfargotunnel.com", proxied: true, ttl: 1 });
    expect(f).toHaveBeenCalledTimes(1);
  });
});
