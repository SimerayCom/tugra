import { classifyToken, deriveContainerPort, mapCategory, titleize, transformCompose } from "./import-transform";

describe("classifyToken (v2 widened table)", () => {
  it("maps the classic prefixes with length + kind", () => {
    expect(classifyToken("SERVICE_PASSWORD_64_JWT")).toEqual({ type: "secret", key: "PASSWORD_64_JWT", kind: "alnum", len: 64 });
    expect(classifyToken("SERVICE_HEX_32_KEY")).toEqual({ type: "secret", key: "HEX_32_KEY", kind: "hex", len: 32 });
    expect(classifyToken("SERVICE_REALBASE64_X")).toMatchObject({ kind: "base64" });
    expect(classifyToken("SERVICE_FQDN_APP_3000")).toEqual({ type: "fqdn", key: "FQDN_APP_3000" });
    expect(classifyToken("SERVICE_URL_APP")).toEqual({ type: "url", key: "URL_APP" });
  });
  it("recovers bare + widened tokens (PASSWORD, FQDN, PUBLICURL, *API_KEY)", () => {
    expect(classifyToken("SERVICE_PASSWORD")).toMatchObject({ type: "secret", kind: "alnum" });
    expect(classifyToken("SERVICE_FQDN")).toEqual({ type: "fqdn", key: "FQDN" });
    expect(classifyToken("SERVICE_PUBLICURL_APP")).toEqual({ type: "url", key: "PUBLICURL_APP" });
    expect(classifyToken("SERVICE_OPENAI_API_KEY")).toMatchObject({ type: "secret", kind: "alnum" });
  });
  it("leaves genuine config tokens unmapped (they are user config, not secrets)", () => {
    expect(classifyToken("SERVICE_DISABLE_SIGNUPS")).toBeNull();
    expect(classifyToken("SERVICE_DB_NAME")).toBeNull();
    expect(classifyToken("SERVICE_ID")).toBeNull();
  });
});

describe("deriveContainerPort", () => {
  it("prefers explicit meta.port", () => {
    expect(deriveContainerPort("services:\n  app:\n    image: x\n", 8080)).toBe(8080);
  });
  it("reads the web port from a SERVICE_(FQDN|URL)_<svc>_<port> magic token (gitea case)", () => {
    // gitea: no meta.port, own ports publishes SSH 22, but web port is 3000 in the FQDN token
    const raw = "services:\n  gitea:\n    image: gitea/gitea\n    environment:\n      - SERVICE_FQDN_GITEA_3000\n    ports:\n      - '22222:22'\n";
    expect(deriveContainerPort(raw, undefined)).toBe(3000);
  });
  it("falls back to expose:, then an own ports container side, then 0", () => {
    expect(deriveContainerPort("services:\n  app:\n    expose:\n      - '5000'\n", null)).toBe(5000);
    expect(deriveContainerPort("services:\n  app:\n    image: x\n    ports:\n      - '9000:9000'\n", null)).toBe(9000);
    expect(deriveContainerPort("services:\n  sidecar:\n    image: cloudflared\n", null)).toBe(0);
  });

  it("never derives the web port from a DATABASE service listed before the web service", () => {
    // db (postgres 5432) published BEFORE web (8080); no meta.port/magic/expose.
    const raw = "services:\n  db:\n    image: 'postgres:16'\n    ports:\n      - '5432:5432'\n  web:\n    image: 'myapp'\n    ports:\n      - '8080:8080'\n";
    expect(deriveContainerPort(raw, null)).toBe(8080); // the web port, NOT the db's 5432
  });
});

