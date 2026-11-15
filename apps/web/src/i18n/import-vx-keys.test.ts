import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import importMessages from "./locales/en/import.json";
import { GATE_KEY, PHASE_KEY, STATE_KEY } from "../lib/import";

const SRC = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(SRC, rel), "utf8");
function lookup(tree: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((n, k) => (n && typeof n === "object" ? (n as Record<string, unknown>)[k] : undefined), tree);
}
const has = (key: string) => typeof lookup({ import: importMessages }, key) === "string";

const FILES = ["components/import-volume-transfers.tsx", "components/import-vx-preflight.tsx", "components/import-wizard.tsx", "lib/import.ts"];

describe("import.vx.* i18n", () => {
  it("every literal import.* key used by the volume UI exists in en/import.json", () => {
    const used = new Set<string>();
    for (const f of FILES) for (const m of read(f).matchAll(/["'`](import\.[A-Za-z0-9_.]+)["'`]/g)) used.add(m[1]);
    expect([...used].some((k) => k.startsWith("import.vx."))).toBe(true);
    expect([...used].filter((k) => !has(k))).toEqual([]);
  });

  it("the dynamic keys (states, phases, gates, commands, gate statuses) all exist", () => {
    for (const k of [...Object.values(STATE_KEY), ...Object.values(PHASE_KEY), ...Object.values(GATE_KEY)]) expect(has(k), k).toBe(true);
    for (const k of ["dryRun", "run", "resume"]) expect(has(`import.vx.commands.${k}`), k).toBe(true);
    for (const k of ["pass", "fail", "unknown"]) expect(has(`import.vx.gate.${k}`), k).toBe(true);
  });

  it("the spec's key families are present", () => {
    const required = [
      "import.vx.title", "import.vx.evidence.reportedByMigrator", "import.vx.action.abort", "import.vx.action.reset", "import.vx.action.retry", "import.vx.action.dryRun", "import.vx.action.copyCommand",
      "import.vx.confirm.abort.title", "import.vx.confirm.abort.body", "import.vx.confirm.reset.title", "import.vx.confirm.reset.body",
      "import.vx.progress.bytes", "import.vx.progress.parts", "import.vx.progress.eta", "import.vx.progress.speed",
      "import.vx.preflight.found", "import.vx.preflight.notFound", "import.vx.preflight.size", "import.vx.preflight.running", "import.vx.preflight.stopped", "import.vx.preflight.exitCode", "import.vx.preflight.bind",
      "import.vx.preflight.diskOk", "import.vx.preflight.diskShort", "import.vx.preflight.diskSameDevice", "import.vx.preflight.downtimeEstimate",
      "import.vx.mode.dump", "import.vx.mode.volume", "import.vx.mode.volumeLocked",
      "import.vx.gate.credentials", "import.vx.gate.major", "import.vx.gate.layout", "import.vx.gate.image", "import.vx.gate.state",
      "import.vx.error.diverged", "import.vx.error.fingerprint", "import.vx.error.busy", "import.vx.error.disk", "import.vx.error.aborted", "import.vx.error.sourceRunning", "import.vx.error.tokenExpired", "import.vx.error.specialFiles",
      "import.vx.warn.stopSource", "import.vx.warn.allowBind", "import.vx.warn.fidelity", "import.vx.warn.estimate", "import.vx.notMigrated.confirm",
    ];
    expect(required.filter((k) => !has(k))).toEqual([]);
  });

  it("the fidelity text states what is NOT copied (honest limits) and the migrator-evidence note is present", () => {
    const t = (k: string) => lookup({ import: importMessages }, k) as string;
    for (const word of ["extended attributes", "ACLs", "file capabilities", "sockets", "device nodes"]) expect(t("import.vx.warn.fidelity")).toContain(word);
    expect(t("import.vx.evidence.reportedByMigrator")).toBe("reported by the migrator");
  });

  it("no placeholder is left unbound: every {var} in a vx message is one the components pass", () => {
    const allowed = new Set(["done", "total", "count", "time", "rate", "size", "entries", "code", "free", "need", "low", "high", "image", "major", "layout", "path", "name", "n"]);
    const walk = (o: unknown, trail: string): void => {
      if (typeof o === "string") for (const m of o.matchAll(/\{(\w+)\}/g)) expect(allowed.has(m[1]), `${trail} uses {${m[1]}}`).toBe(true);
      else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) walk(v, `${trail}.${k}`);
    };
    walk((importMessages as Record<string, unknown>).vx, "vx");
  });
});
