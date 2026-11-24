import { spawnSync } from "node:child_process";
import {
  assertSafeImage,
  buildDetectScript,
  buildDumpScript,
  DEFAULT_SQLITE_IMAGE,
  KumaDumpError,
  parseDetect,
  parseDump,
} from "./kuma-sqlite";

const syntaxOk = (script: string) => spawnSync("sh", ["-n"], { input: script, encoding: "utf8" });

describe("detect script", () => {
  it("is valid shell and only inspects (no run/exec)", () => {
    const s = buildDetectScript();
    expect(syntaxOk(s).status).toBe(0);
    expect(s).not.toMatch(/docker (run|exec|rm|stop|start|kill)/);
  });

  it("lists Kuma containers and their data mount", () => {
    const out = [
      "some noise",
      "TUGRA_KUMA|/uptime-kuma|louislam/uptime-kuma:1|running|yes",
      "TUGRA_KUMA|/old-kuma|louislam/uptime-kuma:2|exited|",
      "TUGRA_KUMA|/bad name;rm|louislam/uptime-kuma:1|running|yes",
    ].join("\n");
    expect(parseDetect(out)).toEqual({
      noDocker: false,
      found: [
        { container: "uptime-kuma", image: "louislam/uptime-kuma:1", state: "running", hasData: true },
        { container: "old-kuma", image: "louislam/uptime-kuma:2", state: "exited", hasData: false },
      ],
    });
  });

  it("reports a host without docker", () => {
    expect(parseDetect("TUGRA_NO_DOCKER")).toEqual({ noDocker: true, found: [] });
  });
});

describe("dump script", () => {
  const script = buildDumpScript("uptime-kuma", DEFAULT_SQLITE_IMAGE);

  it("is valid shell", () => {
    const r = syntaxOk(script);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("mounts the data read-only into a locked-down, network-less one-shot container", () => {
    expect(script).toContain('-v "$src:/data:ro"');
    expect(script).toContain("--network none");
    expect(script).toContain("--read-only");
    expect(script).toContain("--cap-drop ALL");
    expect(script).toContain("--security-opt no-new-privileges");
    expect(script).toContain("docker run --rm");
    expect(script).toContain(DEFAULT_SQLITE_IMAGE);
    // it only ever reads: no write verbs against the Kuma container or its volume
    expect(script).not.toMatch(/docker (exec|stop|start|restart|kill|rm )/);
    expect(script).not.toMatch(/\b(INSERT INTO|UPDATE \w+ SET|DELETE FROM|DROP TABLE|ALTER TABLE)\b/i);
  });

  it("re-checks the container is Kuma before mounting anything", () => {
    expect(script.indexOf("*uptime-kuma*")).toBeGreaterThan(-1);
    expect(script.indexOf("*uptime-kuma*")).toBeLessThan(script.indexOf("docker run"));
  });

  it("rejects a container reference that could carry shell syntax or a flag", () => {
    for (const bad of ["a;b", "$(x)", "-v", "a b", "a`b`", ""]) {
      expect(() => buildDumpScript(bad, DEFAULT_SQLITE_IMAGE)).toThrow();
    }
  });

  it("rejects an image reference that could carry shell syntax", () => {
    for (const bad of ["x; rm -rf /", "a b", "$(id)", "-it", "A/B"]) expect(() => assertSafeImage(bad)).toThrow();
    expect(assertSafeImage("registry.example.com/tools/sqlite3:3.46")).toBe("registry.example.com/tools/sqlite3:3.46");
  });
});

const sample = (extra = "") =>
  [
    "Unable to find image 'keinos/sqlite3:latest' locally",
    "latest: Pulling from keinos/sqlite3",
    "TUGRA_KUMA_BEGIN monitor",
    '[{"id":1,"name":"Site","type":"http","url":"https://example.com","interval":60,"active":1},',
    '{"id":2,"name":"Db","type":"port","hostname":"db.example.com","port":5432,"interval":30,"active":1}]',
    "TUGRA_KUMA_END monitor",
    "TUGRA_KUMA_BEGIN notification",
    '[{"id":7,"name":"Alerts","config":"{\\"type\\":\\"telegram\\",\\"telegramBotToken\\":\\"t\\",\\"telegramChatID\\":\\"1\\"}","active":1}]',
    "TUGRA_KUMA_END notification",
    "TUGRA_KUMA_BEGIN link",
    '[{"id":1,"monitor_id":1,"notification_id":7}]',
    "TUGRA_KUMA_END link",
    extra,
  ].join("\n");

describe("parseDump", () => {
  it("reads the three tables out of noisy output and joins the links", () => {
    const d = parseDump(sample());
    expect(d.monitors.map((m) => [m.id, m.type, m.notificationIds])).toEqual([
      ["1", "http", ["7"]],
      ["2", "port", []],
    ]);
    expect(d.notifications[0]).toMatchObject({ id: "7", name: "Alerts" });
    expect(d.notifications[0].config.type).toBe("telegram");
  });

  it("treats an empty link / notification table as none", () => {
    const out = sample().replace(/TUGRA_KUMA_BEGIN link[\s\S]*TUGRA_KUMA_END link/, "TUGRA_KUMA_BEGIN link\nTUGRA_KUMA_END link");
    expect(parseDump(out).monitors[0].notificationIds).toEqual([]);
  });

  it.each([
    ["TUGRA_NO_DOCKER", "no_docker"],
    ["TUGRA_KUMA_GONE", "gone"],
    ["TUGRA_KUMA_NOT_KUMA", "not_kuma"],
    ["TUGRA_KUMA_NO_DATA", "no_data"],
    ["TUGRA_KUMA_NO_DB", "no_sqlite"],
    ["TUGRA_KUMA_COPY_FAILED", "copy_failed"],
    ["garbage", "sql_error"],
  ])("maps %s to %s", (out, failure) => {
    expect(() => parseDump(out)).toThrow(KumaDumpError);
    try {
      parseDump(out);
    } catch (e) {
      expect((e as KumaDumpError).failure).toBe(failure);
    }
  });

  it("reports an sql error inside the monitor section", () => {
    expect(() => parseDump("TUGRA_KUMA_BEGIN monitor\nTUGRA_KUMA_SQL_ERROR\nTUGRA_KUMA_END monitor")).toThrow(KumaDumpError);
  });
});
