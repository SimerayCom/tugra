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
      "env.tokenReadOnly.title", "env.tokenReadOnly.body", "env.previewSkipped", "env.ackItem", "env.ackAll", "env.ackWarning", "env.taskNote", "env.keysMore", "remap.serviceLinkReview",
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
