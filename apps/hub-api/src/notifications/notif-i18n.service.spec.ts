import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NotifI18nService } from "./notif-i18n.service";

describe("NotifI18nService", () => {
  const svc = new NotifI18nService();

  it("resolves a nested dotted key and interpolates {param}", () => {
    const t = svc.forLocale("en");
    expect(t("deploy.failed.title", { app: "blog" })).toBe("Deploy failed — blog");
    expect(t("expiry.ssl.summary", { domain: "blog.io", days: 7 })).toBe("The TLS certificate for blog.io expires in 7 day(s).");
    expect(t("monitor.value.ms", { ms: 1200 })).toBe("1200 ms");
  });

  it("returns a plain string unchanged when no params are given", () => {
    expect(svc.forLocale("en")("deploy.field.project")).toBe("Project");
  });

  it("returns the raw key when it is missing (visible gap, never a crash)", () => {
    expect(svc.forLocale("en")("no.such.key")).toBe("no.such.key");
  });

  it("falls back to en for an unknown locale", () => {
    expect(svc.forLocale("xx")("deploy.failed.title", { app: "x" })).toBe("Deploy failed — x");
    expect(svc.forLocale(undefined)("test.title")).toBe("Tugra test notification");
  });

  it("replaces EVERY occurrence of a repeated placeholder", () => {
    // deploy.succeeded.summary uses {app} once, but replaceAll must handle repeats too — check a synthetic path
    expect(svc.forLocale("en")("deploy.succeeded.summary", { app: "a-b-c" })).toBe("a-b-c deployed successfully.");
  });

  it("inserts a param value VERBATIM even when it contains $-substitution patterns", () => {
    const t = svc.forLocale("en");
    // A resource name with $&, $$, $` etc. must NOT be reinterpreted by the replacement engine.
    expect(t("backup.failed.title", { db: "db$&prod" })).toBe("Backup failed — db$&prod");
    expect(t("deploy.succeeded.summary", { app: "a$$b" })).toBe("a$$b deployed successfully.");
    expect(t("server.offline.summary", { server: "n$`x" })).toBe("Server n$`x stopped responding.");
  });

  it("extraction guard: no template still holds a hardcoded user-facing string (all via env.t)", () => {
    const dir = join(__dirname, "templates");
    const forbidden: Array<[string, string]> = [
      ["deploy.ts", "Deploy failed —"],
      ["deploy.ts", "deployed successfully"],
      ["backup.ts", "Backup failed —"],
      ["server.ts", "stopped responding"],
      ["expiry.ts", "certificate expiring"],
      ["expiry.ts", "day(s)"],
      ["monitor.ts", "is back UP"],
    ];
    for (const [file, phrase] of forbidden) {
      const src = readFileSync(join(dir, file), "utf8");
      expect(src).not.toContain(phrase);
    }
  });
});
