import { MAX_API_MESSAGE, safeApiMessage } from "./api-message";

const body = (o: unknown) => Buffer.from(JSON.stringify(o));

describe("safeApiMessage", () => {
  it("keeps a real Coolify 4.7.5 message as is", () => {
    expect(safeApiMessage(body({ success: false, message: "You are not allowed to access the API." }))).toBe("You are not allowed to access the API.");
    expect(safeApiMessage(body({ message: "Missing required permissions: read" }))).toBe("Missing required permissions: read");
  });

  it("cuts a long message at about 100 characters", () => {
    const m = safeApiMessage(body({ message: "This API token is limited to selected projects, environments, or resources, so it cannot use this endpoint." }))!;
    expect(m.length).toBeLessThanOrEqual(MAX_API_MESSAGE);
    expect(m.startsWith("This API token is limited to selected projects")).toBe(true);
    expect(m.endsWith("…")).toBe(true);
  });

  it("strips control characters and collapses whitespace", () => {
    expect(safeApiMessage(body({ message: "bad\u0000 thing\r\n\tnow\u001b[31m red\u0085 end" }))).toBe("bad thing now [31m red end");
    expect(safeApiMessage(body({ message: "\n\t " }))).toBeNull();
  });

  it("removes anything that looks like a secret or token", () => {
    const cases = [
      "Invalid token 12|abcdefghijklmnopqrstuvwxyz0123456789ABCD given",
      "got Bearer abc123def456ghi789 here",
      "token=sk_live_abcdef123456 was rejected",
      "password: hunter2hunter2 was echoed",
      "key eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig is expired",
      "deadbeefdeadbeefdeadbeefdeadbeef leaked",
      "ghp_AbCdEfGhIjKlMnOpQrStUv1234 leaked",
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY----- ok",
    ];
    for (const message of cases) {
      const out = safeApiMessage(body({ message }))!;
      expect(out).toContain("[redacted]");
      expect(out).not.toMatch(/abcdefghijklmnop|hunter2|deadbeef|eyJhbGci|ghp_|MIIEvQ|sk_live|abc123def456/);
    }
  });

  it("removes the configured token wherever it is echoed, even a short one and its Bearer form", () => {
    expect(safeApiMessage(body({ message: "token my-s3cret-t0k rejected" }), ["Bearer my-s3cret-t0k"])).toBe("token [redacted] rejected");
    expect(safeApiMessage(body({ message: "bad abcdefg1" }), ["abcdefg1"])).toBe("bad [redacted]");
  });

  it("redacts before cutting, so a secret straddling the limit cannot leave a fragment", () => {
    const secret = "12|" + "a".repeat(40);
    const out = safeApiMessage(body({ message: `${"x ".repeat(48)}${secret}` }))!;
    expect(out).not.toMatch(/a{5}/);
  });

  it("is null for anything that is not a JSON object with a string message", () => {
    expect(safeApiMessage(Buffer.from("<html>Bad Gateway</html>"))).toBeNull();
    expect(safeApiMessage(body([{ message: "x" }]))).toBeNull();
    expect(safeApiMessage(body({ message: { nested: true } }))).toBeNull();
    expect(safeApiMessage(body({ error: "x" }))).toBeNull();
    expect(safeApiMessage(Buffer.alloc(0))).toBeNull();
    expect(safeApiMessage(Buffer.from(`{"message":"${"x".repeat(70_000)}"}`))).toBeNull();
  });

  it("an ordinary sentence with numbers and long words is left alone", () => {
    expect(safeApiMessage(body({ message: "The environment 'production' was not found in project 12." }))).toBe("The environment 'production' was not found in project 12.");
  });
});
