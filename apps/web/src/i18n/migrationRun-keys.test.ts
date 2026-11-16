import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import migrationRun from "./locales/en/migrationRun.json";
import en from "./locales/en";
import nav from "./locales/en/nav.json";
import {
  CHECK_STATUS_KEY, CONFIRM_PROMPT_KEY, DRY_KEY, ERROR_CODE_KEY, EVIDENCE_HINT_KEY, EVIDENCE_KEY, MIGRATION_RUN_STATUSES, MIGRATION_RUN_STEP_KEYS, MIGRATION_RUN_STEP_STATUSES,
  MODE_HINT_KEY, MODE_KEY, NEXT_KIND_KEY, OWNER_INPUT_HINT_KEY, OWNER_INPUT_LABEL_KEY, REVIEW_LABEL_KEY, ROLLBACK_KEY, RUN_STATUS_KEY, STEP_DESC_KEY, STEP_KIND_KEY, STEP_STATUS_KEY, STEP_TITLE_KEY,
  TOPOLOGY_HINT_KEY, TOPOLOGY_KEY, UNIT_KEY, VERSION_VERDICT_HINT_KEY, VERSION_VERDICT_KEY, OWNER_POLICY_CHOICE_KEY, EVIDENCE_KINDS, codeKey,
} from "../lib/migration-run";

const SRC = path.resolve(__dirname, "..");
function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)) out.push(p);
  }
  return out;
}
const lookup = (tree: unknown, dotted: string): unknown => dotted.split(".").reduce<unknown>((n, k) => (n && typeof n === "object" ? (n as Record<string, unknown>)[k] : undefined), tree);
const leaves = (o: Record<string, unknown>, prefix = ""): Array<[string, unknown]> =>
  Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? leaves(v as Record<string, unknown>, `${prefix}${k}.`) : [[`${prefix}${k}`, v] as [string, unknown]]));

const files = [...walk(path.join(SRC, "components/migration-run")), path.join(SRC, "lib/migration-run.ts"), ...walk(path.join(SRC, "app/(app)/import/runs")), path.join(SRC, "components/import-wizard.tsx")];
const sources = files.map((f) => ({ f, src: readFileSync(f, "utf8") }));

