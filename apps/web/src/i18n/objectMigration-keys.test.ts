import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import om from "./locales/en/objectMigration.json";
import { statusLabelKey, warningText } from "../lib/object-migration-labels";

const SRC = path.resolve(__dirname, "..");
const lookup = (tree: unknown, dotted: string): unknown =>
  dotted.split(".").reduce<unknown>((n, k) => (n && typeof n === "object" ? (n as Record<string, unknown>)[k] : undefined), tree);

const files = [
  ...readdirSync(path.join(SRC, "components/object-migration")).filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx")).map((f) => `components/object-migration/${f}`),
  "lib/object-migration-labels.ts",
  "app/(app)/migrations/objects/page.tsx",
  "app/(app)/migrations/objects/new/page.tsx",
  "app/(app)/migrations/objects/[id]/page.tsx",
  "components/import-wizard.tsx",
  "app/(app)/import/page.tsx",
];

describe("objectMigration i18n coverage", () => {
  it("every literal objectMigration.* key used in the UI exists in en/objectMigration.json", () => {
    const used = new Set<string>();
    for (const f of files) for (const m of readFileSync(path.join(SRC, f), "utf8").matchAll(/["'`](objectMigration\.[A-Za-z0-9_.-]+)["'`]/g)) used.add(m[1]);
    expect(used.size).toBeGreaterThan(45);
    expect([...used].filter((k) => typeof lookup(om, k.replace(/^objectMigration\./, "")) !== "string")).toEqual([]);
  });

  it("the spec'd keys, every status, every bucket status and every classified error code exist", () => {
    const spec = [
      "title", "new", "source.title", "source.endpoint", "source.accessKey", "source.secretKey", "source.readOnlyHint", "destination.title", "destination.endpoint", "destination.sameHostHint", "preserve",
      "buckets.title", "buckets.size", "buckets.objects", "buckets.select", "buckets.rename", "buckets.exclude", "buckets.nonePreselected", "buckets.destExists",
      "preflight.run", "preflight.srcUnreachable", "preflight.dstUnreachable", "preflight.noMc", "preflight.noSpace", "preflight.notCarried",
      "phase.seed", "phase.final", "phase.verify", "phase.cancel", "phase.resume", "freeze.title", "freeze.body", "freeze.removeExtraneous", "freeze.confirm",
      "verify.title", "verify.keysSizesOnly", "verify.missing", "verify.differ", "verify.extra", "verify.ok", "config.carry", "config.notCarried", "cutover.title", "cutover.steps.stop",
    ];
    for (const k of spec) expect(typeof lookup(om, k), k).toBe("string");
    for (const s of ["DRAFT", "PREFLIGHTED", "SEEDING", "SEEDED", "FINALIZING", "FINAL", "VERIFYING", "DONE", "FAILED"]) expect(typeof lookup(om, `status.${s}`), s).toBe("string");
    for (const s of ["PENDING", "QUEUED", "SEEDING", "SEEDED", "FINALIZING", "FINAL", "VERIFIED", "DIFFERS", "FAILED"]) expect(typeof lookup(om, `bucketStatus.${s}`), s).toBe("string");
    for (const c of ["access-denied", "no-such-bucket", "unreachable", "signature", "quota", "timeout", "run-failed", "mirror-failed", "mirror-errors", "helper-missing", "verify-failed", "agent-offline"]) expect(typeof lookup(om, `error.${c}`), c).toBe("string");
  });

  it("every hub warning code the hub can emit has a translation (no raw code ever reaches the UI)", () => {
    const t = (k: string) => (typeof lookup(om, k.replace(/^objectMigration\./, "")) === "string" ? "ok" : "MISSING");
    for (const code of ["no_agent_image", "probe_incomplete", "too_many_buckets", "no_buckets", "size_unknown", "versions_not_carried", "dst_not_empty", "src_unreachable", "dst_unreachable", "no_mc", "dst_space_low"]) {
      expect(warningText(t, { code, level: "warn", bucket: "b" }), code).toBe("ok");
    }
    expect(statusLabelKey("DONE")).toBe("objectMigration.status.DONE");
  });

  it("the not-carried text is honest: versions/IAM/replication/notifications/SSE/object lock, no checksum claim", () => {
    const text = JSON.stringify(om);
    expect(om.preflight.notCarried).toMatch(/versions/);
    expect(om.preflight.notCarried).toMatch(/IAM users/);
    expect(om.preflight.notCarried).toMatch(/replication/);
    expect(om.preflight.notCarried).toMatch(/object lock/);
    expect(om.preflight.notCarried).toMatch(/after the final pass are NOT copied/);
    expect(text).not.toMatch(/checksum verified|checksum-verified|hash verified/i);
  });

  it("no hardcoded English sentence literal in the object-migration components", () => {
    for (const f of files.filter((x) => x.startsWith("components/object-migration"))) {
      const src = readFileSync(path.join(SRC, f), "utf8");
      const jsxText = [...src.matchAll(/>([^<>{}\n]*[A-Za-z]{3,}\s+[A-Za-z]{3,}\s+[A-Za-z]{3,}[^<>{}\n]*)</g)].map((m) => m[1].trim());
      expect(jsxText, f).toEqual([]);
    }
  });
});
