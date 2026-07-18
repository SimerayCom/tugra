import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const UPDATE_SH = join(__dirname, "..", "..", "..", "..", "scripts", "update.sh");
const source = readFileSync(UPDATE_SH, "utf8");

describe("scripts/update.sh", () => {
  it("is valid bash syntax (bash -n)", () => {
    expect(() => execFileSync("bash", ["-n", UPDATE_SH], { stdio: "pipe" })).not.toThrow();
  });

  it("only ever recreates hub-api + web (never itself, postgres, or redis)", () => {
    expect(source).toContain("pull hub-api web");
    expect(source).toContain("up -d --no-deps hub-api web");
    expect(source).not.toMatch(/up -d\s*$/m); // never a bare `up -d`
  });

  it("drains the Redis job queue with a blocking pop", () => {
    expect(source).toContain("BLPOP");
    expect(source).toContain("instance:update:queue");
  });

  describe("--dry-run", () => {
    const dir = mkdtempSync(join(tmpdir(), "update-sh-"));
    const envFile = join(dir, ".env");
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    const run = (target: string, currentVersion: string): string => {
      writeFileSync(envFile, `TUGRA_VERSION=${currentVersion}\n`);
      return execFileSync("bash", [UPDATE_SH, "--dry-run", "--target", target], {
        stdio: "pipe",
        env: { PATH: process.env.PATH, ENV_FILE: envFile } as NodeJS.ProcessEnv,
      }).toString();
    };

    it("pulls + recreates hub-api/web and bumps TUGRA_VERSION for a newer target", () => {
      const out = run("0.2.0", "0.1.0");
      expect(out).toContain("SET_ENV: TUGRA_VERSION=0.2.0");
      expect(out).toContain("pull hub-api web");
      expect(out).toContain("up -d --no-deps hub-api web");
      expect(out).toContain('"phase":"done"');
      // dry-run must not have mutated the real env file
      expect(readFileSync(envFile, "utf8")).toContain("TUGRA_VERSION=0.1.0");
    });

    it("REFUSES a downgrade (defense-in-depth) — status failed, no pull", () => {
      const out = run("0.0.9", "0.1.0");
      expect(out).toContain("refusing non-newer target");
      expect(out).toContain('"phase":"failed"');
      expect(out).not.toContain("pull hub-api web");
    });

    it("refuses an equal target (no-op)", () => {
      const out = run("0.1.0", "0.1.0");
      expect(out).toContain("refusing non-newer target");
      expect(out).not.toContain("pull hub-api web");
    });

    it("does not abort under set -e when .env has no TUGRA_VERSION yet (fresh install)", () => {
      writeFileSync(envFile, "DATABASE_URL=postgres://x\n"); // a stock install: no TUGRA_VERSION line
      const out = execFileSync("bash", [UPDATE_SH, "--dry-run", "--target", "1.2.4"], {
        stdio: "pipe",
        env: { PATH: process.env.PATH, ENV_FILE: envFile } as NodeJS.ProcessEnv,
      }).toString();
      // grep found no key → the "latest" fallback runs → the guard is skipped → we reach the plan preview.
      expect(out).toContain("pull hub-api web");
      expect(out).toContain("SET_ENV: TUGRA_VERSION=1.2.4");
    });
  });
});
