/**
 * Resolved compose preview (secret-free). The agent runs `docker compose config --no-interpolate`: anchors, `extends`
 * and normalisation are resolved, but `${VAR}` is NEVER substituted, so no env value is sent to the agent or returned.
 * The output is then redacted on the hub (literal environment / build-arg values, plus any known env value found
 * anywhere in the document). Nothing here touches a live compose / clone dir: all work happens in a private temp dir
 * that is registered in TUGRA_SEC_DIRS, so the shared EXIT trap (also re-installed by gitCloneSteps) removes it.
 */

import { UnprocessableEntityException } from "@nestjs/common";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { gitCloneSteps, shq, type AppSpec } from "./deploy-script";
import { assertScriptFits } from "./env-render";
import { COMPOSE_RENDERED_MARKER, COMPOSE_SHA_MARKER, symlinkGuardSteps } from "./compose-git";
import { composeProject, isGitCompose } from "./compose-script";

/** The endpoint response. `resolvedCompose` is the REDACTED text; variables are shown unresolved. */
export const ComposePreviewResultSchema = z.object({
  resolvedCompose: z.string(),
  services: z.array(z.string()),
  sha256: z.string(),
  redactions: z.number().int(),
  warnings: z.array(z.string()),
  generatedAt: z.string(),
});
export type ComposePreviewResult = z.infer<typeof ComposePreviewResultSchema>;

export const PREVIEW_ERR_MARKER = "TUGRA_PREVIEW_ERR_B64=";
export const PREVIEW_UNSUPPORTED_MARKER = "TUGRA_PREVIEW: unsupported";
export const REDACTED = "<redacted>";

/** The private work dir (hub cuid only, so no user value reaches a path). */
export function composePreviewDir(app: { id: string }): string {
  return `/etc/tugra/builds/.cprev-${app.id}`;
}

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

export function buildComposePreviewScript(app: AppSpec): string {
  const pv = composePreviewDir(app);
  const proj = composeProject(app);
  const lines = [
    "set -e",
    "mkdir -p /etc/tugra/builds",
    // Sweep what a SIGKILLed earlier run left behind (the EXIT trap cannot run then); age-gated, best-effort.
    "find /etc/tugra/builds -maxdepth 1 -name '.cprev-*' -mmin +60 -exec rm -rf {} + 2>/dev/null || true",
    `PV=${shq(pv)}`,
    'rm -rf "$PV" && mkdir -p "$PV" && chmod 700 "$PV"',
    // Same variable + trap as secretsDirPrelude: gitCloneSteps APPENDS its own dir and re-installs this identical trap.
    'TUGRA_SEC_DIRS="$PV"',
    "trap 'rm -rf $TUGRA_SEC_DIRS' EXIT INT TERM HUP",
    `docker compose config --help 2>&1 | grep -q -- '--no-interpolate' || { echo "${PREVIEW_UNSUPPORTED_MARKER}"; exit 2; }`,
  ];
  const fail = `{ echo "${PREVIEW_ERR_MARKER}$(head -c 2000 "$PV/err" | base64 | tr -d '\\n')"; exit 1; }`;
  if (isGitCompose(app)) {
    const clone = `${pv}/c`;
    const rel = (app.composePath as string).replace(/^\/+/, "");
    lines.push(
      `CLONE=${shq(clone)}`,
      ...gitCloneSteps(app, clone), // hub-built cuid path: no metacharacters (same as the deploy clone)
      ...symlinkGuardSteps(),
      `TUGRA_R=$(docker compose -p ${proj} -f ${shq(`${clone}/${rel}`)} config --no-interpolate 2>"$PV/err") || ${fail}`,
    );
  } else {
    lines.push(
      `printf %s ${shq(b64(app.composeFile ?? ""))} | base64 -d > "$PV/docker-compose.yml"`,
      `TUGRA_R=$(docker compose -p ${proj} -f "$PV/docker-compose.yml" config --no-interpolate 2>"$PV/err") || ${fail}`,
    );
  }
  lines.push(
    `printf '%s%s\\n' "${COMPOSE_RENDERED_MARKER}" "$(printf %s "$TUGRA_R" | base64 | tr -d '\\n')"`,
    `printf '%s%s\\n' "${COMPOSE_SHA_MARKER}" "$(printf %s "$TUGRA_R" | sha256sum | cut -d' ' -f1)"`,
  );
  const script = lines.join("\n");
  assertScriptFits(script);
  return script;
}

/** The decoded `TUGRA_PREVIEW_ERR_B64=` line (capped), or null. */
export function parsePreviewError(output: string): string | null {
  for (const line of output.split("\n")) {
    const t = line.trim();
    if (t.startsWith(PREVIEW_ERR_MARKER)) {
      const v = t.slice(PREVIEW_ERR_MARKER.length).trim();
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(v)) return null;
      return Buffer.from(v, "base64").toString("utf8").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, 2000);
    }
  }
  return null;
}

