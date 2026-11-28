import { BadRequestException } from "@nestjs/common";
import { isHostname, normalizeCaCert, parseHostPort, validateContainers, validateDrainShape } from "./log-drain-shape";

// A real self-signed EC certificate (openssl req -x509 -newkey ec -subj /CN=tugra-test) so X509Certificate parses it.
const CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBgTCCASegAwIBAgIUQoLalbL+9LtctLKsxZ9MMheLMhEwCgYIKoZIzj0EAwIw
FTETMBEGA1UEAwwKdHVncmEtdGVzdDAgFw0yNjExMTUwNDI0MDRaGA8yMTI2MTAy
MjA0MjQwNFowFTETMBEGA1UEAwwKdHVncmEtdGVzdDBZMBMGByqGSM49AgEGCCqG
SM49AwEHA0IABGLYBrQJpJKmJISQYsZSVmE907lHbdE6Q3CTr2hXDSFyNB+hcJAH
3BuSarXuIeH5zCzxFl0ivPcOCE2lEfI3VEajUzBRMB0GA1UdDgQWBBT0JTlpPAil
/lNe0/u8AwifGeyimTAfBgNVHSMEGDAWgBT0JTlpPAil/lNe0/u8AwifGeyimTAP
BgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0gAMEUCIQDydBkxHrNCoUy/DEv0
DKK91VbZ/EP5zqDaX4mf1uNBdgIgcp3Kc7TPH4cz92aduXDl/wPDVFm+Khbp/NUv
uJt5aBU=
-----END CERTIFICATE-----`;

const bad = (fn: () => unknown, msg?: RegExp) => {
  expect(fn).toThrow(BadRequestException);
  if (msg) expect(fn).toThrow(msg);
};

describe("validateDrainShape: http / loki / datadog", () => {
  const base = { scope: "server" as const, allowPrivate: false };
  it("accepts http(s) URLs and returns null options", () => {
    for (const type of ["http", "loki", "datadog", "HTTP"]) {
      expect(validateDrainShape({ ...base, type, endpoint: "https://logs.example.com/push" })).toEqual({ options: null });
    }
    expect(validateDrainShape({ ...base, type: "http", endpoint: "http://logs.example.com", options: {} })).toEqual({ options: null });
  });
  it("rejects a non-http(s) scheme, host:port endpoints and options", () => {
    bad(() => validateDrainShape({ ...base, type: "http", endpoint: "ftp://x.example.com" }), /http\(s\)/);
    bad(() => validateDrainShape({ ...base, type: "http", endpoint: "udp://h:514" }));
    bad(() => validateDrainShape({ ...base, type: "http", endpoint: "logs.example.com:514" }));
    bad(() => validateDrainShape({ ...base, type: "loki", endpoint: "not a url" }));
    bad(() => validateDrainShape({ ...base, type: "http", endpoint: "https://x.example.com", options: { proto: "udp" } }), /options are not supported/);
  });
  it("rejects metadata for every scope, private literals only for app scope without allowPrivate", () => {
    bad(() => validateDrainShape({ ...base, type: "http", endpoint: "http://169.254.169.254/latest" }), /not allowed/);
    bad(() => validateDrainShape({ scope: "app", allowPrivate: true, type: "http", endpoint: "http://169.254.169.254/" }), /not allowed/);
    bad(() => validateDrainShape({ ...base, type: "http", endpoint: "http://[fd00:ec2::254]/" }));
    bad(() => validateDrainShape({ ...base, type: "http", endpoint: "http://2852039166/" })); // decimal form of 169.254.169.254 (URL parser normalises it)
    bad(() => validateDrainShape({ scope: "app", allowPrivate: false, type: "http", endpoint: "http://127.0.0.1:8080/" }), /allowPrivate/);
    bad(() => validateDrainShape({ scope: "app", allowPrivate: false, type: "http", endpoint: "http://10.1.2.3/" }), /allowPrivate/);
    bad(() => validateDrainShape({ scope: "app", allowPrivate: false, type: "http", endpoint: "http://localhost:3100/" }), /allowPrivate/);
    // even WITH allowPrivate (or at server scope) localhost is refused: the forwarder runs in the agent's container, where it is the agent itself
    for (const e of ["http://127.0.0.1:3100/", "http://localhost:3100/", "http://[::1]:3100/", "http://127.9.9.9/", "http://[::ffff:127.0.0.1]/"]) {
      bad(() => validateDrainShape({ scope: "app", allowPrivate: true, type: "http", endpoint: e }), /agent container/);
      bad(() => validateDrainShape({ ...base, type: "http", endpoint: e }), /agent container/);
    }
    bad(() => validateDrainShape({ scope: "app", allowPrivate: true, type: "syslog", endpoint: "localhost:514", options: { proto: "udp" } }), /agent container/);
    // server scope and allowPrivate keep today's reach
    expect(validateDrainShape({ ...base, type: "http", endpoint: "http://10.1.2.3/" })).toEqual({ options: null });
    expect(validateDrainShape({ scope: "app", allowPrivate: true, type: "http", endpoint: "http://10.1.2.3/" })).toEqual({ options: null });
  });
});

describe("validateDrainShape: syslog", () => {
  const sys = (options: unknown, extra: Record<string, unknown> = {}) =>
    validateDrainShape({ scope: "server", allowPrivate: false, type: "syslog", endpoint: "logs.example.com:514", options, ...extra });

  it("fills defaults (facility 16, framing by proto) and keeps given values", () => {
    expect(sys({ proto: "udp" }).options).toEqual({ proto: "udp", facility: 16 });
    expect(sys({ proto: "tcp" }).options).toEqual({ proto: "tcp", facility: 16, framing: "newline" });
    expect(sys({ proto: "tls" }).options).toEqual({ proto: "tls", facility: 16, framing: "octet" });
    expect(sys({ proto: "tcp", facility: 23, framing: "octet", appName: "my-app_1" }).options).toEqual({ proto: "tcp", facility: 23, framing: "octet", appName: "my-app_1" });
  });
  it("requires options and a known proto", () => {
    bad(() => validateDrainShape({ scope: "server", allowPrivate: false, type: "syslog", endpoint: "h.example.com:514" }), /options/);
    bad(() => sys({}), /proto/);
    bad(() => sys({ proto: "sctp" }));
  });
  it("rejects out-of-range facility, framing on udp, bad appName and unknown (secret-looking) keys", () => {
    bad(() => sys({ proto: "udp", facility: 24 }));
    bad(() => sys({ proto: "udp", facility: -1 }));
    bad(() => sys({ proto: "udp", framing: "octet" }), /framing/);
    bad(() => sys({ proto: "tcp", appName: "has space" }));
    bad(() => sys({ proto: "tcp", token: "s3cret" }), /token field, not options/);
    bad(() => sys({ proto: "tcp", password: "x" }), /unknown key/);
  });
  it("tls-only fields on udp/tcp are refused; a token is refused outright", () => {
    bad(() => sys({ proto: "udp", serverName: "logs.example.com" }), /only valid with proto: tls/);
    bad(() => sys({ proto: "tcp", caCert: CERT_PEM }), /only valid with proto: tls/);
    bad(() => sys({ proto: "udp" }, { hasToken: true }), /no authentication/);
    expect(sys({ proto: "tls", serverName: "logs.example.com" }).options).toMatchObject({ serverName: "logs.example.com" });
  });
});

describe("validateDrainShape: gelf", () => {
  const gelf = (options: unknown, extra: Record<string, unknown> = {}) =>
    validateDrainShape({ scope: "server", allowPrivate: false, type: "gelf", endpoint: "graylog.example.com:12201", options, ...extra });
  it("compress defaults to gzip on udp and none on tcp/tls", () => {
    expect(gelf({ proto: "udp" }).options).toEqual({ proto: "udp", compress: "gzip" });
    expect(gelf({ proto: "udp", compress: "zlib" }).options).toEqual({ proto: "udp", compress: "zlib" });
    expect(gelf({ proto: "tcp" }).options).toEqual({ proto: "tcp", compress: "none" });
    expect(gelf({ proto: "tls", compress: "none" }).options).toEqual({ proto: "tls", compress: "none" });
  });
  it("rejects compression over tcp/tls and a token", () => {
    bad(() => gelf({ proto: "tcp", compress: "gzip" }), /compress must be none/);
    bad(() => gelf({ proto: "tls", compress: "zlib" }));
    bad(() => gelf({ proto: "udp" }, { hasToken: true }), /no authentication/);
    bad(() => gelf({ proto: "udp", compress: "brotli" }));
  });
});

describe("validateDrainShape: fluentd", () => {
  const fl = (options: unknown, extra: Record<string, unknown> = {}) =>
    validateDrainShape({ scope: "server", allowPrivate: false, type: "fluentd", endpoint: "fluentd.example.com:24224", options, ...extra });
  it("defaults tag=tugra and requireAck=true; udp is not a fluentd proto", () => {
    expect(fl({ proto: "tcp" }).options).toEqual({ proto: "tcp", tag: "tugra", requireAck: true });
    expect(fl({ proto: "tls", tag: "prod.web", requireAck: false }).options).toEqual({ proto: "tls", tag: "prod.web", requireAck: false });
    bad(() => fl({ proto: "udp" }));
  });
  it("validates the tag shape and accepts the shared key as a token (never in options)", () => {
    bad(() => fl({ proto: "tcp", tag: "bad tag" }));
    bad(() => fl({ proto: "tcp", tag: "a.b.c.d.e" }));
    bad(() => fl({ proto: "tcp", sharedKey: "k" }), /token field, not options/);
    expect(fl({ proto: "tcp" }, { hasToken: true }).options).toBeTruthy();
  });
});

describe("validateDrainShape: NET endpoint + literal guard", () => {
  const net = (endpoint: string, scope: "server" | "app" = "server", allowPrivate = false) =>
    validateDrainShape({ scope, allowPrivate, type: "syslog", endpoint, options: { proto: "udp" } });
  it("accepts host:port, ipv4:port and [v6]:port", () => {
    for (const e of ["logs.example.com:514", "syslog:514", "203.0.113.9:6514", "[2001:db8::1]:514", "a-b.c.example.com:65535"]) expect(() => net(e)).not.toThrow();
  });
  it("rejects schemes, paths, userinfo, bad ports, bad hosts and numeric-IP spellings", () => {
    for (const e of ["udp://h:514", "h:514/x", "u@h:514", "h", "h:0", "h:65536", "h:abc", ":514", "h:514 ", " h:514", "[::1]", "[nothex]:514", "-bad.example.com:514", "2130706433:514", "127.1:514", "a..b:514", "h:1:2"]) {
      bad(() => net(e), undefined);
    }
  });
  it("blocks metadata/link-local always and private literals only for app scope without allowPrivate", () => {
    bad(() => net("169.254.169.254:514"), /not allowed/);
    bad(() => net("[fe80::1]:514"), /not allowed/);
    bad(() => net("[::ffff:169.254.169.254]:514"), /not allowed/);
    bad(() => net("0.0.0.0:514"), /not allowed/);
    bad(() => net("metadata.google.internal:514"), /not allowed/);
    bad(() => net("10.0.0.5:514", "app"), /allowPrivate/);
    bad(() => net("localhost:514", "app"), /allowPrivate/);
    bad(() => net("[::1]:514", "app"), /allowPrivate/);
    expect(() => net("10.0.0.5:514", "app", true)).not.toThrow();
    expect(() => net("10.0.0.5:514", "server")).not.toThrow();
    bad(() => net("169.254.169.254:514", "app", true), /not allowed/);
  });
});

describe("caCert", () => {
  it("rejects garbage, private keys, more than 4 blocks and a bad certificate; tolerates nothing but PEM CERTIFICATE blocks", () => {
    bad(() => normalizeCaCert("not a pem"), /PEM CERTIFICATE/);
    bad(() => normalizeCaCert("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----"), /PEM CERTIFICATE/);
    bad(() => normalizeCaCert("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----"), /invalid certificate/);
    const five = new Array(5).fill("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----").join("\n");
    bad(() => normalizeCaCert(five), /at most 4/);
    bad(() => normalizeCaCert(CERT_PEM + "\n-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----"), /only PEM CERTIFICATE/);
  });
  it("normalises a valid bundle (trimmed, one block per cert, trailing newline) and stores it in the options", () => {
    expect(normalizeCaCert("\n  " + CERT_PEM + "\n\n")).toBe(CERT_PEM + "\n");
    expect(normalizeCaCert(CERT_PEM + "\n" + CERT_PEM)).toBe(CERT_PEM + "\n" + CERT_PEM + "\n");
    const out = validateDrainShape({ scope: "server", allowPrivate: false, type: "syslog", endpoint: "h.example.com:6514", options: { proto: "tls", caCert: CERT_PEM, serverName: "h.example.com" } });
    expect(out.options).toEqual({ proto: "tls", facility: 16, framing: "octet", caCert: CERT_PEM + "\n", serverName: "h.example.com" });
  });
  it("rejects a bad PEM inside the syslog options", () => {
    bad(() => validateDrainShape({ scope: "server", allowPrivate: false, type: "syslog", endpoint: "h.example.com:6514", options: { proto: "tls", caCert: "garbage" } }), /PEM CERTIFICATE/);
  });
});

describe("hostname + endpoint helpers", () => {
  it("isHostname follows RFC 1123 and refuses an all-digit TLD", () => {
    expect(isHostname("logs.example.com")).toBe(true);
    expect(isHostname("a-b")).toBe(true);
    expect(isHostname("-a")).toBe(false);
    expect(isHostname("a_b")).toBe(false);
    expect(isHostname("1.2.3.4")).toBe(true); // dotted IPv4 is allowed
    expect(isHostname("127.1")).toBe(false);
    expect(isHostname("2130706433")).toBe(false);
    expect(isHostname("a".repeat(64) + ".com")).toBe(false);
  });
  it("parseHostPort returns host and numeric port", () => {
    expect(parseHostPort("[2001:db8::1]:6514")).toEqual({ host: "2001:db8::1", port: 6514 });
    expect(parseHostPort("h.example.com:514")).toEqual({ host: "h.example.com", port: 514 });
  });
});

describe("validateContainers", () => {
  it("server scope: globs in [A-Za-z0-9_.*?-], deduped, [] = all", () => {
    expect(validateContainers("server", [])).toEqual([]);
    expect(validateContainers("server", ["tugra_db_*", "tugra_?eb", "tugra_db_*"])).toEqual(["tugra_db_*", "tugra_?eb"]);
    bad(() => validateContainers("server", ["a[b]"]));
    bad(() => validateContainers("server", ["a\\b"]));
    bad(() => validateContainers("server", ["a b"]));
    bad(() => validateContainers("server", ["a/b"]));
  });
  it("app scope: service names, only for a non-clustered COMPOSE app (never silently ignored)", () => {
    const compose = { source: "COMPOSE", clusterId: null };
    expect(validateContainers("app", ["web", "worker-2"], compose)).toEqual(["web", "worker-2"]);
    expect(validateContainers("app", [], { source: "IMAGE", clusterId: null })).toEqual([]); // empty is always fine
    bad(() => validateContainers("app", ["web"], { source: "IMAGE", clusterId: null }), /compose apps/);
    bad(() => validateContainers("app", ["web"], { source: "GIT", clusterId: null }), /compose apps/);
    bad(() => validateContainers("app", ["web"], { source: "COMPOSE", clusterId: "c1" }), /compose apps/);
    bad(() => validateContainers("app", ["web"]), /compose apps/);
    bad(() => validateContainers("app", ["Web"], compose)); // uppercase is not a compose service charset here
    bad(() => validateContainers("app", ["tugra_*"], compose)); // no glob reaches an app filter
    bad(() => validateContainers("app", ["-x"], compose));
  });
});
