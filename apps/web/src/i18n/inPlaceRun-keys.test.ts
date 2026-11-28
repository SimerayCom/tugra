import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import inPlaceRun from "./locales/en/inPlaceRun.json";
import en from "./locales/en";
import { APP_STATE_KEY, IN_PLACE_STEP_TITLE_KEY, nextHeadingKey, runStateKey } from "../lib/inplace-run";

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

describe("the in-place run page is worded", () => {
  const sources = [...walk(path.join(SRC, "components/migration-run")), path.join(SRC, "lib/inplace-run.ts")].map((f) => readFileSync(f, "utf8"));

  it("every literal inPlaceRun.* key used in code exists in en/inPlaceRun.json", () => {
    const used = new Set<string>();
    for (const src of sources) for (const m of src.matchAll(/["'`](inPlaceRun\.[A-Za-z0-9_.-]+)["'`]/g)) used.add(m[1]);
    expect(used.size).toBeGreaterThan(40);
    expect([...used].filter((k) => typeof lookup(en, k) !== "string")).toEqual([]);
  });

  it("every app state, in-place step, run state and card heading has a sentence", () => {
    for (const key of [...Object.values(APP_STATE_KEY), ...Object.values(IN_PLACE_STEP_TITLE_KEY)]) expect(typeof lookup(en, key as string), key).toBe("string");
    const kinds = ["operator", "approval", "timer", "gate", "session", "paused", "failed", "engine", "none"] as const;
    const statuses = ["QUEUED", "RUNNING", "WAITING", "PAUSED", "ABORTING", "ABORTED", "ROLLING_BACK", "ROLLED_BACK", "REVERSING", "REVERSED", "COMPLETED", "FAILED", "DRY_RUN_DONE"] as const;
    for (const status of statuses) {
      for (const kind of kinds) {
        expect(typeof lookup(en, runStateKey({ status, nextAction: { kind, stepKey: null, code: "x", since: "" } })), `${status}/${kind}`).toBe("string");
        for (const step of [null, "DEPLOY_DARK", "CUTOVER", "IMPORT"] as const) expect(typeof lookup(en, nextHeadingKey(kind, step, status)), `${status}/${kind}/${step}`).toBe("string");
      }
    }
  });

  it("has no empty strings and is registered with the locale bundle", () => {
    const leaves = (o: Record<string, unknown>, prefix = ""): Array<[string, unknown]> => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? leaves(v as Record<string, unknown>, `${prefix}${k}.`) : [[`${prefix}${k}`, v] as [string, unknown]]));
    for (const [k, v] of leaves(inPlaceRun as Record<string, unknown>)) expect(typeof v === "string" && v.trim().length > 0, k).toBe(true);
    expect((en as Record<string, unknown>).inPlaceRun).toBe(inPlaceRun);
  });
});
