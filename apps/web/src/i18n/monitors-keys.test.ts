import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import monitors from "./locales/en/monitors.json";

const lookup = (tree: unknown, dotted: string): unknown =>
  dotted.split(".").reduce<unknown>((n, k) => (n && typeof n === "object" ? (n as Record<string, unknown>)[k] : undefined), tree);
const SRC = path.resolve(__dirname, "..");

describe("monitors i18n coverage (uptime + Uptime Kuma import)", () => {
  it("every literal monitors.* key used by the pages and the import flow exists", () => {
    const files = ["components/kuma-import.tsx", "app/(app)/monitors/page.tsx", "app/(app)/monitors/[id]/page.tsx", "app/(app)/monitors/import/page.tsx"];
    const used = new Set<string>();
    for (const f of files) for (const m of readFileSync(path.join(SRC, f), "utf8").matchAll(/["'`](monitors\.[A-Za-z0-9_.]+)["'`]/g)) used.add(m[1]);
    expect(used.size).toBeGreaterThan(30);
    const missing = [...used].filter((k) => typeof lookup(monitors, k.replace(/^monitors\./, "")) !== "string");
    expect(missing).toEqual([]);
  });

  it("covers every value the hub can send for the dynamic keys", () => {
    const expectKeys = (prefix: string, names: string[]) => {
      for (const n of names) expect(typeof lookup(monitors, `${prefix}.${n}`), `${prefix}.${n}`).toBe("string");
    };
    expectKeys("kuma.status", ["create", "exists", "unsupported", "group", "failed", "created", "reused", "skipped"]);
    expectKeys("kuma.reason", ["type", "target", "keyword", "dns_type", "group", "incomplete"]);
    expectKeys("kuma.warning", ["retry_interval", "cert_expiry", "auth_method", "headers_dropped", "webhook_format", "ntfy_auth"]);
    expectKeys("kuma.error", [
      "not_json", "not_kuma", "empty", "no_docker", "gone", "no_data", "no_sqlite", "copy_failed", "sql_error", "unreadable", "too_large", "pick_container", "not_found", "generic",
    ]);
    expectKeys("cf.reason", ["unknown_response", "origin_down", "connect_timeout", "unreachable", "timeout", "ssl_handshake", "ssl_invalid"]);
  });

  it("the import flow has no hardcoded English sentence in its markup", () => {
    for (const f of ["components/kuma-import.tsx", "app/(app)/monitors/import/page.tsx"]) {
      const src = readFileSync(path.join(SRC, f), "utf8");
      const jsxText = [...src.matchAll(/>([^<>{}\n]*[A-Za-z]{3,}\s+[A-Za-z]{3,}\s+[A-Za-z]{3,}[^<>{}\n]*)</g)].map((m) => m[1].trim());
      expect(jsxText, f).toEqual([]);
    }
  });
});
