import { buildImporterDump } from "./db-dump";
import type { DumpFormat } from "./import-source";
import type { DbEngine } from "../databases/database-script";

/**
 * Migrator dump RECIPES — the per-engine `docker exec …` command the one-click migrator runs on the UNTRUSTED
 * source host to stream a DB dump to the hub. It is NOT a second set of dump commands: each recipe is produced
 * by rendering Tugra's own {@link buildImporterDump} (→ dumpDbToStdout) with alphanumeric SENTINEL credentials
 * and then rewriting those sentinels into shell env references. So the dump FORMAT always matches what the
 * hub's restore (importFromUrl) consumes, and there is a single source of truth for the dump commands.
 *
 * Invariants that make this safe to serve to, and run on, an untrusted host:
 *  - NO credential is ever inlined into the command text. Every secret is forwarded with `docker exec -e NAME`
 *    (from the migrator's child env, read locally via `docker inspect`), so it never lands on an argv that host
 *    `ps` / /proc/<pid>/cmdline can read, and it never reaches the hub. (ClickHouse is NOT served here for
 *    exactly this reason — see MIGRATOR_UNSUPPORTED.)
 *  - Credential VALUES travel ONLY via env; the command text references them as `"$TUGRA_SRC_CTR/USER/DB"`
 *    (host-expanded, so a `$(…)` in a value is inert) or as a bound `-e NAME`. The password is never a
 *    host-expanded `$TUGRA_SRC_*`, so it is never put on the docker-client argv either.
 *  - Build fails LOUD on drift: a surviving sentinel, a sentinel nested inside an in-container `sh -c` body, a
 *    `$TUGRA_SRC_*` landing inside a single-quoted span, or a POSTGRES format that is not pg_custom all throw.
 *
 * THE GO CONTRACT (the `migrate` subcommand MUST, and its tests MUST prove):
 *  - Build the dump child's env from an ALLOWLIST (PATH, HOME, DOCKER_HOST, …) — never os.Environ() wholesale —
 *    then set TUGRA_SRC_CTR/USER/DB and each {@link RecipeEnvBind} name. OMIT (do not blank) a binding whose
 *    credential is unresolved, so a `-e NAME` falls back to the container's own value instead of blanking it.
 *  - Accept `-e NAME` only for a name in {@link RECIPE_VARS} or a recipe's env[]; reject any other.
 *  - VALIDATE the resolved container/user/db before use (docker name charset, non-empty, NOT starting with `-`)
 *    so a hostile value cannot be read as a tool/docker option; the recipe quotes them but cannot stop that.
 *  - Reject a command containing a newline or NUL; never log the child env or the command's resolved values.
 */

// Sentinel credential values threaded through the real dump builder. Plain [A-Z_] so shq() only wraps them in
// single quotes — a fixed, known textual shape to rewrite. Distinct suffixes so no sentinel is a substring of
// another.
const SENT = { CTR: "TUGRA_SENT_CTR", USER: "TUGRA_SENT_USER", PW: "TUGRA_SENT_PW", DB: "TUGRA_SENT_DB" } as const;

/** The container-side variables the migrator populates (from a local `docker inspect`) and a dump command may
 *  reference as `"$TUGRA_SRC_*"`. The PASSWORD is deliberately NOT here: it travels only under a bound -e name
 *  (PGPASSWORD / MYSQL_PWD / REDISCLI_AUTH), never as a host-expanded ref. The Go side mirrors this list. */
export const RECIPE_VARS = ["TUGRA_SRC_CTR", "TUGRA_SRC_USER", "TUGRA_SRC_DB"] as const;

export interface RecipeEnvBind {
  /** The env var name forwarded into the source container via `docker exec -e NAME`. */
  name: string;
  /** Which locally-resolved credential field the migrator binds to it. */
  from: "user" | "pw" | "db";
}

