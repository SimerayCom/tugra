import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dumpDbToStdout } from "../backups/backup-script";
import { buildMigratorRecipe, MIGRATOR_ENGINES } from "./migrator-recipe";
import type { DbEngine, DbCredentials } from "../databases/database-script";

/**
 * ZERO-DRIFT / NO-INJECTION PROOF. For each engine, run BOTH the literal dumpDbToStdout(engine,'ctr',creds)
 * and the hydrated migrator recipe through a HERMETIC simulated `docker exec` (a POSIX-sh shim that forwards
 * ONLY the -e vars, like real docker — not its whole env — plus stub dump tools), with ADVERSARIAL creds, and
 * assert the dump tool is reached with IDENTICAL argv + secret env on both paths, that no credential ever lands
 * on an argv, and that command substitution in the values never executes. A hermetic shim is essential: if it
 * leaked its env, dropping a `-e NAME` would not change the capture and the proof would be vacuous (mutation
 * test below proves it is not). Skipped on win32 (no POSIX sh).
 */

const CREDS: DbCredentials = {
  username: "u$(whoami)'\"`;x ",
  password: "p@ss'\"`$x; rm -rf /tmp/nope ",
  database: "appdb_mig1",
} as unknown as DbCredentials;

// Every field carries command substitution — used ONLY against the hydrated (served) recipe, to prove a hostile
// source host's metadata can never be turned into RCE on the migrator.
const INJECT: DbCredentials = { username: "u$(id)", password: "p$(id)", database: "d$(id)" } as unknown as DbCredentials;

const describeOrSkip = process.platform === "win32" ? describe.skip : describe;

