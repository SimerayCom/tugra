import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as ts from "typescript";
import { isRunCode } from "./core/run-contract";

/**
 * Guard: every code a guided-migration run can emit has an English sentence in the web locale. The hub speaks CODES + PARAMS
 * only; the web renders `migrationRun.codes.<code with dots as underscores>`, and a code without an entry falls back to a
 * humanized code ("cutover: swap live") in front of the operator. This spec scans the non-spec sources of this module for the
 * codes they emit and fails when one has no entry, so a new code cannot ship untranslated.
 *
 * What counts as an emitted code (found with the TypeScript AST, so comments and ids never match):
 *  - a string literal inside the value of a `code` / `lastError` / `failureCode` property (events, gate checks, wait specs,
 *    dry-run items, manual steps, `ActResult` failures; both branches of a ternary, both sides of `??` / `||`),
 *  - the first argument of `new StepFailure(...)`, `failureGate(...)`, the third of the engine's `failStep(run, row, <code>, ...)`, `requireOpId(run, <code>)`, the third of `chk(id, status, <code>)`,
 *    the last of `timerGate(...)`, the third of the facade's `event(runId, actor, <code>, ...)`,
 *  - every string in a `*_CODE` / `*_CODES` declaration (`DATA_CODES`, `PARITY_CODES`, `ENGINE_EVENT_CODES`, `SESSION_EXPIRED_CODE`).
 * Gate-check ids, attestation ids, step-key prefixes and audit actions are NOT codes and are deliberately not matched.
 *
 * Codes built from a template are not visible as literals; each one is resolved explicitly in {@link TEMPLATE_CODES} and the
 * scan fails when it meets a template-built code that is not listed there (so a new one forces a conscious update).
 */

const ROOT = __dirname;
const LOCALE = join(__dirname, "../../../web/src/i18n/locales/en/migrationRun.json");
const CODE_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/**
 * Codes the sources build from a template, resolved by hand. The key is the template text as written (checked against the scan),
 * the value what it expands to.
 */
const TEMPLATE_CODES: Record<string, string[]> = {
  // tls-preissue.handler.ts: the dark probe's non-ok states
  "tls-preissue.dark-probe-${obs.darkState}": ["tls-preissue.dark-probe-no-proxy", "tls-preissue.dark-probe-unavailable", "tls-preissue.dark-probe-error"],
  // cutover.handler.ts dryRun: `cutover.dry.swap-${inspect-failed | identity-mismatch}`
  "cutover.dry.swap-${ident.code === \"unreadable\" ? \"inspect-failed\" : \"identity-mismatch\"}": ["cutover.dry.swap-inspect-failed", "cutover.dry.swap-identity-mismatch"],
  // import-port.service.ts opItems: `import.task-<BulkTaskStatus lower-cased>` for every task that did not end DONE
  "import.task-${t.status.toLowerCase().replace(/_/g, \"-\")}": [
    "import.task-pending",
    "import.task-running",
    "import.task-failed",
    "import.task-skipped",
    "import.task-rolled-back",
    "import.task-failed-verify",
    "import.task-awaiting-cutover",
    "import.task-cancelled",
  ],
  // step-utils.ts failureOf: `${prefix}.failed` (expanded below from the prefixes the scan finds at every `failureOf(e, prefix)` call)
  "${prefix}.failed": [],
  // step-utils.ts failureOf, the other two shapes: the suffix is the importer's own error code or the HTTP status of a service
  // that refused, so the vocabulary is open-ended by design. They are not localized one by one: the web shows the humanized
  // code (derived from the code itself) for them, and the `.failed` fallback above has its sentence.
  "${prefix}.${frag(code)}": [],
  "${prefix}.http-${status}": [],
};

/** Property names whose value is a code. */
const CODE_PROPS = new Set(["code", "lastError", "failureCode"]);
/** Calls whose argument at this index is a code. A negative index counts from the end. */
const CODE_ARGS: Record<string, number> = { chk: 2, requireOpId: 1, failureGate: 0, failStep: 2, event: 2, timerGate: -1 };

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "testing" ? [] : sources(p);
    return p.endsWith(".ts") && !p.endsWith(".spec.ts") ? [p] : [];
  });
}

interface Found {
  literals: Map<string, string>;
  templates: Map<string, string>;
  /** The prefix argument of every `failureOf(error, prefix)` call. */
  failurePrefixes: Map<string, string>;
}

