import { describe, expect, it } from "vitest";
import type { LogDrain } from "../../lib/types";
import {
  buildOptions,
  draftFromDrain,
  draftToPayload,
  emptyDraft,
  isValidContainerEntry,
  joinEndpoint,
  splitEndpoint,
  validateDraft,
  withType,
} from "./drain-model";

const filled = (over: Partial<ReturnType<typeof emptyDraft>>) => ({ ...emptyDraft("http"), name: "n", endpoint: "https://logs.example.com/in", ...over });

describe("emptyDraft", () => {
  it("starts http with no host/port and a gzip/udp-ish default set", () => {
    const d = emptyDraft();
    expect(d).toMatchObject({ type: "http", endpoint: "", token: "", containers: [], allowPrivate: false, requireAck: true, tag: "tugra", facility: "16" });
  });
  it("NET types get their conventional port and a first protocol they actually support", () => {
    expect(emptyDraft("syslog")).toMatchObject({ port: "514", proto: "udp" });
    expect(emptyDraft("gelf")).toMatchObject({ port: "12201", proto: "udp" });
    expect(emptyDraft("fluentd")).toMatchObject({ port: "24224", proto: "tcp" }); // Forward has no UDP mode
  });
  it("withType keeps name + filter, resets type-specific fields, and never turns a bearer into a shared key", () => {
    const d = { ...filled({ token: "bearer", containers: ["web"] }), name: "keep" };
    expect(withType(d, "loki")).toMatchObject({ type: "loki", name: "keep", token: "bearer", containers: ["web"] });
    expect(withType(d, "fluentd")).toMatchObject({ type: "fluentd", name: "keep", token: "", port: "24224", containers: ["web"] });
  });
});

describe("draftToPayload", () => {
  it("http/loki/datadog: URL endpoint, bearer only when typed, no options, no allowPrivate on a server", () => {
    expect(draftToPayload(filled({ type: "loki", token: "t" }), "server")).toEqual({
      name: "n", type: "loki", endpoint: "https://logs.example.com/in", containers: [], token: "t",
    });
    const noToken = draftToPayload(filled({}), "server");
    expect("token" in noToken).toBe(false); // blank = keep / none
    expect("options" in noToken).toBe(false);
    expect("allowPrivate" in noToken).toBe(false);
  });

  it("app scope adds allowPrivate", () => {
    expect(draftToPayload(filled({ allowPrivate: true }), "app").allowPrivate).toBe(true);
    expect(draftToPayload(filled({}), "app").allowPrivate).toBe(false);
  });

  it("syslog: host:port endpoint, options without secrets, framing only for tcp/tls, no token ever", () => {
    const udp = draftToPayload({ ...emptyDraft("syslog"), name: "s", host: "logs.example.com", facility: "3", appName: "web", token: "must-not-leak", framing: "octet" }, "server");
    expect(udp).toEqual({ name: "s", type: "syslog", endpoint: "logs.example.com:514", containers: [], options: { proto: "udp", facility: 3, appName: "web" } });
    const tcp = draftToPayload({ ...emptyDraft("syslog"), name: "s", host: "10.0.0.1", proto: "tcp", framing: "octet" }, "server");
    expect(tcp.options).toEqual({ proto: "tcp", facility: 16, framing: "octet" });
    expect(JSON.stringify(udp)).not.toContain("must-not-leak");
  });

  it("syslog over tls adds caCert + serverName; they are dropped for tcp/udp", () => {
    const pem = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----";
    const tls = draftToPayload({ ...emptyDraft("syslog"), name: "s", host: "h.example.com", proto: "tls", caCert: pem, serverName: "h.example.com" }, "server");
    expect(tls.options).toMatchObject({ proto: "tls", caCert: pem, serverName: "h.example.com" });
    const tcp = draftToPayload({ ...emptyDraft("syslog"), name: "s", host: "h.example.com", proto: "tcp", caCert: pem, serverName: "x" }, "server");
    expect(tcp.options).not.toHaveProperty("caCert");
    expect(tcp.options).not.toHaveProperty("serverName");
  });

  it("gelf: compression only for udp", () => {
    expect(buildOptions({ ...emptyDraft("gelf"), proto: "udp", compress: "zlib" })).toEqual({ proto: "udp", compress: "zlib" });
    expect(buildOptions({ ...emptyDraft("gelf"), proto: "tcp", compress: "zlib" })).toEqual({ proto: "tcp" });
  });

  it("fluentd: tag + requireAck in options, the shared key in the token field", () => {
    const p = draftToPayload({ ...emptyDraft("fluentd"), name: "f", host: "fluentd.example.com", tag: "prod.web", requireAck: false, token: "sharedkey" }, "app");
    expect(p).toEqual({
      name: "f", type: "fluentd", endpoint: "fluentd.example.com:24224", containers: [], token: "sharedkey",
      options: { proto: "tcp", tag: "prod.web", requireAck: false }, allowPrivate: false,
    });
    expect(JSON.stringify(p.options)).not.toContain("sharedkey");
  });

  it("always sends the container filter (so clearing it clears on the hub)", () => {
    expect(draftToPayload(filled({ containers: [] }), "server").containers).toEqual([]);
    expect(draftToPayload(filled({ containers: ["web", "worker"] }), "app").containers).toEqual(["web", "worker"]);
  });
});