describeOrSkip("migrator-recipe equivalence (literal dumpDbToStdout === hydrated recipe)", () => {
  let dir: string;
  let bin: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "tugra-equiv-"));
    bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });

    // HERMETIC `docker exec` shim: collect the -e vars (bare NAME → value from the shim's own env, exactly as
    // the real docker CLI reads its client env; NAME=VAL → literal), drop the container name, then run the
    // in-container command with ONLY PATH + TUGRA_CAP + those vars (env -i, then export each from a file so
    // values with spaces/quotes/$() stay literal — never sourced/evaluated).
    writeStub("docker", [
      "#!/bin/sh",
      'test "$1" = exec || { echo "shim: expected exec" >&2; exit 2; }',
      "shift",
      ': > "$TUGRA_ENVFILE"',
      "while [ $# -gt 0 ]; do",
      '  case "$1" in',
      "    -i) shift ;;",
      "    -e) shift;",
      '        case "$1" in',
      "          *=*) printf '%s\\n' \"$1\" >> \"$TUGRA_ENVFILE\" ;;",
      '          *) eval "v=\\${$1-}"; printf \'%s=%s\\n\' "$1" "$v" >> "$TUGRA_ENVFILE" ;;',
      "        esac; shift ;;",
      '    *) break ;;',
      "  esac",
      "done",
      "shift", // container name
      'exec env -i "PATH=$PATH" "TUGRA_CAP=$TUGRA_CAP" "EF=$TUGRA_ENVFILE" sh -c \'while IFS= read -r l; do [ -n "$l" ] && export "$l"; done < "$EF"; exec "$@"\' sh "$@"',
    ].join("\n"));

    const capArgv = 'printf "%s ARGV:" "$TOOL" >> "$TUGRA_CAP"; for a in "$@"; do printf " [%s]" "$a" >> "$TUGRA_CAP"; done; printf "\\n" >> "$TUGRA_CAP"';
    const capEnv = (vars: string[]) => vars.map((v) => `printf "${v}=[%s]\\n" "\${${v}-}" >> "$TUGRA_CAP"`).join("; ");

    writeStub("pg_dump", ["#!/bin/sh", "TOOL=pg_dump", capArgv, capEnv(["PGPASSWORD"]), "printf DUMPDATA"].join("\n"));
    writeStub("mysqldump", ["#!/bin/sh", "TOOL=mysqldump", capArgv, capEnv(["MYSQL_PWD"]), "printf DUMPDATA"].join("\n"));
    writeStub("mariadb-dump", ["#!/bin/sh", "TOOL=mariadb-dump", capArgv, capEnv(["MYSQL_PWD"]), "printf DUMPDATA"].join("\n"));
    for (const t of ["redis-cli", "keydb-cli"]) {
      writeStub(t, ["#!/bin/sh", `TOOL=${t}`, capArgv, capEnv(["REDISCLI_AUTH"]), "echo OK"].join("\n"));
    }
    writeStub("cat", ["#!/bin/sh", "printf DUMPDATA"].join("\n"));
    writeStub("rm", "#!/bin/sh\nexit 0");
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function writeStub(name: string, body: string): void {
    const p = join(bin, name);
    writeFileSync(p, body + "\n");
    chmodSync(p, 0o755);
  }

  function childEnv(engine: DbEngine, mode: string, creds: DbCredentials, binds: { name: string; from: string }[]): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      TUGRA_CAP: join(dir, `cap-${engine}-${mode}.txt`),
      TUGRA_ENVFILE: join(dir, `env-${engine}-${mode}.txt`),
      TUGRA_SRC_CTR: "ctr",
      TUGRA_SRC_USER: creds.username,
      TUGRA_SRC_DB: creds.database,
    };
    for (const b of binds) env[b.name] = b.from === "pw" ? creds.password : b.from === "user" ? creds.username : creds.database;
    return env;
  }

  function run(command: string, env: NodeJS.ProcessEnv): string {
    const cap = env.TUGRA_CAP as string;
    if (existsSync(cap)) rmSync(cap);
    execFileSync("/bin/sh", ["-c", command], { env, stdio: ["ignore", "ignore", "ignore"] });
    return existsSync(cap) ? readFileSync(cap, "utf8") : "";
  }

  function runLiteral(engine: DbEngine, creds: DbCredentials): string {
    return run(dumpDbToStdout(engine, "ctr", creds), childEnv(engine, "literal", creds, []));
  }
  function runHydrated(engine: DbEngine, creds: DbCredentials): string {
    const r = buildMigratorRecipe(engine);
    return run(r.command, childEnv(engine, "hydrated", creds, r.env));
  }

  it.each(MIGRATOR_ENGINES)("%s: hydrated recipe reaches the dump tool identically to the literal dump", (engine) => {
    const capA = runLiteral(engine, CREDS);
    const capB = runHydrated(engine, CREDS);

    // 1) byte-identical argv + secret env on both paths
    expect(capB).toBe(capA);
    expect(capA.length).toBeGreaterThan(0);

    // 2) no credential is EVER on an ARGV line — secrets travel only on ENV lines (true for all 6 served engines)
    for (const line of capA.split("\n")) {
      if (line.includes("ARGV:")) expect(line).not.toContain(CREDS.password);
    }

    // 3) the password DID travel via env for the server-authenticated engines
    if (engine !== "REDIS" && engine !== "KEYDB" && engine !== "DRAGONFLY") {
      expect(capA).toContain(CREDS.password);
    } else {
      expect(capA).toContain(`REDISCLI_AUTH=[${CREDS.password}]`); // redis family: pw reaches the cli via env
    }
  });

  it.each(MIGRATOR_ENGINES)("%s: the hydrated recipe resists command injection in a hostile source's metadata", (engine) => {
    const cap = runHydrated(engine, INJECT);
    expect(cap).not.toContain("uid="); // `id` never ran
    expect(cap).toContain("$(id)"); // the substitution text survived as literal data
  });

  it("the shim is hermetic — dropping a -e NAME stops the var reaching the tool (so the proof is not vacuous)", () => {
    const r = buildMigratorRecipe("POSTGRES");
    const env = childEnv("POSTGRES", "mutation", CREDS, r.env); // child env still HAS PGPASSWORD set…
    const broken = r.command.replace("-e PGPASSWORD ", ""); // …but the command no longer forwards it
    const cap = run(broken, env);
    expect(cap).toContain("PGPASSWORD=[]"); // empty → real docker-style isolation, not an env leak
    // sanity: the intact recipe DOES deliver it
    expect(runHydrated("POSTGRES", CREDS)).toContain(`PGPASSWORD=[${CREDS.password}]`);
  });
});
