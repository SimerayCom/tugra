import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import en from "./locales/en";

const SRC = readFileSync(path.resolve(__dirname, "../components/server-oob-card.tsx"), "utf8");
const lookup = (tree: unknown, dotted: string): unknown => dotted.split(".").reduce<unknown>((n, k) => (n && typeof n === "object" ? (n as Record<string, unknown>)[k] : undefined), tree);

describe("out-of-band card i18n", () => {
  it("every literal oob.* key used by the card exists in en/oob.json", () => {
    const used = new Set<string>();
    for (const m of SRC.matchAll(/["'`](oob\.[A-Za-z0-9_.]+)["'`]/g)) used.add(m[1]);
    expect(used.size).toBeGreaterThan(40);
    expect([...used].filter((k) => typeof lookup(en, k) !== "string")).toEqual([]);
  });

  it("every provider power word the card can render has a label (the dynamic oob.power.<status> keys)", () => {
    const known = /new Set\(\["running", "off"([^\]]*)\]\)/.exec(SRC)![0].match(/"[a-z]+"/g)!.map((w) => w.replace(/"/g, ""));
    for (const w of known) expect(typeof lookup(en, `oob.power.${w}`), w).toBe("string");
  });

  it("no oob key text is hard-coded in the component (no string literal sentence in JSX)", () => {
    // A cheap guard: a JSX text node with a capitalised English sentence would not be translated.
    expect(/>\s*[A-Z][a-z]+ [a-z]+[^<{]*</.test(SRC.replace(/\{[^}]*\}/g, ""))).toBe(false);
  });
});