export interface MigratorRecipe {
  /** `docker exec …` dump command referencing only $TUGRA_SRC_* — never an inlined secret. */
  command: string;
  /** The dump format — identical to what the hub's restore (importFromUrl) consumes for this engine. */
  format: DumpFormat;
  /** POSTGRES only: the dump is a custom-format archive → the restore is told format=custom. */
  pgFormat?: "custom";
  /** Values the migrator forwards into the container with `-e NAME` (so they stay off the argv). */
  env: RecipeEnvBind[];
}

/**
 * Engines whose logical dump the migrator can stream, keeping every secret off every argv (host AND container).
 * CLICKHOUSE and MONGO are deferred to S4b: ClickHouse's clickhouse-client takes `--password` on the argv
 * (host-`ps`-visible inside the container) and its archive restore needs a matching DB name; mongodump has the
 * same argv exposure. Both need a bespoke, argv-safe reconstruction. LIBSQL has no logical dump.
 */
export const MIGRATOR_ENGINES: DbEngine[] = ["POSTGRES", "MYSQL", "MARIADB", "REDIS", "KEYDB", "DRAGONFLY"];

/** Engines the migrator CANNOT stream yet, with a machine-readable reason — so the endpoint + the Go side skip
 *  them EXPLICITLY (a missing recipe must never read as an empty, silently-successful dump). */
export const MIGRATOR_UNSUPPORTED: Record<string, string> = {
  CLICKHOUSE: "requires-S4b", // --password on the in-container argv + source/target DB-name match
  MONGO: "requires-S4b", // --password on the in-container argv + archive namespace match
  LIBSQL: "no-logical-dump", // single SQLite file — moved by a volume copy, not a logical dump
};

/** Build the migrator dump recipe for one engine (throws for an engine the migrator does not yet stream). */
export function buildMigratorRecipe(engine: DbEngine): MigratorRecipe {
  if (!MIGRATOR_ENGINES.includes(engine)) {
    throw new Error(`migrator recipe not available for ${engine}${MIGRATOR_UNSUPPORTED[engine] ? ` (${MIGRATOR_UNSUPPORTED[engine]})` : ""}`);
  }
  const plan = buildImporterDump(engine, SENT.CTR, { username: SENT.USER, password: SENT.PW, database: SENT.DB });
  assertSentinelsNotNested(engine, plan.command);

  let cmd = plan.command;
  const env: RecipeEnvBind[] = [];

  // Step 1 — lift the SECRET off the argv: an inlined `-e NAME='SENT_PW'` becomes a bare `-e NAME` passthrough
  // (docker forwards it from the migrator's child env). Each is present for exactly its own engine(s).
  cmd = liftSecretFlag(cmd, `-e PGPASSWORD='${SENT.PW}'`, "-e PGPASSWORD", env, { name: "PGPASSWORD", from: "pw" });
  cmd = liftSecretFlag(cmd, `-e MYSQL_PWD='${SENT.PW}'`, "-e MYSQL_PWD", env, { name: "MYSQL_PWD", from: "pw" });
  cmd = liftSecretFlag(cmd, `-e 'REDISCLI_AUTH=${SENT.PW}'`, "-e REDISCLI_AUTH", env, { name: "REDISCLI_AUTH", from: "pw" });

  // Step 2 — the remaining NON-secret sentinels → host-expanded "$TUGRA_SRC_*" references.
  cmd = cmd.replaceAll(`'${SENT.USER}'`, `"$TUGRA_SRC_USER"`);
  cmd = cmd.replaceAll(`'${SENT.DB}'`, `"$TUGRA_SRC_DB"`);
  cmd = cmd.replaceAll(SENT.CTR, `"$TUGRA_SRC_CTR"`);

  // Step 3 — fail LOUD on any drift that could carry a plaintext secret or re-parse a value as code.
  if (cmd.includes("TUGRA_SENT_")) {
    throw new Error(`migrator recipe rewrite left a sentinel for ${engine}; the dump recipe shape changed — update migrator-recipe.ts`);
  }
  if (!cmd.startsWith("docker exec ")) {
    throw new Error(`migrator recipe for ${engine} must start with 'docker exec '`);
  }
  if (cmd.includes("TUGRA_SRC_PW")) {
    throw new Error(`migrator recipe for ${engine} must not reference the password as a host-expanded var`);
  }
  assertRefsOutsideSingleQuotes(engine, cmd);

  const pgFormat = engine === "POSTGRES" ? pgFormatFor(engine, plan.format) : undefined;
  return { command: cmd, format: plan.format, pgFormat, env };
}

