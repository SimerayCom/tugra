import { z } from "zod";
import { checkS3Endpoint, isSafeS3Endpoint } from "./endpoint";
import { CreateObjectMigrationSchema } from "./dto";

describe("checkS3Endpoint", () => {
  it("accepts http/https hosts, private ranges, host:port and host.docker.internal (same-host MinIO)", () => {
    for (const [raw, want] of [
      ["https://s3.example.com", "https://s3.example.com"],
      ["http://10.0.0.5:9000", "http://10.0.0.5:9000"],
      ["http://192.168.1.10:9100/", "http://192.168.1.10:9100"],
      ["http://host.docker.internal:9100", "http://host.docker.internal:9100"],
      ["http://minio.internal:9000", "http://minio.internal:9000"],
      ["https://S3.Example.COM:443", "https://s3.example.com"],
    ] as const) {
      expect(checkS3Endpoint(raw)).toMatchObject({ ok: true, endpoint: want });
    }
  });

  it("rejects non-http schemes", () => {
    for (const raw of ["ftp://x.example.com", "file:///etc/passwd", "gopher://h", "s3://bucket", "javascript:alert(1)"]) expect(checkS3Endpoint(raw)).toMatchObject({ ok: false });
    expect(checkS3Endpoint("ftp://x.example.com")).toEqual({ ok: false, reason: "scheme" });
  });

  it("rejects userinfo, path, query and fragment (credentials travel in env, never in the URL)", () => {
    expect(checkS3Endpoint("https://user:pw@s3.example.com")).toEqual({ ok: false, reason: "userinfo" });
    expect(checkS3Endpoint("https://user@s3.example.com")).toEqual({ ok: false, reason: "userinfo" });
    expect(checkS3Endpoint("https://s3.example.com/bucket")).toEqual({ ok: false, reason: "path" });
    expect(checkS3Endpoint("https://s3.example.com?x=1")).toEqual({ ok: false, reason: "path" });
    expect(checkS3Endpoint("https://s3.example.com/#frag")).toEqual({ ok: false, reason: "path" });
  });

  it("rejects link-local / cloud metadata, 0.0.0.0 and loopback literals (incl. IPv6 and IPv4-mapped)", () => {
    for (const raw of [
      "http://169.254.169.254",
      "http://169.254.0.1:80",
      "http://0.0.0.0:9000",
      "http://0.1.2.3",
      "http://127.0.0.1:9000",
      "http://127.5.5.5",
      "http://localhost:9000",
      "http://foo.localhost",
      "http://[::1]:9000",
      "http://[::]",
      "http://[fe80::1]",
      "http://[::ffff:127.0.0.1]",
      "http://[::ffff:169.254.169.254]",
    ]) {
      expect(checkS3Endpoint(raw)).toEqual({ ok: false, reason: "blocked_host" });
    }
  });

  it("rejects shell metacharacters, whitespace and control characters outright", () => {
    for (const raw of ["https://a.example.com;rm", "https://a.example.com`id`", "https://a.example.com/$(id)", "https://a b.example.com", "https://a.exa\nmple.com", "", "   ", "https://a.example.com'x", 'https://a.example.com"x']) {
      expect(checkS3Endpoint(raw).ok).toBe(false);
    }
  });

  it("works as a zod superRefine with a stable message", () => {
    const S = z.string().superRefine(isSafeS3Endpoint);
    const r = S.safeParse("http://169.254.169.254");
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toBe("invalid_endpoint:blocked_host");
    expect(S.safeParse("https://s3.example.com").success).toBe(true);
  });
});

describe("CreateObjectMigrationSchema", () => {
  const ok = { name: "m", targetServerId: "s1", source: { endpoint: "https://src.example.com", accessKey: "AK", secretKey: "SK" }, destination: { endpoint: "http://host.docker.internal:9100", accessKey: "A", secretKey: "S" } };
  it("accepts a valid body and defaults preserve to true", () => {
    const r = CreateObjectMigrationSchema.parse(ok);
    expect(r.preserve).toBe(true);
  });
  it("rejects a hostile endpoint, newline/NUL credentials and empty name", () => {
    expect(CreateObjectMigrationSchema.safeParse({ ...ok, source: { ...ok.source, endpoint: "http://127.0.0.1:9000" } }).success).toBe(false);
    expect(CreateObjectMigrationSchema.safeParse({ ...ok, destination: { ...ok.destination, secretKey: "a\nb" } }).success).toBe(false);
    expect(CreateObjectMigrationSchema.safeParse({ ...ok, source: { ...ok.source, accessKey: "a\0b" } }).success).toBe(false);
    expect(CreateObjectMigrationSchema.safeParse({ ...ok, name: "" }).success).toBe(false);
  });
});
