import {
  COOLIFY_SENSITIVE_KEYS,
  COOLIFY_SENSITIVE_KEYS_BY_KIND,
  hiddenSensitiveKeys,
  isSensitiveVisible,
  sensitiveVisibility,
} from "./coolify-sensitive";

// A 4.7.5 application row for a plain read token: the hidden attributes are REMOVED, the rest stay.
const plainApp = { uuid: "a1", name: "web", build_pack: "nixpacks", fqdn: "https://a.example.com", git_repository: "o/r", ports_exposes: "3000" };
// The same row for a read:sensitive token of a team admin: the keys are back, a column that is NULL is serialized as null.
const sensitiveApp = { ...plainApp, install_command: null, build_command: "npm run build", start_command: null, custom_labels: "Zm9v", dockerfile: null };

describe("isSensitiveVisible", () => {
  it("is false when every sensitive key is absent (read token without read:sensitive)", () => {
    expect(isSensitiveVisible(plainApp)).toBe(false);
    expect(isSensitiveVisible(plainApp, "application")).toBe(false);
    expect(sensitiveVisibility(plainApp, "application")).toBe("hidden");
  });

  it("is true when any key is present, even as null (visible but empty)", () => {
    expect(isSensitiveVisible(sensitiveApp, "application")).toBe(true);
    expect(isSensitiveVisible({ ...plainApp, start_command: null })).toBe(true);
    expect(sensitiveVisibility(sensitiveApp)).toBe("visible");
  });

  it("works per kind: a database's *_conf, a service's compose text", () => {
    const plainDb = { uuid: "d", database_type: "standalone-redis", image: "redis:7.2" };
    expect(isSensitiveVisible(plainDb, "database")).toBe(false);
    expect(isSensitiveVisible({ ...plainDb, redis_conf: null }, "database")).toBe(true);
    expect(isSensitiveVisible({ ...plainDb, postgres_conf: "x" }, "database")).toBe(true);
    expect(isSensitiveVisible({ uuid: "s", name: "svc" }, "service")).toBe(false);
    expect(isSensitiveVisible({ uuid: "s", docker_compose_raw: "c2VydmljZXM6" }, "service")).toBe(true);
  });

  it("a key of another kind does not make a row of this kind visible", () => {
    expect(isSensitiveVisible({ uuid: "s", build_command: "x" }, "service")).toBe(false);
  });

  it("a non-object row is never visible", () => {
    for (const r of [null, undefined, "x", 3, []]) expect(isSensitiveVisible(r)).toBe(false);
  });

  it("an older Coolify (commands readable with a read token) reports visible, so nothing is warned", () => {
    expect(isSensitiveVisible({ ...plainApp, install_command: "npm i", build_command: "npm run build", start_command: "npm start" })).toBe(true);
  });
});

describe("sensitive key list", () => {
  it("covers what Coolify 4.7.5 hides", () => {
    for (const k of ["install_command", "build_command", "start_command", "pre_deployment_command", "post_deployment_command", "health_check_command", "health_check_response_text", "custom_docker_run_options", "dockerfile", "custom_labels", "docker_compose_raw", "postgres_conf", "mysql_conf", "mariadb_conf", "mongo_conf", "redis_conf", "keydb_conf"]) {
      expect(COOLIFY_SENSITIVE_KEYS).toContain(k);
    }
    expect(new Set(COOLIFY_SENSITIVE_KEYS).size).toBe(COOLIFY_SENSITIVE_KEYS.length);
    expect(COOLIFY_SENSITIVE_KEYS_BY_KIND.service).toContain("docker_compose_raw");
  });

  it("hiddenSensitiveKeys names what the created resource would lack, and is empty when visible", () => {
    expect(hiddenSensitiveKeys(plainApp, "application")).toContain("build_command");
    expect(hiddenSensitiveKeys(sensitiveApp, "application")).toEqual([]);
  });
});
