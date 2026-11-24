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

// MongoDB and ClickHouse are NOT rendered from the backup commands (those put the password on the client's argv): their recipes are
// hand-written and proven by the bespoke block below.
const DERIVED_ENGINES = MIGRATOR_ENGINES.filter((e) => e !== "MONGO" && e !== "CLICKHOUSE");

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
    // mongodump: answers --help like the real tool, else records its argv, the mode and content of the --config file it was handed
    writeStub(
      "mongodump",
      [
        "#!/bin/sh",
        'case "$*" in *--help*) echo "      --config=  path to a configuration file"; exit 0;; esac',
        "TOOL=mongodump",
        capArgv,
        'f=""; while [ $# -gt 0 ]; do case "$1" in --config) f="$2"; shift;; esac; shift; done',
        'printf "CFGMODE=[%s]\\n" "$(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f")" >> "$TUGRA_CAP"',
        'printf "CFG=[%s]\\n" "$(/bin/cat "$f")" >> "$TUGRA_CAP"',
        'printf "CFGPATH=[%s]\\n" "$f" >> "$TUGRA_CAP"',
        "printf DUMPDATA",
      ].join("\n"),
    );
    writeStub("cat", ["#!/bin/sh", "printf DUMPDATA"].join("\n"));
    // clickhouse-client: answers the readiness probe, records the config file it was handed and the statement
    writeStub(
      "clickhouse-client",
      [
        "#!/bin/sh",
        'cfg=""; q=""; while [ $# -gt 0 ]; do case "$1" in --config-file) cfg="$2"; shift;; --query) q="$2"; shift;; esac; shift; done',
        'printf "CFG=[%s]\\n" "$(/bin/cat "$cfg")" >> "$TUGRA_CAP"',
        'printf "QUERY=[%s]\\n" "$q" >> "$TUGRA_CAP"',
        'echo 1',
      ].join("\n"),
    );
    // `rm` is inert, except for the config files the argv-safe bodies create (their removal is part of what is proven)
    writeStub("rm", '#!/bin/sh\ncase "$*" in *tugra-dbcfg*) exec /bin/rm "$@";; esac\nexit 0');
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

  it.each(DERIVED_ENGINES)("%s: hydrated recipe reaches the dump tool identically to the literal dump", (engine) => {
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

  it.each(DERIVED_ENGINES)("%s: the hydrated recipe resists command injection in a hostile source's metadata", (engine) => {
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

  describe("MongoDB and ClickHouse recipes (hand-written, argv-safe)", () => {
    const fieldOf = (cap: string, name: string): string => new RegExp(`${name}=\\[([^\\n]*)\\]`).exec(cap)?.[1] ?? "";

    it("MONGO: the client gets only --config <file> and the user; the file is 0600, carries the password YAML-escaped and is removed", () => {
      const cap = runHydrated("MONGO", CREDS);
      const argvLine = cap.split("\n").find((l) => l.includes("ARGV:")) as string;
      expect(argvLine).toContain("[--config] [");
      expect(argvLine).toContain("[--username] [u$(whoami)'\"`;x ] [--authenticationDatabase] [admin] [--archive]");
      expect(argvLine).not.toContain("--password");
      expect(argvLine).not.toContain("p@ss");
      expect(fieldOf(cap, "CFGMODE")).toBe("600");
      // YAML double-quoted scalar: `\` and `"` are escaped, everything else is literal data
      expect(cap).toContain('CFG=[password: "p@ss\'\\"`$x; rm -rf /tmp/nope "]');
      expect(existsSync(fieldOf(cap, "CFGPATH"))).toBe(false); // gone on exit
    });

    it("MONGO: a hostile user or password never executes (command substitution stays data)", () => {
      const cap = runHydrated("MONGO", INJECT);
      expect(cap).not.toContain("uid=");
      expect(cap).toContain("[--username] [u$(id)]");
      expect(cap).toContain('CFG=[password: "p$(id)"]');
    });

    it("MONGO: the password is not in the shim's forwarded environment under any other name (only TUGRA_DB_PW is bound)", () => {
      const r = buildMigratorRecipe("MONGO");
      expect(r.env).toEqual([{ name: "TUGRA_DB_PW", from: "pw" }]);
      // dropping the bound -e makes the script find no password: it writes an empty one instead of reaching for another source
      const cap = run(r.command.replace("-e TUGRA_DB_PW ", ""), childEnv("MONGO", "mutation", CREDS, r.env));
      expect(cap).toContain('CFG=[password: ""]');
    });

    it("CLICKHOUSE: user and database are positional words, a hostile value stays data", () => {
      const r = buildMigratorRecipe("CLICKHOUSE");
      expect(r.command).toContain('tugra-clickhouse "$TUGRA_SRC_USER" "$TUGRA_SRC_DB"');
      // the host paths of a real ClickHouse (/var/lib/clickhouse) do not exist here: the body stops after its config file is made and the
      // readiness probe has answered, which is enough to prove the shell never evaluated the hostile words
      const env = childEnv("CLICKHOUSE", "hydrated", INJECT, r.env);
      const cap = env.TUGRA_CAP as string;
      if (existsSync(cap)) rmSync(cap);
      try {
        execFileSync("/bin/sh", ["-c", r.command], { env, stdio: ["ignore", "ignore", "ignore"], timeout: 20000 });
      } catch {
        /* the stubbed host has no /var/lib/clickhouse/backups */
      }
      const out = existsSync(cap) ? readFileSync(cap, "utf8") : "";
      expect(out).not.toContain("uid=");
      expect(out).toContain('CFG=[<clickhouse><user>u$(id)</user><password>p$(id)</password></clickhouse>]');
    });
  });
});