/** Collect the code-valued expressions below `node`: literals, both ternary branches, parentheses; a template is recorded as text. */
function collect(node: ts.Expression, file: string, out: Found, src: ts.SourceFile): void {
  if (ts.isStringLiteralLike(node)) {
    if (CODE_RE.test(node.text)) out.literals.set(node.text, file);
  } else if (ts.isTemplateExpression(node)) out.templates.set(node.getText(src).slice(1, -1), file);
  else if (ts.isConditionalExpression(node)) {
    collect(node.whenTrue, file, out, src);
    collect(node.whenFalse, file, out, src);
  } else if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(node.operatorToken.kind)) {
    collect(node.left, file, out, src);
    collect(node.right, file, out, src);
  } else if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) collect(node.expression, file, out, src);
  else if (ts.isObjectLiteralExpression(node)) {
    for (const p of node.properties) if (ts.isPropertyAssignment(p)) collect(p.initializer, file, out, src);
  } else if (ts.isArrayLiteralExpression(node)) for (const e of node.elements) collect(e, file, out, src);
}

function scan(): Found {
  const out: Found = { literals: new Map(), templates: new Map(), failurePrefixes: new Map() };
  for (const file of sources(ROOT)) {
    const rel = relative(ROOT, file);
    const text = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node): void => {
      if (ts.isPropertyAssignment(n) && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) && CODE_PROPS.has(n.name.text)) collect(n.initializer, rel, out, sf);
      else if (ts.isNewExpression(n) && n.expression.getText(sf) === "StepFailure" && n.arguments?.[0]) collect(n.arguments[0], rel, out, sf);
      else if (ts.isCallExpression(n)) {
        const callee = ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : ts.isIdentifier(n.expression) ? n.expression.text : "";
        if (callee === "failureOf" && n.arguments[1] && ts.isStringLiteralLike(n.arguments[1])) out.failurePrefixes.set(n.arguments[1].text, rel);
        const at = CODE_ARGS[callee];
        if (at !== undefined) {
          const arg = n.arguments[at < 0 ? n.arguments.length + at : at];
          if (arg) collect(arg, rel, out, sf);
        }
      } else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && /_CODES?$/.test(n.name.text) && n.initializer) collect(n.initializer, rel, out, sf);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

const found = scan();
const locale = JSON.parse(readFileSync(LOCALE, "utf8")) as { codes: Record<string, unknown> };
const keyOf = (code: string): string => code.replace(/\./g, "_");

/** Every code the sources emit: the literals plus the resolved templates. */
const emitted = new Map<string, string>(found.literals);
for (const [tpl, file] of found.templates) for (const c of TEMPLATE_CODES[tpl] ?? []) emitted.set(c, file);
for (const [prefix, file] of found.failurePrefixes) emitted.set(`${prefix}.failed`, file);

describe("every code the guided-migration hub can emit has an English sentence in the web locale", () => {
  it("scans a real vocabulary (not an empty or broken scan)", () => {
    expect(emitted.size).toBeGreaterThan(150);
    for (const known of ["run.created", "step.passed", "preflight.dns-zone-missing", "cutover.swap-live", "data-final.volume-diverged", "freeze.scheduled", "verify.db-parity.match", "decommission.stopped"]) {
      expect([known, emitted.has(known)]).toEqual([known, true]);
    }
  });

  it("finds every failureOf prefix (their `.failed` fallbacks are emitted codes)", () => {
    expect(found.failurePrefixes.size).toBeGreaterThanOrEqual(11);
  });

  it("every emitted code is a valid run code (lower-case dotted/dashed, at most 80 chars)", () => {
    expect([...emitted.keys()].filter((c) => !isRunCode(c))).toEqual([]);
  });

  it("every template-built code is resolved in TEMPLATE_CODES, and every entry there is still in the sources", () => {
    expect([...found.templates.keys()].filter((t) => !(t in TEMPLATE_CODES))).toEqual([]);
    expect(Object.keys(TEMPLATE_CODES).filter((t) => !found.templates.has(t))).toEqual([]);
  });

  it("every emitted code has an entry under `codes` in en/migrationRun.json (key = the code with dots as underscores)", () => {
    const missing = [...emitted.entries()].filter(([c]) => typeof locale.codes[keyOf(c)] !== "string" || (locale.codes[keyOf(c)] as string).trim() === "").map(([c, f]) => `${c}  (${f})`);
    expect(missing).toEqual([]);
  });

  it("no two codes share a locale key", () => {
    const byKey = new Map<string, string>();
    for (const c of emitted.keys()) {
      const prior = byKey.get(keyOf(c));
      expect([c, prior ?? c]).toEqual([c, c]);
      byKey.set(keyOf(c), c);
    }
  });
});
