import { HetznerApiClient, HetznerApiError } from "./hetzner.client";

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