describe("splitEndpoint / joinEndpoint", () => {
  it("round-trips host:port, ipv4:port and [v6]:port", () => {
    expect(splitEndpoint("logs.example.com:514")).toEqual({ host: "logs.example.com", port: "514" });
    expect(splitEndpoint("203.0.113.9:6514")).toEqual({ host: "203.0.113.9", port: "6514" });
    expect(splitEndpoint("[2001:db8::1]:514")).toEqual({ host: "2001:db8::1", port: "514" });
    expect(splitEndpoint("nohost")).toEqual({ host: "nohost", port: "" });
    expect(joinEndpoint("logs.example.com", "514")).toBe("logs.example.com:514");
    expect(joinEndpoint("2001:db8::1", "514")).toBe("[2001:db8::1]:514"); // an IPv6 literal is bracketed
    expect(joinEndpoint("[2001:db8::1]", "514")).toBe("[2001:db8::1]:514"); // ...but never twice
    expect(joinEndpoint(" h.example.com ", " 514 ")).toBe("h.example.com:514");
  });
});

describe("draftFromDrain", () => {
  const base: LogDrain = {
    id: "d1", name: "n", type: "syslog", endpoint: "[2001:db8::1]:6514", enabled: true, hasToken: false, createdAt: "", scope: "app", appId: "a1",
    containers: ["web"], options: { proto: "tls", facility: 5, framing: "newline", appName: "x", caCert: "PEM", serverName: "sn" }, allowPrivate: true, delivery: "ok", status: null,
  };
  it("restores a NET drain's host/port/options and the filter", () => {
    expect(draftFromDrain(base)).toMatchObject({
      type: "syslog", host: "2001:db8::1", port: "6514", proto: "tls", facility: "5", framing: "newline", appName: "x", caCert: "PEM", serverName: "sn",
      containers: ["web"], allowPrivate: true, token: "",
    });
  });
  it("restores an http drain's URL and tolerates a legacy upper-case type", () => {
    const d = draftFromDrain({ ...base, type: "HTTP", endpoint: "https://x.example.com", options: null, containers: [], allowPrivate: false });
    expect(d).toMatchObject({ type: "http", endpoint: "https://x.example.com" });
  });
  it("round-trips through draftToPayload", () => {
    const p = draftToPayload(draftFromDrain(base), "app");
    expect(p).toMatchObject({ type: "syslog", endpoint: "[2001:db8::1]:6514", options: { proto: "tls", facility: 5, framing: "newline" }, allowPrivate: true, containers: ["web"] });
  });
});

describe("validateDraft", () => {
  it("accepts a fine http and a fine NET draft", () => {
    expect(validateDraft(filled({}), "server")).toBeNull();
    expect(validateDraft({ ...emptyDraft("syslog"), name: "s", host: "logs.example.com" }, "server")).toBeNull();
    expect(validateDraft({ ...emptyDraft("gelf"), name: "g", host: "2001:db8::1", port: "12201" }, "app")).toBeNull();
  });
  it.each([
    [{ name: " " }, "logdrains.validation_name"],
    [{ endpoint: "" }, "logdrains.validation_url"],
    [{ endpoint: "ftp://x.example.com" }, "logdrains.validation_url"],
    [{ endpoint: "logs.example.com:514" }, "logdrains.validation_url"],
  ])("http %j -> %s", (over, key) => expect(validateDraft(filled(over), "server")).toBe(key));

  it.each([
    [{ host: "" }, "logdrains.validation_host"],
    [{ host: "udp://h" }, "logdrains.validation_host"],
    [{ host: "h/x" }, "logdrains.validation_host"],
    [{ host: "bad host" }, "logdrains.validation_host"],
    [{ host: "-x.example.com" }, "logdrains.validation_host"],
    [{ host: "h.example.com", port: "0" }, "logdrains.validation_port"],
    [{ host: "h.example.com", port: "65536" }, "logdrains.validation_port"],
    [{ host: "h.example.com", port: "abc" }, "logdrains.validation_port"],
    [{ host: "h.example.com", facility: "24" }, "logdrains.validation_facility"],
    [{ host: "h.example.com", facility: "x" }, "logdrains.validation_facility"],
    [{ host: "h.example.com", appName: "bad name" }, "logdrains.validation_appName"],
    [{ host: "h.example.com", proto: "tls" as const, caCert: "nope" }, "logdrains.validation_caCert"],
    [{ host: "h.example.com", proto: "tls" as const, serverName: "bad name" }, "logdrains.validation_serverName"],
  ])("syslog %j -> %s", (over, key) => expect(validateDraft({ ...emptyDraft("syslog"), name: "s", ...over }, "server")).toBe(key));

  it("fluentd tag shape", () => {
    expect(validateDraft({ ...emptyDraft("fluentd"), name: "f", host: "h.example.com", tag: "bad tag" }, "server")).toBe("logdrains.validation_tag");
    expect(validateDraft({ ...emptyDraft("fluentd"), name: "f", host: "h.example.com", tag: "a.b.c.d.e" }, "server")).toBe("logdrains.validation_tag");
    expect(validateDraft({ ...emptyDraft("fluentd"), name: "f", host: "h.example.com", tag: "prod.web" }, "server")).toBeNull();
  });

  it("container entries are validated per scope", () => {
    expect(validateDraft(filled({ containers: ["tugra_db_*"] }), "server")).toBeNull();
    expect(validateDraft(filled({ containers: ["tugra_db_*"] }), "app")).toBe("logdrains.validation_container_app");
    expect(validateDraft(filled({ containers: ["Web"] }), "app")).toBe("logdrains.validation_container_app");
    expect(validateDraft(filled({ containers: ["web", "worker-2"] }), "app")).toBeNull();
    expect(validateDraft(filled({ containers: ["a b"] }), "server")).toBe("logdrains.validation_container_server");
    expect(isValidContainerEntry("web", "app")).toBe(true);
    expect(isValidContainerEntry("a[b]", "server")).toBe(false);
  });
});
