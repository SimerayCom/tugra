import { HetznerApiClient, netCents } from "./hetzner.client";

const TOKEN = "SECRET_TOKEN_should_never_leak";

function mockFetch(...bodies: Array<{ ok?: boolean; status?: number; body?: unknown }>) {
  const fn = jest.fn();
  for (const b of bodies) fn.mockResolvedValueOnce({ ok: b.ok ?? true, status: b.status ?? 200, json: async () => b.body ?? {} } as Response);
  (global as unknown as { fetch: typeof fetch }).fetch = fn as unknown as typeof fetch;
  return fn;
}

const serverType = (name: string, price: string, loc = "fsn1") => ({
  name,
  cores: 2,
  memory: 4,
  disk: 40,
  architecture: "x86",
  deprecated: false,
  prices: [{ location: loc, price_monthly: { net: price, gross: "9.99" } }, { location: "hel1", price_monthly: { net: "5.00", gross: "5.95" } }],
});

describe("netCents", () => {
  it("parses Hetzner's price strings to integer cents", () => {
    expect(netCents("5.8300000000")).toBe(583);
    expect(netCents(4.99)).toBe(499);
    expect(netCents("abc")).toBeNull();
    expect(netCents(null)).toBeNull();
    expect(netCents("-1")).toBeNull();
  });
});

describe("HetznerApiClient plans", () => {
  const client = new HetznerApiClient();
  afterEach(() => jest.restoreAllMocks());

  it("listServerPlans reads each VM's plan and the NET monthly price at its own location", async () => {
    const fn = mockFetch({
      body: {
        servers: [
          { id: 7, server_type: serverType("cx23", "4.1000000000"), datacenter: { location: { name: "fsn1" } } },
          { id: 8, server_type: serverType("cax11", "3.2000000000", "hel1"), location: { name: "hel1" } },
          { id: 9, server_type: { name: "x" } }, // malformed: skipped
        ],
        meta: { pagination: { next_page: null } },
      },
    });
    const out = await client.listServerPlans(TOKEN);
    expect(out).toEqual([
      { providerServerId: "7", plan: { slug: "cx23", cores: 2, memoryGb: 4, diskGb: 40, architecture: "x86" }, location: "fsn1", monthlyCents: 410, currency: "EUR" },
      { providerServerId: "8", plan: { slug: "cax11", cores: 2, memoryGb: 4, diskGb: 40, architecture: "x86" }, location: "hel1", monthlyCents: 320, currency: "EUR" },
    ]);
    expect(fn).toHaveBeenCalledWith("https://api.hetzner.cloud/v1/servers?per_page=50&page=1", expect.objectContaining({ method: "GET" }));
  });

  it("returns a null price when the plan has none at the VM's location", async () => {
    mockFetch({ body: { servers: [{ id: 7, server_type: serverType("cx23", "4.10"), location: { name: "sin" } }], meta: {} } });
    const [p] = await client.listServerPlans(TOKEN);
    expect(p.monthlyCents).toBeNull();
  });

  it("listPlanCatalog maps prices per location and marks deprecated plans", async () => {
    mockFetch({ body: { server_types: [serverType("cx23", "4.10"), { ...serverType("cx22", "3.00"), deprecated: true }], meta: {} } });
    const cat = await client.listPlanCatalog(TOKEN);
    expect(cat[0]).toMatchObject({ slug: "cx23", deprecated: false, monthlyCentsByLocation: { fsn1: 410, hel1: 500 }, currency: "EUR" });
    expect(cat[1].deprecated).toBe(true);
  });

  it("follows pagination, bounded", async () => {
    const fn = mockFetch({ body: { server_types: [serverType("a1", "1")], meta: { pagination: { next_page: 2 } } } }, { body: { server_types: [serverType("b1", "2")], meta: { pagination: { next_page: null } } } });
    expect((await client.listPlanCatalog(TOKEN)).map((p) => p.slug)).toEqual(["a1", "b1"]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("changeType posts the type and upgrade_disk, and rejects a malformed slug before any request", async () => {
    const fn = mockFetch({ body: { action: { id: 1, status: "running", command: "change_server_type" } } });
    await expect(client.changeType(TOKEN, "42", "cx33", false)).resolves.toMatchObject({ id: "1", command: "change_server_type" });
    const [url, init] = fn.mock.calls[0];
    expect(url).toBe("https://api.hetzner.cloud/v1/servers/42/actions/change_type");
    expect(JSON.parse(init.body)).toEqual({ server_type: "cx33", upgrade_disk: false });
    await expect(client.changeType(TOKEN, "42", "cx33; rm -rf", false)).rejects.toMatchObject({ status: 422 });
    await expect(client.changeType(TOKEN, "4/../2", "cx33", false)).rejects.toMatchObject({ status: 422 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("an API failure never carries the token", async () => {
    mockFetch({ ok: false, status: 403, body: { error: { code: "forbidden", message: "insufficient permissions" } } });
    await client.changeType(TOKEN, "42", "cx33", false).catch((e: Error) => {
      expect(e.message).not.toContain(TOKEN);
      expect(e).toMatchObject({ status: 403 });
    });
  });
});
