import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import cutover from "./locales/en/cutover.json";
import servers from "./locales/en/servers.json";
import apps from "./locales/en/apps.json";
import en from "./locales/en";
import { STATE_KEY, DNS_KEY, CERT_KEY, BLOCK_KEY, WARN_KEY } from "../lib/cutover";

const SRC = path.resolve(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)) out.push(p);
  }
  return out;
}
const sources = walk(SRC).map((f) => ({ f, src: readFileSync(f, "utf8") }));

function lookup(tree: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((n, k) => (n && typeof n === "object" ? (n as Record<string, unknown>)[k] : undefined), tree);
}
function leaves(o: Record<string, unknown>, prefix = ""): Array<[string, unknown]> {
  return Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? leaves(v as Record<string, unknown>, `${prefix}${k}.`) : [[`${prefix}${k}`, v] as [string, unknown]]));
}

describe("SSL/DNS cutover i18n coverage", () => {
  it("every literal cutover.* key used in code exists in en/cutover.json", () => {
    const used = new Set<string>();
    for (const { src } of sources) for (const m of src.matchAll(/["'`](cutover\.[A-Za-z0-9_.]+)["'`]/g)) used.add(m[1]);
    expect(used.size).toBeGreaterThan(100);
    const missing = [...used].filter((k) => typeof lookup(en, k) !== "string");
    expect(missing).toEqual([]);
  });

  it("no cutover key is built by string concatenation (so the static check above sees every key)", () => {
    for (const { f, src } of sources) {
      expect(/t\(\s*`cutover\.[^`]*\$\{/.test(src) || /t\(\s*["']cutover\.[^"']*["']\s*\+/.test(src), f).toBe(false);
    }
  });

  it("the json has no empty strings", () => {
    const all = leaves(cutover as Record<string, unknown>);
    expect(all.length).toBeGreaterThan(100);
    for (const [k, v] of all) expect(typeof v === "string" && v.trim().length > 0, k).toBe(true);
  });

  it("the cutover namespace is registered with the locale bundle", () => {
    expect((en as Record<string, unknown>).cutover).toBe(cutover);
  });

  it("every hub state, dns, certificate, block and warning code has a translated key", () => {
    const states = "PLANNED CERT_PENDING CERT_READY READY SWITCHING SWITCHED VERIFIED VERIFY_FAILED REVERTING ROLLED_BACK BLOCKED EXCLUDED CONFLICT".split(" ");
    const dns = "source target mixed proxied tunnel unknown".split(" ");
    const certs = "unknown pending ready default-cert untrusted wrong-host expired error".split(" ");
    const blocks = "cluster-app tunnel-routed generated-host counterpart-not-served zone-not-covered no-dns-credential caa-blocks-letsencrypt record-changed record-changed-since-flip data-not-done no-target-ip".split(" ");
    const warns = "stale-aaaa-deleted cname-replaced wildcard-explicit-record surplus-a-deleted proxied-kept proxied-dropped ttl-not-waited http01-gap stateful caa coverage-unverified ssl-mode-weak ssl-mode-unknown ssl-mode-bad".split(" ");
    for (const [map, codes] of [[STATE_KEY, states], [DNS_KEY, dns], [CERT_KEY, certs], [BLOCK_KEY, blocks], [WARN_KEY, warns]] as const) {
      for (const c of codes) expect(typeof lookup(en, map[c] ?? "missing"), c).toBe("string");
    }
  });

  it("never claims zero downtime or that certificates carry over", () => {
    for (const [k, v] of leaves(cutover as Record<string, unknown>)) {
      expect(String(v), k).not.toMatch(/zero[- ]downtime|no downtime|without downtime/i);
      expect(String(v), k).not.toMatch(/certificates? (are|is|will be) (carried|copied|migrated|moved) over/i);
    }
  });

  it("the server + domain-options keys exist", () => {
    for (const k of ["label", "none", "noCredentials", "coverageVerified", "coverageUnverified", "readOnly", "tokenCopied", "reapply", "reapplyHint", "reapplied"]) {
      expect(typeof lookup(servers, `acmeDns.${k}`), `servers.acmeDns.${k}`).toBe("string");
    }
    for (const k of ["label", "desc", "noCreds", "loadingServer"]) expect(typeof lookup(apps, `domainDnsChallenge.${k}`), `apps.domainDnsChallenge.${k}`).toBe("string");
    for (const { src } of sources) {
      for (const m of src.matchAll(/["'`]servers\.acmeDns\.([A-Za-z0-9_]+)["'`]/g)) expect(typeof lookup(servers, `acmeDns.${m[1]}`), m[0]).toBe("string");
      for (const m of src.matchAll(/["'`]apps\.domainDnsChallenge\.([A-Za-z0-9_]+)["'`]/g)) expect(typeof lookup(apps, `domainDnsChallenge.${m[1]}`), m[0]).toBe("string");
    }
  });
});
