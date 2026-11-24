import { CreateMonitorSchema, UpdateMonitorSchema } from "./dto";

const base = { name: "n", teamId: "t1" };

describe("CreateMonitorSchema — new monitor kinds and options", () => {
  it("accepts a keyword monitor only with a keyword", () => {
    expect(CreateMonitorSchema.safeParse({ ...base, type: "KEYWORD", target: "https://example.com", keyword: "ok" }).success).toBe(true);
    expect(CreateMonitorSchema.safeParse({ ...base, type: "KEYWORD", target: "https://example.com" }).success).toBe(false);
  });

  it("accepts ping and dns monitors with a target", () => {
    expect(CreateMonitorSchema.safeParse({ ...base, type: "PING", target: "example.com" }).success).toBe(true);
    expect(CreateMonitorSchema.safeParse({ ...base, type: "DNS", target: "example.com", dnsRecordType: "MX", dnsServer: "1.1.1.1" }).success).toBe(true);
    expect(CreateMonitorSchema.safeParse({ ...base, type: "DNS" }).success).toBe(false);
  });

  it("validates accepted status codes, methods and the resolver address", () => {
    const ok = { ...base, type: "HTTP", target: "https://example.com" };
    expect(CreateMonitorSchema.safeParse({ ...ok, acceptedStatus: ["200-299", "401"], method: "HEAD" }).success).toBe(true);
    expect(CreateMonitorSchema.safeParse({ ...ok, acceptedStatus: ["2xx"] }).success).toBe(false);
    expect(CreateMonitorSchema.safeParse({ ...ok, method: "TRACE" }).success).toBe(false);
    expect(CreateMonitorSchema.safeParse({ ...ok, type: "DNS", dnsServer: "not-an-ip" }).success).toBe(false);
    expect(CreateMonitorSchema.safeParse({ ...ok, type: "DNS", dnsServer: "[::1]:53" }).success).toBe(true);
  });

  it("refuses framing headers and header injection", () => {
    const ok = { ...base, type: "HTTP", target: "https://example.com" };
    expect(CreateMonitorSchema.safeParse({ ...ok, headers: { "X-Key": "v" } }).success).toBe(true);
    expect(CreateMonitorSchema.safeParse({ ...ok, headers: { "Content-Length": "1" } }).success).toBe(false);
    expect(CreateMonitorSchema.safeParse({ ...ok, headers: { "Transfer-Encoding": "chunked" } }).success).toBe(false);
    expect(CreateMonitorSchema.safeParse({ ...ok, headers: { "X-A": "a\r\nX-B: b" } }).success).toBe(false);
    expect(CreateMonitorSchema.safeParse({ ...ok, headers: { "bad name": "v" } }).success).toBe(false);
  });

  it("keeps the original HTTP/TCP/METRIC rules", () => {
    expect(CreateMonitorSchema.safeParse({ ...base, type: "HTTP" }).success).toBe(false);
    expect(CreateMonitorSchema.safeParse({ ...base, type: "METRIC", serverId: "s", metric: "DISK", thresholdPct: 90 }).success).toBe(true);
  });

  it("update accepts the same options", () => {
    expect(UpdateMonitorSchema.safeParse({ upsideDown: true, acceptedStatus: ["200"], headers: { A: "b" } }).success).toBe(true);
    expect(UpdateMonitorSchema.safeParse({ maxRedirects: 99 }).success).toBe(false);
  });
});
