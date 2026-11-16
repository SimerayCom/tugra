import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import importNs from "./locales/en/import.json";

const SRC = path.resolve(__dirname, "..");
const lookup = (tree: unknown, dotted: string): unknown =>
  dotted.split(".").reduce<unknown>((n, k) => (n && typeof n === "object" ? (n as Record<string, unknown>)[k] : undefined), tree);

describe("import wizard i18n coverage", () => {
  const files = ["components/import-wizard.tsx", ...readdirSync(path.join(SRC, "components/import")).filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx")).map((f) => `components/import/${f}`)];

  it("every literal import.* key used by the wizard and its panels exists in en/import.json", () => {
    const used = new Set<string>();
    for (const f of files) for (const m of readFileSync(path.join(SRC, f), "utf8").matchAll(/["'`](import\.[A-Za-z0-9_.]+)["'`]/g)) used.add(m[1]);
    expect(used.size).toBeGreaterThan(40);
    const missing = [...used].filter((k) => typeof lookup(importNs, k.replace(/^import\./, "")) !== "string");
    expect(missing).toEqual([]);
  });

  it("the spec'd env/git/remap keys all exist", () => {
    const keys = [
      "env.blockers.title", "env.blockers.body", "env.reason.noValue", "env.reason.sharedUnexpanded", "env.reason.magic", "env.reason.invalidKey",
      "env.tokenReadOnly.title", "env.tokenReadOnly.body", "env.previewSkipped", "env.ackItem", "env.ackAll", "env.ackWarning", "env.taskNote", "env.keysMore", "remap.serviceLinkReview", "remap.unresolvedHost",
      "git.title", "git.group.linked", "git.group.publicOk", "git.group.needsSource", "git.group.ambiguous", "git.group.sshDeployKey", "git.group.unsupportedHost", "git.group.unknown",
      "git.connectGithub", "git.recheck", "git.relink", "git.pickSource", "git.sshConverted", "git.deployKey.title", "git.deployKey.copy", "git.gitlabNote", "git.hosts",
    ];
    for (const k of keys) expect(typeof lookup(importNs, k), k).toBe("string");
  });

  it("no hardcoded English sentence literal in the new panels (strings go through t())", () => {
    for (const f of ["components/import/env-blockers.tsx", "components/import/git-links-panel.tsx"]) {
      const src = readFileSync(path.join(SRC, f), "utf8");
      // JSX text nodes with 3+ words that are not inside {} expressions
      const jsxText = [...src.matchAll(/>([^<>{}\n]*[A-Za-z]{3,}\s+[A-Za-z]{3,}\s+[A-Za-z]{3,}[^<>{}\n]*)</g)].map((m) => m[1].trim());
      expect(jsxText, f).toEqual([]);
    }
  });
});

const read = (rel: string) => readFileSync(path.join(SRC, rel), "utf8");
// keys are addressed under the import namespace: "import.review.x" => import.json review.x
const inJson = (key: string) => lookup(importNs, key.replace(/^import\./, ""));

const FILES = [
  "components/import-review-step.tsx",
  "components/import-mapping-table.tsx",
  "components/import-mapping-row.tsx",
  "components/import-bulk-bar.tsx",
  "components/import-conflicts-panel.tsx",
  "components/import-mapping-io.tsx",
  "components/import-wizard.tsx",
];

describe("import review i18n coverage", () => {
  it("every literal t(import.review.* | import.conflict.*) key used in the new files exists in en/import.json", () => {
    const used = new Set<string>();
    for (const f of FILES) for (const m of read(f).matchAll(/["'`](import\.(?:review|conflict)\.[A-Za-z0-9_.]+)["'`]/g)) used.add(m[1]);
    expect(used.size).toBeGreaterThan(40);
    const missing = [...used].filter((k) => typeof inJson(k) !== "string");
    expect(missing).toEqual([]);
  });

  it("every dynamic key family resolves for every member", () => {
    const check = (prefix: string, members: string[]) => {
      for (const m of members) expect(typeof inJson(`${prefix}${m}`), `${prefix}${m}`).toBe("string");
    };
    check("import.review.filter.", ["all", "changed", "conflicts", "excluded"]);
    check("import.review.status.", ["pending", "blocked", "alreadyImported", "excluded"]);
    check("import.review.bulk.", ["prefix", "suffix", "replace", "lowercase", "move", "exclude", "include", "reset"]);
    check("import.conflict.level.", ["error", "warn", "info"]);
    check("import.review.err.", ["mapping_required", "mapping_changed", "mapping_orphans", "mapping_invalid", "mapping_version_conflict"]);
    check("import.review.col.", ["include", "source", "name", "project", "environment", "alias", "status", "dbIdentifier"]);
    check("import.review.counts.", ["apps", "databases", "renamed", "moved", "excluded", "aliased", "errors", "warnings", "newProjects", "newEnvironments"]);
    check("import.review.hint.", ["rename", "envRemap", "alias", "database", "treeKept", "scopeOnly"]);
    check("import.review.origin.", ["source", "mapping", "default", "derived", "tree", "selected"]);
    check("import.review.ack.", ["name.duplicate", "project.merge_existing", "project.merge_sources", "item.imported_elsewhere"]);
  });

  it("covers every conflict code the hub's resolver can emit (read from its source)", () => {
    const hub = readFileSync(path.resolve(SRC, "../../hub-api/src/importer/import-mapping.ts"), "utf8");
    const codes = new Set<string>();
    for (const m of hub.matchAll(/"((?:name|alias|db|key|scope|perm|env|project|item|gitsource|dep|placement|tree)\.[a-z_]+)"/g)) codes.add(m[1]);
    expect(codes.size).toBeGreaterThan(20);
    const missing = [...codes].filter((c) => typeof inJson(`import.conflict.${c}`) !== "string");
    expect(missing).toEqual([]);
  });

  it("every acknowledgement the hub can demand has a checkbox label", () => {
    const hub = readFileSync(path.resolve(SRC, "../../hub-api/src/importer/import-mapping.ts"), "utf8");
    const ackCodes = [...hub.matchAll(/add\(ack\(\{ code: "([a-z_.]+)"/g)].map((m) => m[1]);
    expect(ackCodes.sort()).toEqual(["item.imported_elsewhere", "name.duplicate", "project.merge_existing", "project.merge_sources"]);
    for (const c of ackCodes) expect(typeof inJson(`import.review.ack.${c}`), c).toBe("string");
  });

  it("no hardcoded English UI strings slipped into the new components (visible text goes through t())", () => {
    for (const f of FILES.slice(0, 6)) {
      const jsxText = [...read(f).matchAll(/<[A-Za-z][^<>]*>\s*([A-Z][a-z]+(?: [a-z]+)*)\s*<\//g)].map((m) => m[1]);
      expect(jsxText, f).toEqual([]);
    }
  });
});
