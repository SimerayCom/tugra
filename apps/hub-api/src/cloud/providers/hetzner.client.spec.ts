import { HetznerApiClient, HetznerApiError } from "./hetzner.client";
import { FAKE_CONSOLE_PASSWORD, FAKE_CONSOLE_URL, FAKE_ROOT_PASSWORD, FakeHetznerApi } from "../testing/fake-hetzner-api";

const TOKEN = "SECRET_TOKEN_should_never_leak";

function mockFetch(res: { ok: boolean; status: number; body?: unknown } | Error) {
  const fn = jest.fn();
  if (res instanceof Error) fn.mockRejectedValue(res);
  else
    fn.mockResolvedValue({
      ok: res.ok,
      status: res.status,
      json: async () => res.body ?? {},
    } as Response);
  (global as unknown as { fetch: typeof fetch }).fetch = fn as unknown as typeof fetch;
  return fn;
}

describe("HetznerApiClient", () => {
  const client = new HetznerApiClient();
  afterEach(() => jest.restoreAllMocks());

  describe("verifyToken", () => {
    it("200 → valid, and sends a Bearer token", async () => {
      const fn = mockFetch({ ok: true, status: 200, body: { locations: [] } });
      await expect(client.verifyToken(TOKEN)).resolves.toEqual({ valid: true });
      expect(fn).toHaveBeenCalledWith(
        "https://api.hetzner.cloud/v1/locations",
        expect.objectContaining({ headers: expect.objectContaining({ authorization: `Bearer ${TOKEN}` }) }),
      );
    });
    it("401 → invalid (not a throw)", async () => {
      mockFetch({ ok: false, status: 401, body: { error: { message: "unauthorized" } } });
      await expect(client.verifyToken(TOKEN)).resolves.toEqual({ valid: false });
    });
    it("network failure → HetznerApiError status 0, token NOT in the message", async () => {
      mockFetch(new Error("ECONNRESET"));
      await expect(client.verifyToken(TOKEN)).rejects.toMatchObject({ status: 0 });
      await client.verifyToken(TOKEN).catch((e) => expect((e as Error).message).not.toContain(TOKEN));
    });
  });

  describe("createServer", () => {
    const opts = { name: "srv", location: "nbg1", serverType: "cx22", image: "ubuntu-24.04", userData: "#!/bin/sh" };

    it("maps {server:{id,public_net}} → {providerServerId, publicIp, publicIpv6}", async () => {
      mockFetch({ ok: true, status: 201, body: { server: { id: 42, public_net: { ipv4: { ip: "1.2.3.4" }, ipv6: { ip: "2a01::1" } } } } });
      await expect(client.createServer(TOKEN, opts)).resolves.toEqual({
        providerServerId: "42",
        publicIp: "1.2.3.4",
        publicIpv6: "2a01::1",
      });
    });
    it("null public_net → null ips", async () => {
      mockFetch({ ok: true, status: 201, body: { server: { id: 7, public_net: null } } });
      await expect(client.createServer(TOKEN, opts)).resolves.toEqual({ providerServerId: "7", publicIp: null, publicIpv6: null });
    });
    it("2xx but no server.id → HetznerApiError 502", async () => {
      mockFetch({ ok: true, status: 201, body: { server: {} } });
      await expect(client.createServer(TOKEN, opts)).rejects.toMatchObject({ status: 502 });
    });
    it("provider error surfaces Hetzner's message but NEVER the token", async () => {
      mockFetch({ ok: false, status: 422, body: { error: { code: "invalid_input", message: "server_type is invalid" } } });
      let err: HetznerApiError | undefined;
      try {
        await client.createServer(TOKEN, opts);
      } catch (e) {
        err = e as HetznerApiError;
      }
      expect(err?.status).toBe(422);
      expect(err?.message).toContain("server_type is invalid");
      expect(err?.message).not.toContain(TOKEN);
    });
  });

  describe("destroyServer", () => {
    it("404 → resolves (idempotent)", async () => {
      mockFetch({ ok: false, status: 404, body: { error: { message: "not found" } } });
      await expect(client.destroyServer(TOKEN, "42")).resolves.toBeUndefined();
    });
    it("200 → resolves", async () => {
      mockFetch({ ok: true, status: 200, body: { action: { id: 1 } } });
      await expect(client.destroyServer(TOKEN, "42")).resolves.toBeUndefined();
    });
    it("500 → throws", async () => {
      mockFetch({ ok: false, status: 500, body: { error: { message: "boom" } } });
      await expect(client.destroyServer(TOKEN, "42")).rejects.toMatchObject({ status: 500 });
    });
  });
});

