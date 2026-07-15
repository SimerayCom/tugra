import { renderEvent, type NotificationEvent, type RenderEnv } from "./event";
import type { RenderedMessage } from "./rendered-message";
import { NotifI18nService } from "./notif-i18n.service";

// A real en translator — the en.json values equal the old hardcoded strings, so every assertion below
// (e.g. "Deploy failed — blog") holds unchanged while the strings now flow through i18n.
const env: RenderEnv = { webBaseUrl: "https://web.test", t: new NotifI18nService().forLocale("en") };
const render = (type: string, ctx: Record<string, unknown> = {}): RenderedMessage =>
  renderEvent({ type, teamId: "t1", ctx }, env);
const fieldVal = (m: RenderedMessage, label: string): string | undefined =>
  m.fields.find((f) => f.label === label)?.value;
const linkUrl = (m: RenderedMessage, label: string): string | undefined =>
  m.links.find((l) => l.label === label)?.url;

describe("renderEvent — typed per-event templates", () => {
  it("deploy_success: success level, no error field, both links", () => {
    const m = render("deploy_success", {
      appId: "app1", appName: "blog", url: "https://blog.example", projectName: "web",
      environmentName: "prod", durationMs: 42_000,
    });
    expect(m.level).toBe("success");
    expect(m.title).toBe("Deploy succeeded — blog");
    expect(m.summary).toBe("blog deployed successfully.");
    expect(m.critical).toBe(false);
    expect(m.event).toBe("deploy_success");
    expect(fieldVal(m, "Project")).toBe("web");
    expect(fieldVal(m, "Environment")).toBe("prod");
    expect(fieldVal(m, "Duration")).toBe("42s");
    expect(fieldVal(m, "Error")).toBeUndefined();
    expect(fieldVal(m, "Log")).toBeUndefined(); // empty logTail dropped
    expect(linkUrl(m, "Open app")).toBe("https://blog.example");
    expect(linkUrl(m, "View in Tugra")).toBe("https://web.test/apps/app1");
  });

  it("deploy_rolled_back: warning + not critical", () => {
    const m = render("deploy_rolled_back", { appName: "blog", appId: "app1" });
    expect(m.level).toBe("warning");
    expect(m.title).toBe("Deploy rolled back — blog");
    expect(m.critical).toBe(false);
  });

  it("deploy_failed: failure + critical", () => {
    const m = render("deploy_failed", { appName: "blog", appId: "app1" });
    expect(m.level).toBe("failure");
    expect(m.title).toBe("Deploy failed — blog");
    expect(m.summary).toBe("Deploy of blog failed.");
    expect(m.critical).toBe(true);
  });

  it("deploy notifications NEVER leak the raw deploy log (secrets stay in-app)", () => {
    // Regression guard: even if a firing site passes a logTail, no template field carries it.
    const secret = "DATABASE_URL=postgres://u:S3cret@db/app";
    for (const type of ["deploy_failed", "deploy_rolled_back", "deploy_success"]) {
      const m = render(type, { appName: "blog", appId: "app1", logTail: secret });
      expect(JSON.stringify(m)).not.toContain("S3cret");
      expect(fieldVal(m, "Error")).toBeUndefined();
      expect(fieldVal(m, "Log")).toBeUndefined();
    }
  });

  it("deploy: 3m 20s duration formatting; Duration dropped when 0", () => {
    expect(fieldVal(render("deploy_success", { appName: "a", durationMs: 200_000 }), "Duration")).toBe("3m 20s");
    expect(fieldVal(render("deploy_success", { appName: "a" }), "Duration")).toBeUndefined();
  });

  it("backup_failed: failure + critical, engine+version, S3 bucket, db link", () => {
    const m = render("backup_failed", {
      dbId: "db1", dbName: "shop", engine: "postgres", version: "16", destType: "S3",
      bucket: "my-bucket", errorTail: "pg_dump: connection refused",
    });
    expect(m.level).toBe("failure");
    expect(m.title).toBe("Backup failed — shop");
    expect(m.critical).toBe(true);
    expect(fieldVal(m, "Engine")).toBe("postgres 16");
    expect(fieldVal(m, "Destination")).toBe("S3");
    expect(fieldVal(m, "Bucket")).toBe("my-bucket");
    expect(fieldVal(m, "Error")).toBe("pg_dump: connection refused");
    expect(linkUrl(m, "Open database")).toBe("https://web.test/databases/db1");
  });

  it("backup_failed: LOCAL destination drops the bucket field", () => {
    const m = render("backup_failed", { dbName: "shop", destType: "LOCAL", bucket: "" });
    expect(fieldVal(m, "Destination")).toBe("LOCAL");
    expect(fieldVal(m, "Bucket")).toBeUndefined();
  });

  it("backup_restore_failed: failure + critical, exit code shown incl. 0", () => {
    const m = render("backup_restore_failed", { dbId: "db1", dbName: "shop", engine: "mysql", exitCode: 2, errorTail: "boom" });
    expect(m.level).toBe("failure");
    expect(m.title).toBe("Restore failed — shop");
    expect(m.critical).toBe(true);
    expect(fieldVal(m, "Exit code")).toBe("2");
    expect(render("backup_restore_failed", { dbName: "x", exitCode: 0 }).fields.find((f) => f.label === "Exit code")?.value).toBe("0");
  });

  it("ssl_expiring: warning, days + formatted expiry, app link", () => {
    const m = render("ssl_expiring", {
      appId: "app1", appName: "blog", domain: "blog.io", days: 7,
      validTo: "2026-08-01T10:30:00.000Z", issuer: "Let's Encrypt",
    });
    expect(m.level).toBe("warning");
    expect(m.title).toBe("SSL certificate expiring — blog.io");
    expect(m.summary).toBe("The TLS certificate for blog.io expires in 7 day(s).");
    expect(m.critical).toBeFalsy();
    expect(fieldVal(m, "Expires in")).toBe("7 day(s)");
    expect(fieldVal(m, "Expiry")).toBe("2026-08-01 10:30 UTC");
    expect(fieldVal(m, "Issuer")).toBe("Let's Encrypt");
    expect(linkUrl(m, "Open app")).toBe("https://web.test/apps/app1");
  });

  it("token_expiring: warning, token name, settings link", () => {
    const m = render("token_expiring", { tokenName: "ci", days: 3, expiresAt: "2026-07-18T00:00:00.000Z" });
    expect(m.level).toBe("warning");
    expect(m.title).toBe("API token expiring — ci");
    expect(m.summary).toBe('API token "ci" expires in 3 day(s).');
    expect(fieldVal(m, "Token")).toBe("ci");
    expect(linkUrl(m, "Manage tokens")).toBe("https://web.test/settings");
  });

  it("server_offline: failure + critical, server link", () => {
    const m = render("server_offline", {
      serverId: "srv1", serverName: "node-1", hostname: "10.0.0.5",
      lastSeenAt: "2026-07-15T08:00:00.000Z", publicIp: "1.2.3.4",
    });
    expect(m.level).toBe("failure");
    expect(m.title).toBe("Server offline — node-1");
    expect(m.critical).toBe(true);
    expect(fieldVal(m, "Hostname")).toBe("10.0.0.5");
    expect(fieldVal(m, "Last seen")).toBe("2026-07-15 08:00 UTC");
    expect(linkUrl(m, "Open server")).toBe("https://web.test/servers/srv1");
  });

  it("monitor_down: failure + critical, target/response, monitor link", () => {
    const m = render("monitor_down", {
      monitorId: "mon1", monitorName: "api", target: "https://api.io/health",
      monitorType: "HTTP", resultMsg: "503 Service Unavailable", responseMs: 1200,
    });
    expect(m.level).toBe("failure");
    expect(m.title).toBe("Monitor down — api");
    expect(m.summary).toBe("api (https://api.io/health) is DOWN.");
    expect(m.critical).toBe(true);
    expect(fieldVal(m, "Target")).toBe("https://api.io/health");
    expect(fieldVal(m, "Response")).toBe("1200 ms");
    expect(fieldVal(m, "Detail")).toBe("503 Service Unavailable");
    expect(linkUrl(m, "View monitor")).toBe("https://web.test/monitors/mon1");
  });

  it("monitor_up: success, not critical, back UP summary", () => {
    const m = render("monitor_up", { monitorName: "api", target: "https://api.io", monitorType: "HTTP" });
    expect(m.level).toBe("success");
    expect(m.title).toBe("Monitor recovered — api");
    expect(m.summary).toBe("api (https://api.io) is back UP.");
    expect(m.critical).toBe(false);
    expect(fieldVal(m, "Response")).toBeUndefined(); // no responseMs → dropped
  });

  it("unknown event id → generic template (info fallback, title = event id)", () => {
    const m = render("totally_unknown", {});
    expect(m.event).toBe("totally_unknown");
    expect(m.level).toBe("info");
    expect(m.title).toBe("totally_unknown");
    expect(m.summary).toBe("totally_unknown");
    expect(m.fields).toEqual([]);
    expect(m.links).toEqual([]);
  });

  it("generic reads title/summary/level/fields/url from ctx", () => {
    const m = render("custom_thing", {
      title: "Custom", summary: "Something happened", level: "warning", critical: true,
      fields: [{ label: "Kind", value: "widget", inline: true }, { label: "empty", value: "" }],
      url: "https://x.io",
    });
    expect(m.title).toBe("Custom");
    expect(m.level).toBe("warning");
    expect(m.critical).toBe(true);
    expect(m.fields).toEqual([{ label: "Kind", value: "widget", inline: true }]); // empty value dropped
    expect(linkUrl(m, "Open")).toBe("https://x.io");
  });

  it("empty ctx never yields the string 'undefined' and drops empty fields", () => {
    for (const type of [
      "deploy_success", "deploy_failed", "deploy_rolled_back", "backup_failed",
      "backup_restore_failed", "ssl_expiring", "token_expiring", "server_offline",
      "monitor_up", "monitor_down",
    ]) {
      const m = render(type, {});
      const blob = JSON.stringify(m);
      expect(blob).not.toContain("undefined");
      for (const f of m.fields) expect(f.value).not.toBe("");
      expect(typeof m.timestamp).toBe("string");
      expect(m.event).toBe(type);
    }
  });

  it("clamps an over-long value to ≤1000 chars ending in an ellipsis", () => {
    const m = render("backup_failed", { dbName: "shop", errorTail: "x".repeat(5000) });
    const err = fieldVal(m, "Error")!;
    expect(err.length).toBeLessThanOrEqual(1000);
    expect(err.endsWith("…")).toBe(true);
  });

  it("critical matrix: exactly the outage events are critical", () => {
    const critical = new Set(["deploy_failed", "backup_failed", "backup_restore_failed", "server_offline", "monitor_down"]);
    const all = [
      "deploy_success", "deploy_failed", "deploy_rolled_back", "backup_failed", "backup_restore_failed",
      "ssl_expiring", "token_expiring", "server_offline", "monitor_up", "monitor_down",
    ];
    for (const type of all) {
      expect(!!render(type, {}).critical).toBe(critical.has(type));
    }
  });

  it("drops deep-links when the resource id is missing (no dangling /apps/)", () => {
    const m = render("deploy_success", { appName: "a" }); // no appId, no url
    expect(m.links).toEqual([]);
  });
});