/** Maps the raw `docker compose config` stderr to a CLOSED message set. The raw text is never returned: with an
 *  `env_file` pointing at a host path the error can echo a line of that file (or confirm it exists). The set:
 *  an unreadable env_file, invalid YAML (with the line number only), or a generic rejection. */
export function classifyPreviewError(raw: string): string {
  if (/env[_ -]?file|dotenv|failed to read|no such file|permission denied|unexpected character|\.env\b/i.test(raw)) {
    return "an env_file could not be read";
  }
  if (/yaml|did not find expected|mapping values|cannot unmarshal|line \d+/i.test(raw)) {
    const line = /line (\d{1,6})/i.exec(raw)?.[1];
    return line ? `the file is not valid YAML (near line ${line})` : "the file is not valid YAML";
  }
  return "docker compose rejected the file";
}

// A value that is only an interpolation reference is not a secret (the preview shows variables UNRESOLVED).
const PURE_REF = /^(?:\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*)$/;
const MIN_KNOWN_LEN = 6;

interface Counter {
  n: number;
}

function redactEnvValue(v: unknown, c: Counter): unknown {
  if (v === null || v === undefined || v === "") return v;
  if (typeof v === "string" && PURE_REF.test(v)) return v;
  c.n++;
  return REDACTED;
}

/** environment / build.args in map or `K=V` list form. Keeps key names, redacts literal values. */
function redactKv(block: unknown, c: Counter): unknown {
  if (Array.isArray(block)) {
    return block.map((item) => {
      if (typeof item !== "string") return item;
      const i = item.indexOf("=");
      if (i < 0) return item; // bare `KEY`: passes the host value through at runtime, nothing literal in the file
      const val = item.slice(i + 1);
      const r = redactEnvValue(val, c);
      return r === val ? item : `${item.slice(0, i)}=${r}`;
    });
  }
  if (block && typeof block === "object") {
    return Object.fromEntries(Object.entries(block as Record<string, unknown>).map(([k, v]) => [k, redactEnvValue(v, c)]));
  }
  return block;
}

function scrub(node: unknown, known: string[], c: Counter): unknown {
  if (typeof node === "string") {
    let out = node;
    for (const k of known) {
      if (!out.includes(k)) continue;
      const parts = out.split(k);
      c.n += parts.length - 1;
      out = parts.join(REDACTED);
    }
    return out;
  }
  if (Array.isArray(node)) return node.map((n) => scrub(n, known, c));
  if (node && typeof node === "object") {
    return Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, scrub(v, known, c)]));
  }
  return node;
}

/** Redact the resolved compose. Literal `environment` / `build.args` values become `<redacted>` (a pure `${REF}`,
 *  an empty or a null value stays), then every occurrence of a known env value (>= 6 chars, longest first) anywhere
 *  else in the document is scrubbed. Throws 422 when the text is not parseable. */
export function redactResolvedCompose(yamlText: string, knownValues: string[]): { yaml: string; redactions: number } {
  let doc: unknown;
  try {
    doc = parse(yamlText, { merge: true });
  } catch {
    throw new UnprocessableEntityException("the resolved compose could not be parsed");
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new UnprocessableEntityException("the resolved compose is not a mapping");
  const c: Counter = { n: 0 };
  const root = doc as Record<string, unknown>;
  const services = root.services;
  if (services && typeof services === "object" && !Array.isArray(services)) {
    for (const def of Object.values(services as Record<string, unknown>)) {
      if (!def || typeof def !== "object" || Array.isArray(def)) continue;
      const d = def as Record<string, unknown>;
      if (d.environment !== undefined) d.environment = redactKv(d.environment, c);
      const build = d.build;
      if (build && typeof build === "object" && !Array.isArray(build) && (build as Record<string, unknown>).args !== undefined) {
        (build as Record<string, unknown>).args = redactKv((build as Record<string, unknown>).args, c);
      }
    }
  }
  const known = [...new Set(knownValues.filter((v) => typeof v === "string" && v.length >= MIN_KNOWN_LEN))].sort((a, b) => b.length - a.length);
  const cleaned = known.length ? scrub(root, known, c) : root;
  // aliasDuplicateObjects:false -> a shared object is written out again instead of `&a1` / `*a1` anchors.
  return { yaml: stringify(cleaned, { aliasDuplicateObjects: false }), redactions: c.n };
}

/** The repo path inside the temp clone the git preview reads (for the display-only assertSafeCompose check). */
export function composePreviewCloneRoot(app: { id: string }): string {
  return `${composePreviewDir(app)}/c`;
}

