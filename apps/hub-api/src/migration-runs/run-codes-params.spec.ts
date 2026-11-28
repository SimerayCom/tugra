import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as ts from "typescript";

/**
 * Guard: a failure's sentence never prints a raw `{placeholder}`. The web fills `migrationRun.codes.<code>` from the params the hub sends, so
 * a code whose sentence has `{host}` must be thrown / returned with a `host` param. This scans the non-spec sources for the two shapes that
 * carry a failure (`new StepFailure(code, { ... })` and an object with a literal `code` next to a literal `params`) and fails when a
 * placeholder of that code's sentence is missing from the literal params.
 *
 * Params that are not an object literal (a variable, a spread) cannot be checked here; those sites are filled by a helper that is covered
 * by its own spec, and are listed in {@link OPAQUE} so a new one is a conscious choice.
 */

const ROOT = __dirname;
const LOCALE = join(__dirname, "../../../web/src/i18n/locales/en/migrationRun.json");
const CODE_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** `file: code` pairs whose params are a spread of a computed object next to literal keys (each checked by hand: the named placeholders are among the keys or the spread). */
const OPAQUE = new Set<string>([
  "steps/cutover/cutover.handler.ts: cutover.flip-halted",
  "steps/import/import.step.ts: import.risk-warning",
  "steps/import/remap-env.step.ts: remap-env.needs-manual",
  "steps/import/preflight.step.ts: preflight.images-unpinned",
  "steps/import/preflight.step.ts: preflight.hosts-classified",
  "steps/cutover/cutover.handler.ts: cutover.webhooks-repoint",
  "steps/cutover/cutover.handler.ts: cutover.webhooks-repoint-apps",
  "steps/cutover/decommission.handler.ts: decommission.stop-source-unknown",
  "steps/cutover/decommission.handler.ts: decommission.stop-source-first",
]);

const locale = JSON.parse(readFileSync(LOCALE, "utf8")) as { codes: Record<string, string> };
const placeholdersOf = (code: string): string[] => {
  const text = locale.codes[code.replace(/\./g, "_")];
  return typeof text === "string" ? [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))] : [];
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "testing" ? [] : sources(p);
    return p.endsWith(".ts") && !p.endsWith(".spec.ts") ? [p] : [];
  });
}

interface Site {
  file: string;
  code: string;
  keys: string[] | null;
}

function scan(): Site[] {
  const out: Site[] = [];
  const keysOf = (o: ts.ObjectLiteralExpression): string[] | null => {
    const keys: string[] = [];
    for (const p of o.properties) {
      if (ts.isShorthandPropertyAssignment(p)) keys.push(p.name.text);
      else if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) keys.push(p.name.text);
      else return null; // a spread or a computed key: opaque
    }
    return keys;
  };
  for (const file of sources(ROOT)) {
    const rel = relative(ROOT, file);
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node): void => {
      if (ts.isNewExpression(n) && n.expression.getText(sf) === "StepFailure" && n.arguments?.[0] && ts.isStringLiteralLike(n.arguments[0]) && CODE_RE.test(n.arguments[0].text)) {
        const a = n.arguments[1];
        out.push({ file: rel, code: n.arguments[0].text, keys: !a ? [] : ts.isObjectLiteralExpression(a) ? keysOf(a) : null });
      } else if (ts.isObjectLiteralExpression(n)) {
        const code = n.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "code");
        const params = n.properties.find((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText(sf) === "params");
        if (code && ts.isStringLiteralLike(code.initializer) && CODE_RE.test(code.initializer.text) && placeholdersOf(code.initializer.text).length > 0) {
          const v = params && ts.isPropertyAssignment(params) ? params.initializer : undefined;
          out.push({ file: rel, code: code.initializer.text, keys: !params ? [] : v && ts.isObjectLiteralExpression(v) ? keysOf(v) : null });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

describe("failure codes fill their placeholders", () => {
  const sites = scan();
  it("found the sites it is meant to check", () => {
    expect(sites.filter((s) => s.code === "deploy-dark.inplace-test-failed").length).toBe(1);
    expect(sites.length).toBeGreaterThan(50);
  });
  it("every literal params object carries the placeholders of its code's sentence", () => {
    const missing = sites
      .filter((s) => s.keys !== null)
      .flatMap((s) => placeholdersOf(s.code).filter((p) => !(s.keys as string[]).includes(p)).map((p) => `${s.file}: ${s.code} lacks {${p}}`));
    expect(missing).toEqual([]);
  });
  it("params that cannot be read here are the listed ones only", () => {
    const opaque = sites.filter((s) => s.keys === null && placeholdersOf(s.code).length > 0).map((s) => `${s.file}: ${s.code}`);
    expect(opaque.filter((o) => !OPAQUE.has(o))).toEqual([]);
  });
});
