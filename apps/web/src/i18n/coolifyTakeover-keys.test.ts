import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import coolify from "./locales/en/coolifyTakeover.json";

const lookup = (tree: unknown, dotted: string): unknown =>
  dotted.split(".").reduce<unknown>((n, k) => (n && typeof n === "object" ? (n as Record<string, unknown>)[k] : undefined), tree);
const SRC = path.resolve(__dirname, "..");
const FILES = [
  "components/coolify-takeover.tsx",
  "components/coolify-inventory-view.tsx",
  "components/coolify-servers-checklist.tsx",
  "app/(app)/import/coolify-host/page.tsx",
  "app/(app)/import/page.tsx",
];

describe("coolifyTakeover i18n coverage", () => {
  it("every literal coolifyTakeover.* key the screens use exists", () => {
    const used = new Set<string>();
    for (const f of FILES) for (const m of readFileSync(path.join(SRC, f), "utf8").matchAll(/["'`](coolifyTakeover\.[A-Za-z0-9_.]+)["'`]/g)) used.add(m[1]);
    expect(used.size).toBeGreaterThan(40);
    const missing = [...used].filter((k) => typeof lookup(coolify, k.replace(/^coolifyTakeover\./, "")) !== "string");
    expect(missing).toEqual([]);
  });

  it("covers every value behind the dynamic keys", () => {
    const names = (prefix: string, list: string[]) => list.filter((n) => typeof lookup(coolify, `${prefix}.${n}`) !== "string");
    expect(names("checklist.state", ["this_server", "already_added", "waiting", "expired", "no_access", "not_generated", "ambiguous"])).toEqual([]);
    expect(names("team.channel", ["email", "discord", "telegram", "slack", "pushover", "webhook"])).toEqual([]);
    expect(names("variable", ["team", "project", "environment"])).toEqual([]);
    expect(names("item", ["application", "database", "service"])).toEqual([]);
    // Every code the hub can answer with has a line.
    expect(names("error", ["no_coolify", "no_docker", "db_stopped", "not_read_only", "unreadable", "forbidden", "offline", "generic"])).toEqual([]);
  });

  it("the screens have no hardcoded English sentence in their markup", () => {
    for (const f of FILES.slice(0, 4)) {
      const src = readFileSync(path.join(SRC, f), "utf8");
      const jsxText = [...src.matchAll(/>([^<>{}\n]*[A-Za-z]{3,}\s+[A-Za-z]{3,}\s+[A-Za-z]{3,}[^<>{}\n]*)</g)].map((m) => m[1].trim());
      expect(jsxText).toEqual([]);
    }
  });
});
