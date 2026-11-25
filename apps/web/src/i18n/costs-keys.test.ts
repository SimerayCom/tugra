import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import en from "./locales/en";

const FILES = ["../app/(app)/costs/page.tsx", "../components/costs/server-cost-list.tsx", "../components/costs/before-after-card.tsx", "../components/costs/size-advice-list.tsx"];
const SRC = FILES.map((f) => readFileSync(path.resolve(__dirname, f), "utf8")).join("\n");
const lookup = (tree: unknown, dotted: string): unknown => dotted.split(".").reduce<unknown>((n, k) => (n && typeof n === "object" ? (n as Record<string, unknown>)[k] : undefined), tree);

describe("costs i18n", () => {
  it("every literal costs.* key the screens use exists in en/costs.json", () => {
    const used = new Set<string>();
    for (const m of SRC.matchAll(/["'`](costs\.[A-Za-z0-9_.]+)["'`]/g)) used.add(m[1]);
    expect(used.size).toBeGreaterThan(40);
    expect([...used].filter((k) => typeof lookup(en, k) !== "string")).toEqual([]);
  });

  it("every dynamic costs.<group>.<value> key has all its values", () => {
    const groups: Array<[string, string[]]> = [
      ["costs.source", ["provider", "manual", "estimate", "unknown"]],
      ["costs.apps.kind", ["app", "db", "system", "other"]],
      ["costs.advice.reason", ["cpu", "memory", "disk"]],
      ["costs.advice.priceBasis", ["provider", "list", "none"]],
      ["costs.rescale.phase", ["SHUTTING_DOWN", "RESIZING", "POWERING_ON", "DONE", "FAILED"]],
      ["costs.guide.hetzner", ["s1", "s2", "s3", "s4"]],
      ["costs.guide.digitalocean", ["s1", "s2", "s3", "s4"]],
      ["costs.guide.vultr", ["s1", "s2", "s3", "s4"]],
      ["costs.guide.generic", ["s1", "s2", "s3", "s4"]],
    ];
    for (const [g, values] of groups) for (const v of values) expect(typeof lookup(en, `${g}.${v}`), `${g}.${v}`).toBe("string");
  });

  it("no JSX text sentence is hard-coded in the screens", () => {
    expect(/>\s*[A-Z][a-z]+ [a-z]+[^<{]*</.test(SRC.replace(/\{[^}]*\}/g, ""))).toBe(false);
  });

  it("every key in costs.json is used somewhere (no dead copy)", () => {
    const flat: string[] = [];
    const walk = (o: unknown, p: string) => {
      if (typeof o === "string") flat.push(p);
      else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) walk(v, p ? `${p}.${k}` : k);
    };
    walk((en as Record<string, unknown>).costs, "costs");
    const dynamic = ["costs.source.", "costs.apps.kind.", "costs.advice.reason.", "costs.advice.priceBasis.", "costs.rescale.phase.", "costs.guide.hetzner.", "costs.guide.digitalocean.", "costs.guide.vultr.", "costs.guide.generic."];
    const dead = flat.filter((k) => !SRC.includes(`"${k}"`) && !dynamic.some((d) => k.startsWith(d)));
    expect(dead).toEqual([]);
  });
});