describe("transformCompose", () => {
  const simple = "services:\n  app:\n    image: 'nginx:latest'\n    environment:\n      - SERVICE_PASSWORD_DB\n";

  it("bakes a host port on the main service and returns its exposure", () => {
    const r = transformCompose(simple, 20001, 80);
    expect(r.compose).toContain('"20001:80"');
    expect(r.exposure).toEqual([{ serviceName: "app", containerPort: 80, defaultMode: "domain", public: true }]);
    expect(r.secrets).toEqual([{ key: "PASSWORD_DB", kind: "alnum", len: 32 }]);
    expect(r.compose).toContain("PASSWORD_DB=${PASSWORD_DB}"); // token stripped of SERVICE_ prefix
  });

  it("recovers an own-ports template: strips its published ports, re-publishes the web port on the sequence", () => {
    const raw = "services:\n  gitea:\n    image: 'gitea/gitea'\n    environment:\n      - SERVICE_FQDN_GITEA_3000\n    ports:\n      - '22222:22'\n";
    const r = transformCompose(raw, 20005, 3000);
    expect(r.compose).not.toContain("22222:22"); // own publish stripped
    expect(r.compose).toContain('"20005:3000"'); // web re-published on the assigned sequence port
    expect(r.exposure).toEqual([{ serviceName: "gitea", containerPort: 3000, defaultMode: "domain", public: true }]);
  });

  it("targets a non-database service for the published port (DB never exposed)", () => {
    const raw = "services:\n  db:\n    image: 'postgres:16'\n  web:\n    image: 'myapp'\n";
    const r = transformCompose(raw, 20009, 80);
    expect(r.exposure[0].serviceName).toBe("web"); // not the postgres db
    // the port block sits under web, not db
    expect(r.compose).toMatch(/web:[\s\S]*20009:80/);
  });

  it("strips a database's own published port (block AND inline flow style) so a DB is never host-published", () => {
    const block = "services:\n  db:\n    image: 'postgres:16'\n    ports:\n      - '5432:5432'\n  web:\n    image: 'myapp'\n";
    expect(transformCompose(block, 20014, 80).compose).not.toContain("5432:5432");
    const inline = "services:\n  db:\n    image: 'postgres:16'\n    ports: ['5432:5432']\n  web:\n    image: 'myapp'\n";
    const r = transformCompose(inline, 20015, 80);
    expect(r.compose).not.toContain("5432:5432"); // inline flow-style publish also stripped
    expect(r.compose).toContain('"20015:80"'); // only the web port is re-published
  });

  it("bakes localhost for FQDN/URL tokens (backward-compatible; resolver fixes it at install)", () => {
    const raw = "services:\n  app:\n    image: x\n    environment:\n      - APP_URL=${SERVICE_URL_APP}\n";
    const r = transformCompose(raw, 20010, 80);
    expect(r.compose).toContain("http://localhost:20010");
  });

  it("still skips inline content mounts (recovered with materialization in a later slice)", () => {
    const raw = "services:\n  app:\n    image: x\n    volumes:\n      -\n        type: bind\n        target: /etc/app.conf\n        content: \"a=1\"\n";
    expect(() => transformCompose(raw, 20011, 80)).toThrow();
  });

  it("skips a template whose magic token is a genuine unknown", () => {
    const raw = "services:\n  app:\n    image: x\n    environment:\n      - SERVICE_DISABLE_SIGNUPS\n";
    expect(() => transformCompose(raw, 20012, 80)).toThrow();
  });

  it("does not extract a phantom token from inside a larger env var NAME (word boundary)", () => {
    // The env var is NAMED ...WEBSERVICE_PASSWORD; only the ${SERVICE_PASSWORD_WEB} value is a token.
    const raw = "services:\n  app:\n    image: x\n    environment:\n      - 'DUPLICATI__WEBSERVICE_PASSWORD=${SERVICE_PASSWORD_WEB}'\n";
    const r = transformCompose(raw, 20013, 80);
    expect(r.secrets.map((s) => s.key)).toEqual(["PASSWORD_WEB"]); // no phantom "PASSWORD"
    expect(r.compose).toContain("DUPLICATI__WEBSERVICE_PASSWORD=${PASSWORD_WEB}"); // name intact, value resolved
  });
});

describe("mapCategory / titleize (moved helpers)", () => {
  it("maps a known category and keyword-classifies otherwise", () => {
    expect(mapCategory("database", [])).toBe("database");
    expect(mapCategory("weird", ["git", "ci"])).toBe("developer");
    expect(mapCategory(undefined, [])).toBe("tools");
  });
  it("titleizes a slug keeping short words lowercase", () => {
    expect(titleize("uptime-kuma")).toBe("Uptime Kuma");
    expect(titleize("node-red")).toBe("Node red"); // "red" ≤3 chars → stays lowercase
  });
});
