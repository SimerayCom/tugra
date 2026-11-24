import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import en from "./locales/en";
import { translate } from "./translate";

const SRC = path.resolve(__dirname, "..");
const FILES = [
  "app/(public)/status/[slug]/page.tsx",
  "app/(public)/status/[slug]/email/page.tsx",
  "app/(app)/monitors/status/page.tsx",
  "app/(app)/portal/page.tsx",
  "app/(app)/teams/[id]/page.tsx",
  "lib/status-page.ts",
];

describe("status page + customer portal i18n", () => {
  it("every literal statusPage.*, portal.* and new teams.* / nav.* key exists in en", () => {
    const used = new Set<string>();
    for (const f of FILES) {
      for (const m of readFileSync(path.join(SRC, f), "utf8").matchAll(/["'`]((?:statusPage|portal|teams|nav)\.[A-Za-z0-9_.]+)["'`]/g)) used.add(m[1]);
    }
    expect(used.size).toBeGreaterThan(40);
    const missing = [...used].filter((k) => translate(en as never, k) === k);
    expect(missing).toEqual([]);
  });

  it("covers every value the hub can send for the dynamic keys", () => {
    const has = (k: string) => translate(en as never, k) !== k;
    for (const o of ["operational", "partial", "outage", "maintenance", "unknown"]) expect(has(`statusPage.overall.${o}`), o).toBe(true);
    for (const s of ["up", "down", "checking", "paused"]) expect(has(`statusPage.state.${s}`), s).toBe(true);
    for (const k of ["maintScheduled", "maintActive", "maintCompleted"]) expect(has(`statusPage.${k}`), k).toBe(true);
  });

  it("the new screens have no hardcoded English sentence in their markup", () => {
    for (const f of FILES.filter((x) => x.endsWith("page.tsx") && !x.includes("teams"))) {
      const src = readFileSync(path.join(SRC, f), "utf8");
      const jsxText = [...src.matchAll(/>([^<>{}\n]*[A-Za-z]{3,}\s+[A-Za-z]{3,}\s+[A-Za-z]{3,}[^<>{}\n]*)</g)].map((m) => m[1].trim());
      expect(jsxText, f).toEqual([]);
    }
  });
});