/** All migrator recipes, keyed by engine — the data `GET /import/migration/recipes` serves. */
export function buildAllMigratorRecipes(): Record<string, MigratorRecipe> {
  const out: Record<string, MigratorRecipe> = {};
  for (const engine of MIGRATOR_ENGINES) out[engine] = buildMigratorRecipe(engine);
  return out;
}

/** Replace a single inlined `-e NAME='SENT_PW'` with its bare passthrough, recording the env binding. A no-op
 *  (no binding) when this engine's command does not use the flag. */
function liftSecretFlag(cmd: string, needle: string, replacement: string, env: RecipeEnvBind[], bind: RecipeEnvBind): string {
  if (!cmd.includes(needle)) return cmd;
  env.push(bind);
  return cmd.replace(needle, replacement);
}

/** POSTGRES: derive the restore format hint from the dump format, so a change to the dump (e.g. -Fc → plain)
 *  can never leave the hint stale. */
function pgFormatFor(engine: DbEngine, format: DumpFormat): "custom" {
  if (format !== "pg_custom") {
    throw new Error(`migrator recipe for ${engine} expected pg_custom, got ${format}; update the format mapping`);
  }
  return "custom";
}

/** Reject a credential sentinel nested inside an in-container `sh -c` body (its own single quotes escaped as
 *  `'\''…'\''`): the context-blind rewrite below would host-expand it into container-script TEXT, re-parsed as
 *  code. No current engine does this; this keeps "fail loud on shape change" honest if one ever changes. */
function assertSentinelsNotNested(engine: DbEngine, command: string): void {
  for (const s of [SENT.USER, SENT.DB, SENT.CTR]) {
    if (command.includes(`\\''${s}`) || command.includes(`${s}'\\'`)) {
      throw new Error(`migrator recipe for ${engine}: a credential sentinel is nested inside an in-container sh -c body — it needs an engine-specific, argv-safe rewrite`);
    }
  }
}

/** After rewriting, assert every `$TUGRA_SRC_*` reference sits OUTSIDE a single-quoted span (host-expanded as a
 *  double-quoted word or bare), never inside an `sh -c '…'` body where the host would splice its value into
 *  code the container shell re-parses. A tiny POSIX quote-state scan (single quotes are literal-only; inside a
 *  single-quoted span nothing, not even a double quote, ends it except a closing single quote). */
function assertRefsOutsideSingleQuotes(engine: DbEngine, cmd: string): void {
  let state: "none" | "single" | "double" = "none";
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (state === "single") {
      // inside a single-quoted span: only a closing single quote ends it. A $TUGRA_SRC_* here would be spliced
      // (host-expanded) into text the container shell re-parses — reject it.
      if (c === "'") state = "none";
      else if (c === "$" && cmd.startsWith("$TUGRA_SRC_", i)) {
        throw new Error(`migrator recipe for ${engine}: a $TUGRA_SRC_* reference sits inside a single-quoted span and would be re-parsed in-container`);
      }
      continue;
    }
    // top level or inside double quotes: a $TUGRA_SRC_* is a safe host-expanded word, nothing to check
    if (c === "'") state = "single";
    else if (c === '"') state = state === "double" ? "none" : "double";
    else if (c === "\\") i++; // skip an escaped char
  }
}
