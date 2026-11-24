import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildDetectScript, buildReadScript, CFY } from "./coolify-read-script";
import { SECTIONS } from "./coolify-sql";
import { buildInventory, parseRead } from "./coolify-inventory";
import { SECTION_ROWS } from "./coolify-fixture";

const sh = (script: string) => spawnSync("sh", ["-n"], { input: script, encoding: "utf8" });

describe("coolify read script", () => {
  const script = buildReadScript();

  it("is valid shell, for the read and for the detect-only script", () => {
    expect(sh(script).status).toBe(0);
    expect(sh(buildDetectScript()).status).toBe(0);
  });

  it("is a constant: it only names the coolify-db container and is read-only", () => {
    expect(buildReadScript()).toBe(script);
    expect(script).toContain("PGOPTIONS=\"-c default_transaction_read_only=on");
    expect(script).not.toMatch(/docker (rm|run|stop|start|restart|cp|commit|kill|pause|network|volume)/);
    expect([...script.matchAll(/docker exec [^\n]*? (\S+) sh -c/g)].every((m) => m[1] === "coolify-db")).toBe(true);
    // The database password and APP_KEY are never touched or printed.
    expect(script).not.toMatch(/APP_KEY|POSTGRES_PASSWORD|PGPASSWORD|\.env\b/);
  });

  it("runs one query per section, each from a quoted heredoc", () => {
    expect([...script.matchAll(/^q (\w+) <<'TUGRA_CFY_SQL'$/gm)].map((m) => m[1])).toEqual(SECTIONS.map((s) => s.name));
  });

  describe("run against a stand-in docker", () => {
    function run(canned: Record<string, string>, opts: { running?: string; roAnswer?: string } = {}) {
      const dir = mkdtempSync(path.join(tmpdir(), "cfy-"));
      // The stand-in answers `docker inspect` and returns canned JSON per table for `docker exec ... psql`.
      const fake = `#!/bin/sh
case "$1" in
  inspect)
    case "$*" in
      *State.Running*) echo ${opts.running ?? "true"} ;;
      *coolify-db*) echo postgres:16-alpine ;;
      *) echo ghcr.io/coollabsio/coolify:4.0.0-beta.999 ;;
    esac ;;
  exec)
    sql=$(cat)
    case "$sql" in
      *transaction_read_only*) echo ${opts.roAnswer ?? "on"} ;;
${Object.entries(canned)
  .map(([table, json]) => `      *"from public.${table} t"*) printf '%s\\n' '${json}' ;;`)
  .join("\n")}
      *) echo 'ERROR: relation does not exist' >&2; exit 3 ;;
    esac ;;
esac
`;
      writeFileSync(path.join(dir, "docker"), fake);
      chmodSync(path.join(dir, "docker"), 0o755);
      const test = script.replace(/^export PATH=.*$/m, `export PATH=${dir}:/usr/bin:/bin`);
      return spawnSync("sh", ["-c", test], { encoding: "utf8" }).stdout;
    }

    it("frames each section, skips a table this version lacks, and the output parses into an inventory", () => {
      const canned: Record<string, string> = {};
      for (const s of SECTIONS) {
        const rows = SECTION_ROWS[s.name];
        if (rows) canned[s.table] = JSON.stringify(rows).replace(/'/g, "");
      }
      const out = run(canned);
      expect(out).toContain("TUGRA_CFY_RO on");
      expect(out).toContain(`${CFY.skip}docker_swarm`);
      const read = parseRead(out);
      const { data } = buildInventory(read);
      expect(data.servers.map((s) => s.name)).toEqual(["localhost", "edge", "builder"]);
      expect(data.unavailable).toContain("docker_swarm");
    });

    it("reports a missing or stopped Coolify database instead of reading", () => {
      expect(run({}, { running: "false" })).toContain(CFY.stopped);
    });

    it("refuses a session that did not confirm read-only", () => {
      expect(() => parseRead(run({}, { roAnswer: "off" }))).toThrow("not_read_only");
    });
  });
});
