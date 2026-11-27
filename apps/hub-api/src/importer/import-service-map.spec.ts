import { parse } from "yaml";
import { assertSafeCompose } from "../deploy/compose-safety";
import { transformServiceCompose, tokenizeVars, type ServiceTransformResult } from "./import-service-map";
import { fixtureByName, loadServiceFixtures, SIGNOZ_FILES } from "./testing/service-fixtures";
import type { ForeignService } from "./foreign-fleet";

const SECRET = "s3cr3t-value-DO-NOT-LEAK";
const bundleFor = (keys: string[], files = SIGNOZ_FILES) => ({
  values: Object.fromEntries(keys.map((k) => [k, `${SECRET}-${k}`])),
  files,
});
const svcOf = (over: Partial<ForeignService> = {}): ForeignService => ({ sourceRef: "svc00001", name: "t", memberApps: [], memberDbs: [], ...over });
const run = (raw: string, over: Partial<Parameters<typeof transformServiceCompose>[0]> = {}) => transformServiceCompose({ svc: svcOf(), raw, ...over });
const doc = (r: ServiceTransformResult) => parse(r.compose) as { services: Record<string, any>; volumes?: Record<string, unknown> };

describe("transformServiceCompose over the 19 real service shapes", () => {
  const fixtures = loadServiceFixtures();

  it("loads all 19 fixtures", () => {
    expect(fixtures).toHaveLength(19);
  });

  it("gives every service an explicit verdict and a gate-clean compose when it is importable", () => {
    const verdicts: Record<string, string> = {};
    for (const f of fixtures) {
      const r = transformServiceCompose({ svc: f.svc, raw: f.raw.docker_compose_raw!, bundle: bundleFor(["SERVICE_PASSWORD_MEILISEARCH", "SERVICE_USER_MINIO", "SERVICE_PASSWORD_MINIO", "MINIO_SERVER_URL", "MINIO_BROWSER_REDIRECT_URL", "CLOUDFLARE_TUNNEL_TOKEN", "SERVICE_USER_GOTENBERG", "SERVICE_PASSWORD_GOTENBERG", "SERVICE_REALBASE64_JWTSECRET", "SIGNOZ_EMAILING_SMTP_ADDRESS", "SIGNOZ_EMAILING_SMTP_FROM", "SIGNOZ_EMAILING_SMTP_AUTH_USERNAME", "SIGNOZ_EMAILING_SMTP_AUTH_PASSWORD", "SIGNOZ_ALERTMANAGER_SIGNOZ_GLOBAL_SMTP__AUTH__PASSWORD", "SIGNOZ_ALERTMANAGER_SIGNOZ_GLOBAL_SMTP__AUTH__USERNAME", "SIGNOZ_ALERTMANAGER_SIGNOZ_GLOBAL_SMTP__FROM", "SIGNOZ_ALERTMANAGER_SIGNOZ_GLOBAL_SMTP__SMARTHOST"]) });
      verdicts[f.raw.name!] = r.verdict;
      if (r.verdict !== "skipped") expect(() => assertSafeCompose(r.compose)).not.toThrow();
      expect(r.gate).toBe("ok");
    }
    const counts = Object.values(verdicts).reduce<Record<string, number>>((m, v) => ((m[v] = (m[v] ?? 0) + 1), m), {});
    // 7 meilisearch + 6 MinIO + gotenberg + cloudflared importable; beszel-hub + signoz partial; 2 standalone agents skipped.
    expect(counts).toEqual({ importable: 15, partial: 2, skipped: 2 });
    expect(verdicts["beszel-hub"]).toBe("partial");
    expect(verdicts["signoz-hub"]).toBe("partial");
    expect(verdicts["beszel-infra-agent"]).toBe("skipped");
    expect(verdicts["beszel-storage-agent"]).toBe("skipped");
  });

  it("meilisearch: carries the master key reference, declares the data volume, drops the magic URL, warns about :latest", () => {
    const f = fixtureByName("alpha-meilisearch");
    const r = transformServiceCompose({ svc: f.svc, raw: f.raw.docker_compose_raw!, bundle: bundleFor(["SERVICE_PASSWORD_MEILISEARCH"]) });
    expect(r.verdict).toBe("importable");
    const d = doc(r);
    expect(d.volumes).toEqual({ "meilisearch-data": {} });
    expect(JSON.stringify(d.services.meilisearch.environment)).not.toContain("SERVICE_URL_");
    expect(JSON.stringify(d.services.meilisearch.environment)).toContain("${SERVICE_PASSWORD_MEILISEARCH}");
    expect(r.env.SERVICE_PASSWORD_MEILISEARCH).toBe(`${SECRET}-SERVICE_PASSWORD_MEILISEARCH`);
    expect(r.volumes).toEqual([expect.objectContaining({ key: "meilisearch-data", origin: "named", policy: "copy", dataPlane: "hub-staged" })]);
    expect(r.floating).toEqual(["meilisearch"]);
    expect(r.domainHints).toEqual([{ service: "meilisearch", port: 7700 }]);
    expect(r.domains).toEqual([]);
  });

  it("meilisearch pinned to the running version when a pin is given; a foreign repository is refused", () => {
    const f = fixtureByName("alpha-meilisearch");
    const raw = f.raw.docker_compose_raw!;
    const ok = transformServiceCompose({ svc: f.svc, raw, pins: { meilisearch: "getmeili/meilisearch:v1.12.3" } });
    expect(doc(ok).services.meilisearch.image).toBe("getmeili/meilisearch:v1.12.3");
    expect(ok.pinned).toEqual(["meilisearch"]);
    expect(ok.floating).toEqual([]);
    const bad = transformServiceCompose({ svc: f.svc, raw, pins: { meilisearch: "evil/other:v1" } });
    expect(doc(bad).services.meilisearch.image).toBe("getmeili/meilisearch:latest");
    expect(bad.floating).toEqual(["meilisearch"]);
    const off = transformServiceCompose({ svc: f.svc, raw, pins: { meilisearch: "getmeili/meilisearch:v1.12.3" }, choice: { pinImages: false } });
    expect(off.pinned).toEqual([]);
    const already = fixtureByName("delta-meilisearch");
    const pinned = transformServiceCompose({ svc: already.svc, raw: already.raw.docker_compose_raw! });
    expect(pinned.floating).toEqual([]); // bookings-style: already on a version tag
  });

  it("MinIO: strips container_name, rewrites a host bind into a named volume, carries the env references, no ports", () => {
    const f = fixtureByName("delta-storage-minio");
    const r = transformServiceCompose({ svc: f.svc, raw: f.raw.docker_compose_raw!, bundle: bundleFor(["SERVICE_USER_MINIO", "SERVICE_PASSWORD_MINIO", "MINIO_SERVER_URL", "MINIO_BROWSER_REDIRECT_URL"]) });
    const d = doc(r);
    expect(r.verdict).toBe("importable");
    expect(d.services.minio.container_name).toBeUndefined();
    expect(d.services.minio.volumes).toEqual(["minio-data:/data"]);
    expect(d.volumes).toEqual({ "minio-data": {} });
    expect(r.volumes[0]).toMatchObject({ key: "minio-data", origin: "host-bind", sourcePath: "/mnt/HC_Volume_100000001", policy: "copy" });
    expect(JSON.stringify(d)).not.toContain("/mnt/HC_Volume");
    expect(Object.keys(r.env).sort()).toEqual(["MINIO_BROWSER_REDIRECT_URL", "MINIO_SERVER_URL", "SERVICE_PASSWORD_MINIO", "SERVICE_USER_MINIO"]);
    expect(r.dropped.map((x) => x.field)).toEqual(expect.arrayContaining(["minio.container_name", "volume:minio-data"]));
    expect(d.services.minio.environment.join("\n")).toContain("MINIO_API_CORS_ALLOW_ORIGIN=https://");
    expect(r.domains).toEqual([]);
  });

  it("MinIO with a named volume keeps it as named", () => {
    const f = fixtureByName("alpha-storage-minio");
    const r = transformServiceCompose({ svc: f.svc, raw: f.raw.docker_compose_raw! });
    expect(r.volumes[0]).toMatchObject({ key: "minio-data", origin: "named" });
  });

  it("gotenberg: stateless, credentials carried, no volumes", () => {
    const f = fixtureByName("eta-gotenberg");
    const r = transformServiceCompose({ svc: f.svc, raw: f.raw.docker_compose_raw!, bundle: bundleFor(["SERVICE_USER_GOTENBERG", "SERVICE_PASSWORD_GOTENBERG"]) });
    expect(r.verdict).toBe("importable");
    expect(r.volumes).toEqual([]);
    expect(Object.keys(r.env).sort()).toEqual(["SERVICE_PASSWORD_GOTENBERG", "SERVICE_USER_GOTENBERG"]);
    expect(r.floating).toEqual(["gotenberg"]);
  });

  it("cloudflared: importable, held (created stopped), token carried, container_name stripped", () => {
    const f = fixtureByName("cloudflared-hub");
    const r = transformServiceCompose({ svc: f.svc, raw: f.raw.docker_compose_raw!, bundle: bundleFor(["CLOUDFLARE_TUNNEL_TOKEN"]) });
    expect(r.verdict).toBe("importable");
    expect(r.hold).toBe(true);
    expect(r.env.CLOUDFLARE_TUNNEL_TOKEN).toContain(SECRET);
    expect(doc(r).services.cloudflared.container_name).toBeUndefined();
    expect(transformServiceCompose({ svc: f.svc, raw: f.raw.docker_compose_raw!, choice: { hold: false } }).hold).toBe(false);
  });

  it("beszel hub: the docker.sock agent is dropped with its depends/volumes, the hub keeps its volumes and its domain", () => {
    const f = fixtureByName("beszel-hub");
    expect(() => assertSafeCompose(f.raw.docker_compose_raw!)).toThrow(); // the unmodified raw fails the gate
    const r = transformServiceCompose({ svc: f.svc, raw: f.raw.docker_compose_raw!, bundle: { values: {} } });
    expect(r.verdict).toBe("partial");
    expect(r.membersKept).toEqual(["beszel"]);
    expect(r.membersDropped).toEqual([{ name: "beszel-agent", reason: expect.stringMatching(/Docker socket/) }]);
    const d = doc(r);
    expect(Object.keys(d.services)).toEqual(["beszel"]);
    expect(Object.keys(d.volumes ?? {}).sort()).toEqual(["beszel_data", "beszel_socket"]);
    expect(r.missingEnv).toEqual([]); // TOKEN / KEY vanished with the agent
    expect(r.domains).toEqual([{ service: "beszel", hostname: "monitor.example.test", port: 8090 }]);
    expect(() => assertSafeCompose(r.compose)).not.toThrow();
  });

  it("a standalone beszel-agent is skipped (zero survivors) without a gate failure", () => {
    for (const name of ["beszel-infra-agent", "beszel-storage-agent"]) {
      const f = fixtureByName(name);
      const r = transformServiceCompose({ svc: f.svc, raw: f.raw.docker_compose_raw! });
      expect(r.verdict).toBe("skipped");
      expect(r.gate).toBe("ok");
      expect(r.membersKept).toEqual([]);
      expect(r.membersDropped).toHaveLength(1);
    }
  });

  it("signoz: config files become config mounts, clickhouse is skipped, zookeeper empty, sqlite copied, depends_on kept", () => {
    const f = fixtureByName("signoz-hub");
    const keys = ["SERVICE_REALBASE64_JWTSECRET", "SIGNOZ_EMAILING_SMTP_ADDRESS", "SIGNOZ_EMAILING_SMTP_FROM", "SIGNOZ_EMAILING_SMTP_AUTH_USERNAME", "SIGNOZ_EMAILING_SMTP_AUTH_PASSWORD", "SIGNOZ_ALERTMANAGER_SIGNOZ_GLOBAL_SMTP__AUTH__PASSWORD", "SIGNOZ_ALERTMANAGER_SIGNOZ_GLOBAL_SMTP__AUTH__USERNAME", "SIGNOZ_ALERTMANAGER_SIGNOZ_GLOBAL_SMTP__FROM", "SIGNOZ_ALERTMANAGER_SIGNOZ_GLOBAL_SMTP__SMARTHOST"];
    const r = transformServiceCompose({ svc: f.svc, raw: f.raw.docker_compose_raw!, bundle: bundleFor(keys) });
    expect(r.verdict).toBe("partial");
    expect(r.gate).toBe("ok");
    expect(r.neededFiles).toEqual([]);
    expect(r.configMounts).toHaveLength(7);
    expect(r.configMounts.map((m) => `${m.serviceName}:${m.target}`)).toContain("signoz:/root/config/prometheus.yml");
    const byKey = Object.fromEntries(r.volumes.map((v) => [v.key, v]));
    expect(byKey.clickhouse).toMatchObject({ policy: "skip", dataPlane: "not-carried" });
    expect(byKey.zookeeper).toMatchObject({ policy: "empty", dataPlane: "stateless" });
    expect(byKey.sqlite).toMatchObject({ policy: "copy", dataPlane: "hub-staged" });
    const d = doc(r);
    expect(Object.keys(d.volumes ?? {}).sort()).toEqual(["clickhouse", "sqlite", "zookeeper"]);
    expect(d.services.clickhouse.depends_on["init-clickhouse"].condition).toBe("service_completed_successfully");
    expect(JSON.stringify(d)).not.toContain("exclude_from_hc");
    expect(r.dropped.map((x) => x.field)).toContain("schema-migrator-sync.exclude_from_hc");
    expect(JSON.stringify(d.services.clickhouse.volumes)).not.toContain("./clickhouse");
    expect(r.domains.map((x) => `${x.service}:${x.port}`)).toEqual(["otel-collector:4318", "signoz:8080"]);
    // `$$` shell escapes in the init command survive byte for byte
    expect(d.services["init-clickhouse"].command[2]).toContain("$$(uname -s");
  });

  it("signoz without its files: needed files are listed; skipped once the secrets are known (apply), not at plan time", () => {
    const f = fixtureByName("signoz-hub");
    const plan = transformServiceCompose({ svc: f.svc, raw: f.raw.docker_compose_raw! });
    expect(plan.neededFiles).toHaveLength(7);
    expect(plan.verdict).toBe("partial");
    expect(plan.unverifiedKeys.length).toBeGreaterThan(0);
    expect(plan.missingEnv).toEqual([]);
    const apply = transformServiceCompose({ svc: f.svc, raw: f.raw.docker_compose_raw!, bundle: { values: {}, files: [] } });
    expect(apply.verdict).toBe("skipped");
    expect(apply.neededFiles).toHaveLength(7);
    expect(apply.missingEnv).toContain("SERVICE_REALBASE64_JWTSECRET");
  });

  it("is idempotent on its own output and deterministic", () => {
    for (const f of fixtures) {
      const a = transformServiceCompose({ svc: f.svc, raw: f.raw.docker_compose_raw!, bundle: bundleFor([], []) });
      const b = transformServiceCompose({ svc: f.svc, raw: f.raw.docker_compose_raw!, bundle: bundleFor([], []) });
      expect(a).toEqual(b);
      if (a.verdict === "skipped") continue;
      const again = transformServiceCompose({ svc: f.svc, raw: a.compose });
      expect(again.compose).toBe(a.compose);
    }
  });

  it("never puts a secret value in anything but env", () => {
    for (const f of fixtures) {
      const keys = [...new Set([...(f.raw.docker_compose_raw!.matchAll(/\$\{?([A-Z_][A-Z0-9_]*)/g))].map((m) => m[1]))];
      const r = transformServiceCompose({ svc: f.svc, raw: f.raw.docker_compose_raw!, bundle: bundleFor(keys) });
      const { env, configMounts, ...rest } = r;
      void env;
      void configMounts;
      expect(JSON.stringify(rest)).not.toContain(SECRET);
    }
  });
});

describe("transformServiceCompose rules", () => {
  it("R1: unparsable, wrong-shape, oversized and alias-bomb input is a gate failure, never a throw", () => {
    expect(run("services: [").gate).toMatchObject({ code: "compose-unparsed" });
    expect(run("- a\n- b").gate).toMatchObject({ code: "compose-unparsed" });
    expect(run("services: {}").gate).toMatchObject({ code: "compose-unparsed" });
    expect(run("").gate).toMatchObject({ code: "compose-unparsed" });
    expect(run("services:\n  a: 1\n").gate).toMatchObject({ code: "compose-unparsed" });
    expect(run(`services:\n  a:\n    image: x\n    #${"x".repeat(300 * 1024)}\n`).gate).toMatchObject({ code: "compose-too-large" });
    const bomb = ["a: &a [x,x,x,x,x,x,x,x,x]", ...Array.from({ length: 12 }, (_, i) => `b${i}: &b${i} [${Array(9).fill(i === 0 ? "*a" : `*b${i - 1}`).join(",")}]`), "services:\n  s:\n    image: x"].join("\n");
    expect(run(bomb).verdict).toBe("skipped");
    expect(run("services:\n  'bad name!':\n    image: x\n").gate).toMatchObject({ code: "service-name" });
    expect(run("services:\n  a:\n    image: x\n").verdict).toBe("importable");
  });

  it("R3: bare SERVICE_URL_* is dropped into a hint; ${SERVICE_URL_X} resolves to a mapped domain, else is reported", () => {
    const svc = svcOf({ members: [{ name: "web", kind: "app", ref: "m1", domains: [{ host: "Web.Example.Test", port: 3000, https: true, serviceRef: "web" }] }] });
    const r = transformServiceCompose({
      svc,
      raw: "services:\n  web:\n    image: a:1\n    environment:\n      - SERVICE_URL_WEB_3000\n      - 'PUBLIC_URL=${SERVICE_URL_WEB}'\n      - 'OTHER=${SERVICE_URL_NOPE}'\n",
    });
    expect(doc(r).services.web.environment).toEqual(["PUBLIC_URL=https://web.example.test", "OTHER=${SERVICE_URL_NOPE}"]);
    expect(r.domainHints).toEqual([{ service: "web", port: 3000 }]);
    expect(r.dropped).toContainEqual({ field: "SERVICE_URL_NOPE", reason: expect.stringMatching(/magic URL/), level: "warn" });
  });

  it("R3: map-form environment is handled the same way", () => {
    const r = run("services:\n  web:\n    image: a:1\n    environment:\n      SERVICE_FQDN_WEB: ''\n      KEEP: v\n");
    expect(doc(r).services.web.environment).toEqual({ KEEP: "v" });
  });

  it("R4: required keys, defaults, bare passthrough and the $$ escape", () => {
    const raw = "services:\n  a:\n    image: x:1\n    command: 'echo $$HOME ${WITH_DEFAULT:-d} ${REQUIRED?msg} $PLAIN'\n    environment:\n      - 'A=${NEEDED}'\n";
    const plan = run(raw);
    expect(plan.unverifiedKeys).toEqual(["NEEDED", "PLAIN", "REQUIRED"]);
    expect(plan.missingEnv).toEqual([]);
    const apply = run(raw, { bundle: { values: { PLAIN: "p", WITH_DEFAULT: "w" } } });
    expect(apply.missingEnv).toEqual(["NEEDED", "REQUIRED"]);
    expect(apply.env.PLAIN).toBe("p");
    expect(apply.env.WITH_DEFAULT).toBe("w");
    expect(doc(apply).services.a.command).toContain("$$HOME");
  });

  it("R4: a literal secret is hoisted to env and the compose keeps a reference; name clashes get a service prefix", () => {
    const raw = "services:\n  db:\n    image: x:1\n    environment:\n      - DB_PASSWORD=hunter2\n      - REGION=eu\n  api:\n    image: y:1\n    environment:\n      DB_PASSWORD: other-secret\n";
    const r = run(raw);
    const d = doc(r);
    expect(d.services.db.environment).toEqual(["DB_PASSWORD=${DB_PASSWORD}", "REGION=eu"]);
    expect(d.services.api.environment).toEqual({ DB_PASSWORD: "${API_DB_PASSWORD}" });
    expect(r.env.DB_PASSWORD).toBe("hunter2");
    expect(r.env.API_DB_PASSWORD).toBe("other-secret");
    expect(r.compose).not.toContain("hunter2");
    expect(JSON.stringify(r.dropped)).not.toContain("hunter2");
  });

  it("R5/R7: container_name and published ports are stripped and reported, expose stays", () => {
    const r = run("services:\n  a:\n    image: x:1\n    container_name: db\n    ports:\n      - '8080:80'\n    expose:\n      - '80'\n");
    const a = doc(r).services.a;
    expect(a.container_name).toBeUndefined();
    expect(a.ports).toBeUndefined();
    expect(a.expose).toEqual(["80"]);
    expect(r.dropped.map((d) => d.field)).toEqual(["a.container_name", "a.ports"]);
  });

  it("R6: coolify.* and traefik.* labels are stripped (reported), tugra.* / com.docker.* are left so the gate fails closed", () => {
    const ok = run("services:\n  a:\n    image: x:1\n    labels:\n      - coolify.managed=true\n      - traefik.enable=true\n      - traefik.http.middlewares.x.basicauth.users=u\n      - keep.me=1\n");
    expect(doc(ok).services.a.labels).toEqual(["keep.me=1"]);
    expect(ok.dropped.map((d) => d.field)).toEqual(expect.arrayContaining(["a.labels.coolify", "a.labels.traefik", "a.labels.access-control"]));
    const bad = run("services:\n  a:\n    image: x:1\n    labels:\n      tugra.role: x\n");
    expect(bad.gate).toMatchObject({ code: "compose-safety" });
    expect(bad.verdict).toBe("skipped");
    const bad2 = run("services:\n  a:\n    image: x:1\n    labels:\n      - com.docker.compose.project=evil\n");
    expect(bad2.gate).toMatchObject({ code: "compose-safety" });
    const interp = run("services:\n  a:\n    image: x:1\n    labels:\n      '${P:-traefik.}x': '1'\n");
    expect(interp.gate).toMatchObject({ code: "compose-safety" });
  });

  it("R8: missing top-level volumes are declared (short and long syntax); a bad key is a blocker", () => {
    const r = run("services:\n  a:\n    image: x:1\n    volumes:\n      - 'data_one:/a:ro'\n      - type: volume\n        source: two\n        target: /b\n      - /var/lib/anon\n");
    expect(doc(r).volumes).toEqual({ data_one: {}, two: {} });
    expect(r.volumes.map((v) => v.key)).toEqual(["data_one", "two"]);
    expect(doc(r).services.a.volumes).toContain("data_one:/a:ro");
    expect(run("services:\n  a:\n    image: x:1\n    volumes:\n      - 'Bad.Name:/a'\n").gate).toMatchObject({ code: "volume-name" });
  });

  it("R8: host binds get collision-free, length-limited names; the same source path is shared", () => {
    const raw = "services:\n  minio:\n    image: x:1\n    volumes:\n      - '/mnt/disk-one:/data'\n      - '/mnt/disk-two:/data'\n      - '/mnt/disk-one:/backup'\n  other:\n    image: y:1\n    volumes:\n      - '/srv2/a:/very/long/path/with/a/superlong-directory-name-that-keeps-going-and-going'\n";
    const r = run(raw);
    const d = doc(r);
    expect(d.services.minio.volumes).toEqual(["minio-data:/data", "minio-data-2:/data", "minio-data:/backup"]);
    const keys = r.volumes.map((v) => v.key);
    expect(keys).toEqual([...new Set(keys)]);
    expect(keys.every((k) => /^[a-z0-9][a-z0-9_-]{0,40}$/.test(k))).toBe(true);
    expect(r.volumes.find((v) => v.key === "minio-data")!.mounts).toHaveLength(2);
  });

  it("R8: a sensitive host path and docker.sock are never rewritten; the gate (or the member drop) handles them", () => {
    const r = run("services:\n  a:\n    image: x:1\n    volumes:\n      - '/etc/passwd:/p'\n");
    expect(r.gate).toMatchObject({ code: "compose-safety" });
    const sock = run("services:\n  a:\n    image: x:1\n  b:\n    image: y:1\n    volumes:\n      - '/var/run/docker.sock:/var/run/docker.sock'\n");
    expect(sock.membersDropped).toEqual([{ name: "b", reason: expect.any(String) }]);
    expect(sock.compose).not.toContain("docker.sock");
  });

  it("R8: relative binds become config mounts, are refused when hostile, and unavailable files are listed", () => {
    const raw = "services:\n  a:\n    image: x:1\n    volumes:\n      - './conf/a.xml:/etc/a.xml:ro'\n      - type: bind\n        source: ./b.yml\n        target: /etc/b.yml\n";
    const noFiles = run(raw);
    expect(noFiles.neededFiles).toEqual(["b.yml", "conf/a.xml"]);
    expect(doc(noFiles).services.a.volumes).toBeUndefined();
    const withFiles = run(raw, { bundle: { values: {}, files: [{ path: "conf/a.xml", content: "A" }, { path: "b.yml", content: "B" }, { path: "ghost.yml", content: "NOT DECLARED" }] } });
    expect(withFiles.configMounts).toEqual([
      { serviceName: "a", target: "/etc/a.xml", content: "A" },
      { serviceName: "a", target: "/etc/b.yml", content: "B" },
    ]);
    expect(JSON.stringify(withFiles.configMounts)).not.toContain("NOT DECLARED");
    for (const src of ["../x:/t", "./../x:/t", "./.env:/t", "./mounts/x:/t", "./docker-compose.yml:/t"]) {
      expect(run(`services:\n  a:\n    image: x:1\n    volumes:\n      - '${src}'\n`).gate).toMatchObject({ code: "bind-path" });
    }
    expect(run("services:\n  a:\n    image: x:1\n    volumes:\n      - './f:relative/target'\n").gate).toMatchObject({ code: "mount-target" });
  });

  it("R8: a config file that looks like it holds a secret is flagged by name only", () => {
    const r = run("services:\n  a:\n    image: x:1\n    volumes:\n      - './c.yml:/etc/c.yml'\n", { bundle: { values: {}, files: [{ path: "c.yml", content: `password: ${SECRET}\n` }] } });
    expect(r.dropped.some((d) => d.field === "configMount:/etc/c.yml" && d.level === "warn")).toBe(true);
    expect(JSON.stringify(r.dropped)).not.toContain(SECRET);
  });

  it("R9: a dropped member removes its depends_on, its volumes; a required one refuses; dropMembers only widens", () => {
    const base = "services:\n  app:\n    image: a:1\n    depends_on:\n      - agent\n      - db\n  db:\n    image: d:1\n    volumes:\n      - 'dbdata:/d'\n  agent:\n    image: g:1\n    privileged: true\n    volumes:\n      - 'agentdata:/g'\n";
    const r = run(base);
    expect(r.membersDropped.map((m) => m.name)).toEqual(["agent"]);
    expect(doc(r).services.app.depends_on).toEqual(["db"]);
    expect(Object.keys(doc(r).volumes ?? {})).toEqual(["dbdata"]);
    const required = run("services:\n  app:\n    image: a:1\n    depends_on:\n      agent:\n        condition: service_completed_successfully\n  agent:\n    image: g:1\n    devices:\n      - /dev/fuse\n");
    expect(required.gate).toMatchObject({ code: "member-required" });
    const widened = run(base, { choice: { dropMembers: ["db"] } });
    expect(widened.membersKept).toEqual(["app"]);
    const never = run("services:\n  a:\n    image: x:1\n    privileged: true\n", { choice: { dropMembers: [] } });
    expect(never.verdict).toBe("skipped");
    for (const bad of ["network_mode: host", "pid: host", "ipc: host", "cap_add: [SYS_ADMIN]", "security_opt: ['seccomp:unconfined']"]) {
      const x = run(`services:\n  a:\n    image: x:1\n  b:\n    image: y:1\n    ${bad}\n`);
      expect(x.membersDropped.map((m) => m.name)).toEqual(["b"]);
    }
  });

  it("R9: non-droppable gate failures (reserved container_name after... labels, networks) fail the whole service closed", () => {
    const r = run("services:\n  a:\n    image: x:1\n    networks: [n]\nnetworks:\n  n:\n    external: true\n    name: tugra-proxy\n");
    expect(r.gate).toMatchObject({ code: "compose-safety" });
    expect(r.verdict).toBe("skipped");
  });

  it("R11: hostile keys never reach the app env or a prototype", () => {
    const r = run("services:\n  a:\n    image: x:1\n    environment:\n      - '__proto__=x'\n      - 'A=${__proto__}'\n", { bundle: { values: { __proto__: "v" } as Record<string, string> } });
    expect(Object.getPrototypeOf(r.env)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("operator service domains replace the source rows; hostnameMap renames them; dropped members lose theirs", () => {
    const svc = svcOf({
      members: [
        { name: "web", kind: "app", ref: "m1", domains: [{ host: "old.example.test", port: 80, serviceRef: "web" }] },
        { name: "agent", kind: "app", ref: "m2", domains: [{ host: "agent.example.test", port: 81, serviceRef: "agent" }] },
      ],
    });
    const raw = "services:\n  web:\n    image: a:1\n  agent:\n    image: g:1\n    privileged: true\n";
    expect(transformServiceCompose({ svc, raw }).domains).toEqual([{ service: "web", hostname: "old.example.test", port: 80 }]);
    expect(transformServiceCompose({ svc, raw, choice: { hostnameMap: { "old.example.test": "new.example.test" } } }).domains).toEqual([{ service: "web", hostname: "new.example.test", port: 80 }]);
    expect(transformServiceCompose({ svc, raw, choice: { serviceDomains: [{ service: "web", hostname: "mine.example.test", port: 9 }, { service: "agent", hostname: "x.example.test", port: 1 }] } }).domains).toEqual([{ service: "web", hostname: "mine.example.test", port: 9 }]);
  });

  it("tokenizeVars handles $$, braces, defaults and nesting", () => {
    expect(tokenizeVars("a $$b ${C:-${D}} $E").filter((t) => t.t === "ref").map((t) => t.name)).toEqual(["C", "E"]);
    expect(tokenizeVars("$$${X}").filter((t) => t.t === "ref").map((t) => t.name)).toEqual(["X"]);
    expect(tokenizeVars("cost $5 and ${bad name}").filter((t) => t.t === "ref")).toHaveLength(0);
  });
});