describe("HetznerApiClient out-of-band (against the fake Hetzner API)", () => {
  const client = new HetznerApiClient();
  let api: FakeHetznerApi;
  beforeEach(() => {
    api = new FakeHetznerApi().add({ id: 42, name: "web-1", status: "running", ipv4: "203.0.113.10" }).install();
    api.validToken = TOKEN;
  });
  afterEach(() => api.uninstall());

  it.each([
    ["power_on", "poweron"],
    ["power_off", "poweroff"],
    ["reboot", "reset"], // our `reboot` is the HARD reset; Hetzner's own `reboot` is the soft ACPI one
    ["shutdown", "shutdown"],
  ] as const)("power %s -> POST /servers/42/actions/%s with a bearer token and no body", async (action, endpoint) => {
    const r = await client.power(TOKEN, "42", action);
    expect(api.requests).toEqual([{ method: "POST", path: `/servers/42/actions/${endpoint}`, authorization: `Bearer ${TOKEN}`, body: undefined }]);
    expect(r).toMatchObject({ status: "running", command: endpoint });
    expect(r.id).toMatch(/^\d+$/);
  });

  it("enableRescue -> POST enable_rescue {type:linux64}; returns the one-time root password", async () => {
    const r = await client.enableRescue(TOKEN, "42");
    expect(api.requests[0]).toMatchObject({ method: "POST", path: "/servers/42/actions/enable_rescue", body: { type: "linux64" } });
    expect(r.rootPassword).toBe(FAKE_ROOT_PASSWORD);
    expect(r.action.command).toBe("enable_rescue");
    expect(api.servers.get(42)!.rescue_enabled).toBe(true);
  });

  it("disableRescue -> POST disable_rescue", async () => {
    api.servers.get(42)!.rescue_enabled = true;
    await client.disableRescue(TOKEN, "42");
    expect(api.requests[0]).toMatchObject({ method: "POST", path: "/servers/42/actions/disable_rescue" });
    expect(api.servers.get(42)!.rescue_enabled).toBe(false);
  });

  it("requestConsole -> POST request_console; returns wss url + password and the documented 60 s lifetime", async () => {
    const r = await client.requestConsole(TOKEN, "42");
    expect(api.requests[0]).toMatchObject({ method: "POST", path: "/servers/42/actions/request_console" });
    expect(r).toMatchObject({ wssUrl: FAKE_CONSOLE_URL, password: FAKE_CONSOLE_PASSWORD, validForSeconds: 60 });
  });

  it("getServerState maps status, lock, rescue flag and addresses", async () => {
    api.servers.get(42)!.locked = true;
    api.servers.get(42)!.rescue_enabled = true;
    await expect(client.getServerState(TOKEN, "42")).resolves.toEqual({
      providerServerId: "42",
      name: "web-1",
      status: "running",
      locked: true,
      rescueEnabled: true,
      publicIpv4: "203.0.113.10",
      publicIpv6: null,
    });
    expect(api.requests[0]).toMatchObject({ method: "GET", path: "/servers/42", authorization: `Bearer ${TOKEN}` });
  });

  it("listServers follows pagination (50 per page) and stops at the last page", async () => {
    for (let i = 100; i < 160; i++) api.add({ id: i, name: `vm-${i}`, status: "off" });
    const all = await client.listServers(TOKEN);
    expect(all).toHaveLength(61);
    expect(api.requests.map((r) => r.path)).toEqual(["/servers?per_page=50&page=1", "/servers?per_page=50&page=2"]);
  });

  it("refuses a server id that is not a plain positive integer, before any request is made", async () => {
    for (const bad of ["", "0", "-1", "42/../1", "42?x=1", "abc", "1e3", "4 2"]) {
      await expect(client.power(TOKEN, bad, "power_on")).rejects.toMatchObject({ status: 422 });
      await expect(client.getServerState(TOKEN, bad)).rejects.toMatchObject({ status: 422 });
    }
    expect(api.requests).toHaveLength(0);
  });

  it("an unknown server is a 404, a locked one a 423, a bad token a 401 — with Hetzner's own error code", async () => {
    await expect(client.power(TOKEN, "999", "power_on")).rejects.toMatchObject({ status: 404, hetznerError: { code: "not_found" } });
    api.servers.get(42)!.locked = true;
    await expect(client.power(TOKEN, "42", "power_on")).rejects.toMatchObject({ status: 423, hetznerError: { code: "locked" } });
    await expect(client.power("wrong", "42", "power_on")).rejects.toMatchObject({ status: 401 });
  });

  it("an action Hetzner already reports as failed is an error, with its message and no secrets", async () => {
    api.nextActionStatus = "error";
    const err = (await client.power(TOKEN, "42", "reboot").catch((e) => e)) as HetznerApiError;
    expect(err).toBeInstanceOf(HetznerApiError);
    expect(err.status).toBe(502);
    expect(err.message).toContain("Action failed");
    expect(err.message).not.toContain(TOKEN);
  });

  it("a 2xx without the secret the caller needs is a 502 (never an empty password)", async () => {
    const fn = jest.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ action: { id: 1, status: "running", command: "enable_rescue" } }) });
    (global as unknown as { fetch: typeof fetch }).fetch = fn as unknown as typeof fetch;
    await expect(client.enableRescue(TOKEN, "42")).rejects.toMatchObject({ status: 502 });
    await expect(client.requestConsole(TOKEN, "42")).rejects.toMatchObject({ status: 502 });
  });

  it("a network failure is status 0 and the message never carries the token", async () => {
    api.failNext = { status: 0, code: "", message: "" };
    const err = (await client.power(TOKEN, "42", "power_on").catch((e) => e)) as HetznerApiError;
    expect(err.status).toBe(0);
    expect(err.message).not.toContain(TOKEN);
  });
});
