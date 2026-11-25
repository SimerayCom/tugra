import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { COOLIFY_SECRET_CLASSES, HOST_EVIDENCE_KINDS } from "@tugra/shared";
import en from "./locales/en";
import { translate } from "./translate";

const SRC = path.resolve(__dirname, "..");
const FILES = ["components/import/agent-connect.tsx", "components/import/agent-consent.tsx", "components/import/agent-match-step.tsx", "components/import-wizard.tsx"];
const NAMESPACES = ["coolifyAgent", "coolifySecrets", "hostMatch"];
const text = (key: string): unknown => translate(en as Record<string, unknown>, key);

describe("the agent path of the import wizard: i18n", () => {
  it("every literal key the screens use exists (no raw key can reach the user)", () => {
    const used = new Set<string>();
    for (const f of FILES) {
      const src = readFileSync(path.join(SRC, f), "utf8");
      for (const m of src.matchAll(new RegExp(`["'\`]((?:${NAMESPACES.join("|")})\\.[A-Za-z0-9_.]+)["'\`]`, "g"))) used.add(m[1]);
    }
    expect(used.size).toBeGreaterThan(30);
    expect([...used].filter((k) => text(k) === k)).toEqual([]);
  });

  it("has a line for every value behind a dynamic key", () => {
    const missing = (prefix: string, names: readonly string[]) => names.filter((n) => text(`${prefix}.${n}`) === `${prefix}.${n}`);
    expect(missing("coolifySecrets.class", COOLIFY_SECRET_CLASSES)).toEqual([]);
    expect(missing("hostMatch.evidence", HOST_EVIDENCE_KINDS)).toEqual([]);
    expect(missing("hostMatch.differs", HOST_EVIDENCE_KINDS)).toEqual([]);
    expect(missing("hostMatch.strength", ["identity", "address", "weak"])).toEqual([]);
    expect(missing("hostMatch.status", ["certain", "probable", "ambiguous", "none"])).toEqual([]);
    expect(missing("coolifyAgent.counts", ["teams", "projects", "servers", "applications", "databases", "services"])).toEqual([]);
    // every code the hub answers with on these screens
    expect(missing("coolifyAgent.error", ["not_enabled", "no_coolify", "no_docker", "db_stopped", "not_read_only", "unreadable", "agent_offline", "agent_unavailable", "agent_read_failed", "forbidden", "generic"])).toEqual([]);
    expect(missing("coolifySecrets.error", ["agent_offline", "agent_too_old", "grant_active", "forbidden", "name_mismatch", "expired", "generic"])).toEqual([]);
    expect(missing("hostMatch.error", ["identity_conflict", "local_row", "forbidden", "expired", "generic"])).toEqual([]);
  });

  it("the screens carry no hardcoded English sentence in their markup", () => {
    for (const f of FILES.slice(0, 3)) {
      const src = readFileSync(path.join(SRC, f), "utf8");
      const jsxText = [...src.matchAll(/>([^<>{}\n]*[A-Za-z]{3,}\s+[A-Za-z]{3,}\s+[A-Za-z]{3,}[^<>{}\n]*)</g)].map((m) => m[1].trim());
      expect(jsxText).toEqual([]);
    }
  });

  it("never claims plain text travels, and says what is never read", () => {
    expect(String(text("coolifySecrets.subtitle"))).toMatch(/sealed/i);
    expect(String(text("coolifySecrets.consent.summary"))).toMatch(/never travels/i);
    expect(String(text("coolifySecrets.consent.neverRead"))).toMatch(/SSH private keys/);
  });
});
