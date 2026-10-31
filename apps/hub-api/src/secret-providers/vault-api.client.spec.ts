import { VaultApiClient, VaultApiError, parseVaultLocator } from "./vault-api.client";

const savedFetch = global.fetch;
afterEach(() => {
  global.fetch = savedFetch;
});

/** A fake fetch returning one response with the given status + JSON body. */
function mockFetch(status: number, body: unknown): jest.Mock {
  const fn = jest.fn().mockResolvedValue({
    status,
    json: async () => body,
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

const vault = new VaultApiClient();

describe("parseVaultLocator", () => {
  it("parses <mount>/<path>#<field>", () => {
    expect(parseVaultLocator("secret/myapp#DB_PASSWORD")).toEqual({ mount: "secret", path: "myapp", field: "DB_PASSWORD" });
  });
  it("keeps a nested path intact", () => {
    expect(parseVaultLocator("kv/team/app/prod#API_KEY")).toEqual({ mount: "kv", path: "team/app/prod", field: "API_KEY" });
  });
  it("trims surrounding slashes", () => {
    expect(parseVaultLocator("/secret/myapp/#TOKEN")).toEqual({ mount: "secret", path: "myapp", field: "TOKEN" });
  });
  it("rejects a locator with no field", () => {
    expect(() => parseVaultLocator("secret/myapp")).toThrow(VaultApiError);
    expect(() => parseVaultLocator("secret/myapp#")).toThrow(/missing field/);
  });
  it("rejects a locator with no path (mount only)", () => {
    expect(() => parseVaultLocator("secret#FIELD")).toThrow(VaultApiError);
    expect(() => parseVaultLocator("secret/#FIELD")).toThrow(VaultApiError);
  });
  it("rejects path traversal (escaping the /v1/<mount>/data/ prefix)", () => {
    expect(() => parseVaultLocator("secret/../../sys/raw#X")).toThrow(/not allowed|illegal/);
    expect(() => parseVaultLocator("../secret/app#X")).toThrow(/not allowed|illegal/);
    expect(() => parseVaultLocator("secret/./app#X")).toThrow(/not allowed/);
  });
  it("rejects illegal characters that would inject query/fragment into the URL", () => {
    expect(() => parseVaultLocator("secret/app?list=true#X")).toThrow(/illegal character/);
    expect(() => parseVaultLocator("secret/app%2e%2e#X")).toThrow(/illegal character/);
    expect(() => parseVaultLocator("secret/app#FIE/LD")).toThrow(/illegal character/); // field must not contain a slash
  });
});

describe("VaultApiClient.verify", () => {
  it("returns valid:true on a 200 token lookup", async () => {
    const f = mockFetch(200, { data: {} });
    await expect(vault.verify("https://10.1.2.3", "tok")).resolves.toEqual({ valid: true });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://10.1.2.3/v1/auth/token/lookup-self");
    expect((init as RequestInit).headers).toMatchObject({ "X-Vault-Token": "tok" });
  });

  it("returns valid:false on 401/403", async () => {
    mockFetch(403, { errors: ["permission denied"] });
    await expect(vault.verify("https://10.1.2.3", "bad")).resolves.toEqual({ valid: false });
  });

  it("throws on a 5xx (store error, not a credential verdict)", async () => {
    mockFetch(500, {});
    await expect(vault.verify("https://10.1.2.3", "tok")).rejects.toBeInstanceOf(VaultApiError);
  });

  it("throws (status 0) and never leaks the token when the store is unreachable", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("ECONNREFUSED https://vault/... X-Vault-Token: tok")) as unknown as typeof fetch;
    const err = await vault.verify("https://10.1.2.3", "super-secret-token").catch((e) => e);
    expect(err).toBeInstanceOf(VaultApiError);
    expect((err as VaultApiError).status).toBe(0);
    expect((err as VaultApiError).message).not.toContain("super-secret-token");
  });
});

describe("VaultApiClient.fetchSecret", () => {
  it("reads the field from data.data and hits the KV v2 data path", async () => {
    const f = mockFetch(200, { data: { data: { DB_PASSWORD: "s3cr3t" }, metadata: {} } });
    await expect(vault.fetchSecret("https://10.1.2.3/", "tok", "secret/myapp#DB_PASSWORD")).resolves.toBe("s3cr3t");
    expect(f.mock.calls[0][0]).toBe("https://10.1.2.3/v1/secret/data/myapp");
  });

  it("coerces a scalar number/boolean to a string", async () => {
    mockFetch(200, { data: { data: { PORT: 5432 } } });
    await expect(vault.fetchSecret("https://10.1.2.3", "tok", "secret/myapp#PORT")).resolves.toBe("5432");
  });

  it("throws on 404 (path missing)", async () => {
    mockFetch(404, { errors: [] });
    await expect(vault.fetchSecret("https://10.1.2.3", "tok", "secret/none#X")).rejects.toThrow(/not found/);
  });

  it("throws when the field is absent", async () => {
    mockFetch(200, { data: { data: { OTHER: "x" } } });
    await expect(vault.fetchSecret("https://10.1.2.3", "tok", "secret/myapp#MISSING")).rejects.toThrow(/no field "MISSING"/);
  });

  it("throws when the value is a non-scalar (object)", async () => {
    mockFetch(200, { data: { data: { NESTED: { a: 1 } } } });
    await expect(vault.fetchSecret("https://10.1.2.3", "tok", "secret/myapp#NESTED")).rejects.toThrow(/not a scalar/);
  });
});

describe("VaultApiClient SSRF guard", () => {
  it("refuses a loopback/metadata address BEFORE sending the credentialed request", async () => {
    const f = mockFetch(200, { data: {} }); // would succeed if the guard let it through
    await expect(vault.verify("http://127.0.0.1:8200", "tok")).rejects.toThrow(/not allowed/);
    await expect(vault.verify("http://169.254.169.254", "tok")).rejects.toThrow(/not allowed/);
    await expect(vault.fetchSecret("http://127.0.0.1", "tok", "secret/app#X")).rejects.toThrow(/not allowed/);
    expect(f).not.toHaveBeenCalled(); // the token is never put on the wire to a blocked host
  });
});