describe("guided migration i18n coverage", () => {
  it("every literal migrationRun.* key used in code exists in en/migrationRun.json", () => {
    const used = new Set<string>();
    for (const { src } of sources) for (const m of src.matchAll(/["'`](migrationRun\.[A-Za-z0-9_.-]+)["'`]/g)) used.add(m[1]);
    expect(used.size).toBeGreaterThan(150);
    const missing = [...used].filter((k) => typeof lookup(en, k) !== "string");
    expect(missing).toEqual([]);
  });

  it("no migrationRun key is built by string concatenation (so the static check sees every key)", () => {
    for (const { f, src } of sources) {
      expect(/t\(\s*`migrationRun\.[^`]*\$\{/.test(src) || /t\(\s*["']migrationRun\.[^"']*["']\s*\+/.test(src), f).toBe(false);
    }
  });

  it("the json has no empty strings and is registered with the locale bundle", () => {
    const all = leaves(migrationRun as Record<string, unknown>);
    expect(all.length).toBeGreaterThan(200);
    for (const [k, v] of all) expect(typeof v === "string" && v.trim().length > 0, k).toBe(true);
    expect((en as Record<string, unknown>).migrationRun).toBe(migrationRun);
  });

  it("every status, step, kind, rollback, evidence, mode and topology value has a translated key", () => {
    const maps: Array<Record<string, string>> = [
      RUN_STATUS_KEY, STEP_STATUS_KEY, STEP_TITLE_KEY, STEP_DESC_KEY, STEP_KIND_KEY, ROLLBACK_KEY, EVIDENCE_KEY, EVIDENCE_HINT_KEY, CHECK_STATUS_KEY, MODE_KEY, MODE_HINT_KEY, TOPOLOGY_KEY, TOPOLOGY_HINT_KEY,
      NEXT_KIND_KEY, UNIT_KEY, OWNER_INPUT_LABEL_KEY, OWNER_INPUT_HINT_KEY, CONFIRM_PROMPT_KEY, DRY_KEY, ERROR_CODE_KEY, REVIEW_LABEL_KEY,
      VERSION_VERDICT_KEY, VERSION_VERDICT_HINT_KEY, ...Object.values(OWNER_POLICY_CHOICE_KEY),
    ];
    for (const m of maps) for (const [code, key] of Object.entries(m)) expect(typeof lookup(en, key), `${code} -> ${key}`).toBe("string");
    expect(Object.keys(RUN_STATUS_KEY).sort()).toEqual([...MIGRATION_RUN_STATUSES].sort());
    expect(Object.keys(STEP_STATUS_KEY).sort()).toEqual([...MIGRATION_RUN_STEP_STATUSES].sort());
    expect(Object.keys(STEP_TITLE_KEY).sort()).toEqual([...MIGRATION_RUN_STEP_KEYS].sort());
    expect(Object.keys(STEP_DESC_KEY).sort()).toEqual([...MIGRATION_RUN_STEP_KEYS].sort());
  });

  it("every evidence kind, owner input and confirmation kind the hub speaks is worded", () => {
    expect(Object.keys(EVIDENCE_KEY).sort()).toEqual([...EVIDENCE_KINDS].sort());
    expect(Object.keys(EVIDENCE_HINT_KEY).sort()).toEqual([...EVIDENCE_KINDS].sort());
    expect(Object.keys(OWNER_INPUT_LABEL_KEY).sort()).toEqual(["acmeEmail", "allowBind", "allowLiveShapeProbe", "minioPolicy", "orphanVolumePolicy", "sourceController", "unlistedDbPolicy", "workerPolicy"]);
    expect(Object.keys(CONFIRM_PROMPT_KEY).sort()).toEqual(["none", "run-id", "source-host", "target-server", "target-server+source-host", "target-servers", "target-servers+source-host"]);
  });

  it("every engine event code from the contract has a localized message", () => {
    const ENGINE = [
      "run.created", "run.started", "run.promoted", "run.paused", "run.resumed", "run.waiting", "run.failed", "run.completed", "run.dry-run-done", "run.abort.requested", "run.aborted",
      "run.cleanup.started", "run.rolled-back", "run.reverse.started", "run.reversed", "run.ponr.reached", "run.auth-lost", "run.recovered", "run.input.set", "run.session.refreshed",
      "step.entered", "step.waiting", "step.passed", "step.failed", "step.skipped", "step.retry", "step.compensated", "step.evidence.added", "step.attached", "step.command.issued",
      "run.source-version", "approval.accepted", "approval.void", "approval.expired", "step.not-applicable", "step.post-gate-failed", "step.internal-error",
    ];
    for (const c of ENGINE) expect(typeof lookup(en, codeKey(c)), c).toBe("string");
  });

  it("the nav entry exists", () => {
    expect(typeof (nav as Record<string, unknown>).importRuns).toBe("string");
  });

  it("never claims zero downtime or that nothing is lost", () => {
    for (const [k, v] of leaves(migrationRun as Record<string, unknown>)) {
      expect(String(v), k).not.toMatch(/zero[- ]downtime|no downtime|without downtime|seamless|nothing is lost/i);
    }
  });

  it("no hardcoded English sentence in the new components (strings go through t())", () => {
    for (const { f, src } of sources) {
      if (!f.includes("components/migration-run")) continue;
      const jsxText = [...src.matchAll(/>([^<>{}\n]*[A-Za-z]{3,}\s+[A-Za-z]{3,}\s+[A-Za-z]{3,}[^<>{}\n]*)</g)].map((m) => m[1].trim());
      expect(jsxText, f).toEqual([]);
    }
  });
});
