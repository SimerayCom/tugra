import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CAMPAIGN_STATUSES, CLEANUP_STATUSES, MOVE_OFF_SERVER_STAGES, MOVE_OFF_STEPS, TAKEOVER_STATUSES } from "@tugra/shared";
import en from "./locales/en";
import { GUIDE_IDS } from "../lib/help-links";

const lookup = (dotted: string): unknown => dotted.split(".").reduce<unknown>((n, k) => (n && typeof n === "object" ? (n as Record<string, unknown>)[k] : undefined), en);
const SRC = path.resolve(__dirname, "..");
const FILES = [
  "components/coolify-host-card.tsx",
  "components/coolify-move-checklist.tsx",
  "components/coolify-secrets-consent.tsx",
  "components/campaign-report-list.tsx",
  "app/(app)/import/move-off-coolify/page.tsx",
  "app/(app)/import/page.tsx",
  "app/(app)/import/inplace/page.tsx",
  "components/coolify-inplace/takeover-panel.tsx",
  "components/project-move-panel.tsx",
  "lib/coolify-move.ts",
];

describe("move off Coolify i18n coverage", () => {
  it("every literal key the screens use exists in the English files", () => {
    const used = new Set<string>();
    for (const f of FILES) for (const m of readFileSync(path.join(SRC, f), "utf8").matchAll(/["'`]((?:coolifyMove|coolifyInPlace|projectMove)\.[A-Za-z0-9_.]+)["'`]/g)) used.add(m[1]);
    expect(used.size).toBeGreaterThan(25);
    expect([...used].filter((k) => typeof lookup(k) !== "string")).toEqual([]);
  });

  it("covers every value behind the dynamic keys", () => {
    const missing = (prefix: string, list: readonly string[]) => list.filter((n) => typeof lookup(`${prefix}.${n}`) !== "string");
    expect(missing("coolifyMove.stage", MOVE_OFF_SERVER_STAGES)).toEqual([]);
    for (const s of MOVE_OFF_STEPS) {
      expect(typeof lookup(`coolifyMove.step.${s}.title`)).toBe("string");
      expect(typeof lookup(`coolifyMove.step.${s}.desc`)).toBe("string");
    }
    expect(missing("coolifyMove.line.secrets", ["none", "expired", "revoked"])).toEqual([]);
    expect(missing("coolifyMove.rowAction", ["agent", "takeoverStart", "takeoverOpen", "cleanup", "done"])).toEqual([]);
    expect(missing("coolifyMove.consent.error", ["generic", "forbidden", "name", "agent_offline", "agent_too_old", "grant_active"])).toEqual([]);
    expect(missing("coolifyInPlace.status", TAKEOVER_STATUSES)).toEqual([]);
    expect(missing("coolifyCleanup.status", CLEANUP_STATUSES)).toEqual([]);
    expect(missing("placement.campaign.status", CAMPAIGN_STATUSES)).toEqual([]);
  });

  it("every guide id has its label, and the move-off guide is one of them", () => {
    expect(GUIDE_IDS).toContain("move-off-coolify");
    expect(GUIDE_IDS.filter((id) => typeof lookup(`common.help.guide.${id}`) !== "string")).toEqual([]);
  });

  it("the new screens have no hardcoded English sentence in their markup", () => {
    for (const f of FILES.slice(0, 5)) {
      const src = readFileSync(path.join(SRC, f), "utf8");
      const jsxText = [...src.matchAll(/>([^<>{}\n]*[A-Za-z]{3,}\s+[A-Za-z]{3,}\s+[A-Za-z]{3,}[^<>{}\n]*)</g)].map((m) => m[1].trim());
      expect(jsxText, f).toEqual([]);
    }
  });

  it("the consent screen says what is never read", () => {
    expect(String(lookup("coolifySecrets.consent.neverRead"))).toMatch(/encryption key/i);
  });
});
