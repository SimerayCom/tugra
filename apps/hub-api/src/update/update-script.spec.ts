import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const UPDATE_SH = join(__dirname, "..", "..", "..", "..", "scripts", "update.sh");
const source = readFileSync(UPDATE_SH, "utf8");

describe("scripts/update.sh", () => {
  it("is valid bash syntax (bash -n)", () => {
    expect(() => execFileSync("bash", ["-n", UPDATE_SH], { stdio: "pipe" })).not.toThrow();
  });

  it("only ever recreates hub-api + web + the local agent (never itself, postgres, or redis)", () => {
    expect(source).toContain("pull hub-api web");
    expect(source).toContain("up -d --no-deps hub-api web");
    expect(source).toContain("up -d --no-deps agent"); // refreshed only AFTER hub-api + web are healthy
    expect(source).not.toMatch(/up -d\s*$/m); // never a bare `up -d`
    // every `compose up` carries --no-deps and names one of the allowed services
    const ups = source.split("\n").filter((l) => /compose up -d/.test(l) && !l.trim().startsWith("#"));
    expect(ups.length).toBeGreaterThan(0);
    for (const l of ups) expect(l).toMatch(/up -d --no-deps (hub-api web|agent)\b/);
    const mutating = source.split("\n").filter((l) => /compose (up|restart|down|stop|rm|kill|run)\b/.test(l) && !l.trim().startsWith("#"));
    for (const l of mutating) expect(l).not.toMatch(/postgres|redis|tugra-updater/);
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

  describe("pre-update snapshot + agent refresh (H4/H6) — --dry-run", () => {
    const dir = mkdtempSync(join(tmpdir(), "update-sh-snap-"));
    const envFile = join(dir, ".env");
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const dry = (target: string, envText: string, extra: Record<string, string> = {}): string => {
      writeFileSync(envFile, envText);
      return execFileSync("bash", [UPDATE_SH, "--dry-run", "--target", target], {
        stdio: "pipe",
        env: { PATH: process.env.PATH, ENV_FILE: envFile, ...extra } as NodeJS.ProcessEnv,
      }).toString();
    };

    it("takes the pg_dump snapshot BEFORE the .env bump and the image pull", () => {
      const out = dry("0.2.0", "TUGRA_VERSION=0.1.0\n");
      const dump = out.indexOf("exec -T postgres pg_dump -U tugra -Fc tugra");
      expect(dump).toBeGreaterThan(-1);
      expect(out).toMatch(/SNAPSHOT: .*backups\/pre-update-0\.1\.0-to-0\.2\.0-\d{8}T\d{6}Z\.dump/);
      expect(dump).toBeLessThan(out.indexOf("SET_ENV: TUGRA_VERSION=0.2.0"));
      expect(dump).toBeLessThan(out.indexOf("pull hub-api web"));
    });

    it("refreshes the local agent only after the hub/web health wait, and pre-pulls the updater (never recreates it)", () => {
      const out = dry("0.2.0", "TUGRA_VERSION=0.1.0\n");
      const wait = out.indexOf("wait up to");
      const pullAgent = out.indexOf("pull agent");
      const upAgent = out.indexOf("up -d --no-deps agent");
      const done = out.indexOf('"phase":"done"');
      expect(wait).toBeGreaterThan(-1);
      expect(pullAgent).toBeGreaterThan(wait);
      expect(upAgent).toBeGreaterThan(pullAgent);
      expect(done).toBeGreaterThan(upAgent);
      expect(out).toContain("pull tugra-updater");
      expect(out).not.toMatch(/up -d[^\n]*(postgres|redis|tugra-updater)/);
      expect(out).not.toMatch(/up -d\s*$/m);
    });

    it("PRE_UPDATE_BACKUP=0 (in .env or the env) skips the dump and says so; nothing else changes", () => {
      for (const out of [dry("0.2.0", "TUGRA_VERSION=0.1.0\nPRE_UPDATE_BACKUP=0\n"), dry("0.2.0", "TUGRA_VERSION=0.1.0\n", { PRE_UPDATE_BACKUP: "0" })]) {
        expect(out).not.toContain("pg_dump");
        expect(out).toContain("WITHOUT a pre-update restore point");
        expect(out).toContain("pull hub-api web");
        expect(out).toContain('"phase":"done"');
      }
    });

    it("a refused downgrade / no-op takes NO snapshot", () => {
      const out = dry("0.0.9", "TUGRA_VERSION=0.1.0\n");
      expect(out).toContain("refusing non-newer target");
      expect(out).not.toContain("pg_dump");
      expect(out).not.toContain("SNAPSHOT:");
    });
  });

  describe("pre-update snapshot (non-dry, PATH shims for docker + redis-cli)", () => {
    const dir = mkdtempSync(join(tmpdir(), "update-sh-shim-"));
    const bin = join(dir, "bin");
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const LOG = join(dir, "calls.log");
    const BASH = execFileSync("sh", ["-c", "command -v bash"]).toString().trim();
    execFileSync("mkdir", ["-p", bin]);
    // The sidecar's REPO_DIR is derived from the script location, and a TUGRA_BACKUP_DIR must live inside it, so
    // run a COPY of the scripts from a throwaway "checkout" and keep the backup dirs inside that.
    const repo = join(dir, "repo");
    execFileSync("mkdir", ["-p", join(repo, "scripts", "lib")]);
    writeFileSync(join(repo, "scripts", "update.sh"), readFileSync(UPDATE_SH));
    writeFileSync(join(repo, "scripts", "lib", "snapshot.sh"), readFileSync(join(UPDATE_SH, "..", "lib", "snapshot.sh")));
    const SH = join(repo, "scripts", "update.sh");
    // docker: logs; pg_dump fails when SHIM_DUMP_FAIL is set; ps -q yields an id; inspect says healthy.
    writeFileSync(
      join(bin, "docker"),
      `#!/bin/bash
echo "docker $*" >> "$SHIM_LOG"
case "$1" in
  inspect) echo healthy; exit 0 ;;
  compose)
    case "$*" in
      *pg_dump*) [ -n "$SHIM_DUMP_FAIL" ] && exit 1; printf 'PGDMP-fake-dump'; exit 0 ;;
      *" ps -q "*) echo "cid-\${@: -1}"; exit 0 ;;
    esac ;;
esac
exit 0
`,
    );
    // redis-cli: logs; the FIRST BLPOP yields one job, the second exits non-zero (set -e ends the watch loop).
    writeFileSync(
      join(bin, "redis-cli"),
      `#!/bin/bash
echo "redis-cli $*" >> "$SHIM_LOG"
case "$*" in
  *BLPOP*) if [ -e "$SHIM_STATE" ]; then exit 1; fi; : > "$SHIM_STATE"; printf 'instance:update:queue\n{"targetVersion":"0.2.0"}\n'; exit 0 ;;
esac
exit 0
`,
    );
    chmodSync(join(bin, "docker"), 0o755);
    chmodSync(join(bin, "redis-cli"), 0o755);

    let n = 0;
    const watchOnce = (envText: string, extra: Record<string, string> = {}) => {
      n += 1;
      const envFile = join(dir, `.env${n}`);
      const backups = join(repo, `backups${n}`);
      writeFileSync(envFile, envText);
      writeFileSync(LOG, "");
      const r = spawnSync(BASH, [SH, "--watch"], {
        encoding: "utf8",
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          ENV_FILE: envFile,
          TUGRA_BACKUP_DIR: backups,
          SHIM_LOG: LOG,
          SHIM_STATE: join(dir, `state${n}`),
          ...extra,
        } as NodeJS.ProcessEnv,
      });
      return { r, envFile, backups, log: readFileSync(LOG, "utf8") };
    };

    it("a TUGRA_BACKUP_DIR OUTSIDE the checkout (not mounted in the sidecar) aborts: failed, nothing changed", () => {
      const { envFile, log } = watchOnce("TUGRA_VERSION=0.1.0\n", { TUGRA_BACKUP_DIR: join(dir, "elsewhere") });
      expect(log).toMatch(/SET instance:update:status .*"phase":"failed".*TUGRA_BACKUP_DIR must be inside the checkout/);
      expect(log).not.toContain("pg_dump");
      expect(log).not.toMatch(/docker compose .* pull /);
      expect(log).toContain("DEL instance:update:lock");
      expect(readFileSync(envFile, "utf8")).toContain("TUGRA_VERSION=0.1.0");
    });

    it("a relative / `..`-escaping TUGRA_BACKUP_DIR is refused too, and one inside the checkout is accepted", () => {
      for (const bad of ["relative/backups", join(repo, "..", "escape")]) {
        const { log } = watchOnce("TUGRA_VERSION=0.1.0\n", { TUGRA_BACKUP_DIR: bad });
        expect(log).toContain("TUGRA_BACKUP_DIR must be inside the checkout");
      }
      const ok = watchOnce("TUGRA_VERSION=0.1.0\n", { TUGRA_BACKUP_DIR: join(repo, "deep", "snaps") });
      expect(ok.log).toContain('"phase":"done"');
      expect(readdirSync(join(repo, "deep", "snaps")).some((f) => f.endsWith(".dump"))).toBe(true);
    });

    it("an inherited DRY=1 cannot turn the real snapshot into a dry run (the lib uses its own TUGRA_SNAPSHOT_DRY)", () => {
      const { backups, log } = watchOnce("TUGRA_VERSION=0.1.0\n", { DRY: "1", TUGRA_SNAPSHOT_DRY: "1" });
      expect(log).toContain("pg_dump");
      expect(readdirSync(backups).some((f) => f.endsWith(".dump"))).toBe(true);
    });

    it("a FAILED dump aborts the update: status failed, lock released, NO pull, .env untouched", () => {
      const { envFile, log } = watchOnce("TUGRA_VERSION=0.1.0\nOTHER=1\n", { SHIM_DUMP_FAIL: "1" });
      expect(log).not.toMatch(/docker compose .* pull /);
      expect(log).not.toContain("up -d");
      expect(log).toMatch(/SET instance:update:status .*"phase":"failed".*pre-update backup failed; nothing was changed/);
      expect(log).toContain("DEL instance:update:lock");
      expect(readFileSync(envFile, "utf8")).toContain("TUGRA_VERSION=0.1.0");
      expect(readFileSync(envFile, "utf8")).not.toContain("0.2.0");
    });

    it("a successful run writes a 0700 dir / 0600 dump + .env copy, bumps the version, refreshes the agent, ends done", () => {
      const { envFile, backups, log } = watchOnce("TUGRA_VERSION=0.1.0\nJWT_ACCESS_SECRET=abc\n");
      const files = readdirSync(backups);
      const dump = files.find((f) => f.endsWith(".dump"));
      expect(dump).toMatch(/^pre-update-0\.1\.0-to-0\.2\.0-\d{8}T\d{6}Z\.dump$/);
      expect(statSync(backups).mode & 0o777).toBe(0o700);
      expect(statSync(join(backups, dump as string)).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(backups, dump as string), "utf8").startsWith("PGDMP")).toBe(true);
      const envCopy = files.find((f) => f.endsWith(".env")) as string;
      expect(statSync(join(backups, envCopy)).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(backups, envCopy), "utf8")).toContain("TUGRA_VERSION=0.1.0"); // the PRE-update .env
      expect(files.some((f) => f.endsWith(".part"))).toBe(false);
      expect(readFileSync(envFile, "utf8")).toContain("TUGRA_VERSION=0.2.0");
      expect(log.indexOf("pg_dump")).toBeLessThan(log.indexOf(" pull hub-api web"));
      expect(log).toContain("up -d --no-deps agent");
      expect(log).toContain('"phase":"done"');
    });

    it("keeps only the newest 5 snapshot sets (PRE_UPDATE_KEEP), oldest pruned first", () => {
      n += 1;
      const backups = join(repo, `backups-keep`);
      execFileSync("mkdir", ["-p", backups]);
      for (let i = 1; i <= 6; i++) {
        const base = join(backups, `pre-update-0.0.${i}-to-0.0.${i + 1}-2020010${i}T000000Z`);
        writeFileSync(`${base}.dump`, "PGDMP-old");
        writeFileSync(`${base}.env`, "A=1\n");
        const t = new Date(`2020-01-0${i}T00:00:00Z`);
        utimesSync(`${base}.dump`, t, t);
        utimesSync(`${base}.env`, t, t);
      }
      const envFile = join(dir, ".env-keep");
      writeFileSync(envFile, "TUGRA_VERSION=0.1.0\n");
      writeFileSync(LOG, "");
      spawnSync(BASH, [SH, "--watch"], {
        encoding: "utf8",
        env: { PATH: `${bin}:${process.env.PATH}`, ENV_FILE: envFile, TUGRA_BACKUP_DIR: backups, SHIM_LOG: LOG, SHIM_STATE: join(dir, "state-keep") } as NodeJS.ProcessEnv,
      });
      const dumps = readdirSync(backups).filter((f) => f.endsWith(".dump"));
      expect(dumps.length).toBe(5);
      expect(dumps.some((f) => f.includes("0.1.0-to-0.2.0"))).toBe(true); // the new one is kept
      expect(dumps.some((f) => f.includes("0.0.1-to-"))).toBe(false); // oldest two gone…
      expect(dumps.some((f) => f.includes("0.0.2-to-"))).toBe(false);
      expect(dumps.some((f) => f.includes("0.0.6-to-"))).toBe(true); // …newest old ones kept
      expect(readdirSync(backups).filter((f) => f.endsWith(".env")).length).toBe(5); // each dump's .env goes with it
      expect(existsSync(join(backups, "pre-update-0.0.1-to-0.0.2-20200101T000000Z.env"))).toBe(false);
    });
  });

  describe("partial-failure compensation (F02)", () => {
    it("defines recover_previous and uses it in BOTH post-pull failure branches", () => {
      expect(source).toContain("recover_previous()");
      // recover restores the prev tag, recreates, AND verifies health (the old code skipped the re-check)
      // (the version + digest-pin writes live in restore_env → write_pins, which sets TUGRA_VERSION first)
      expect(source).toMatch(/recover_previous\(\)\s*\{[\s\S]*?restore_env "\$@" && compose up -d --no-deps hub-api web && wait_healthy/);
      expect(source).toMatch(/write_pins\(\)\s*\{[\s\S]*?set_env TUGRA_VERSION "\$version"/);
      // used in BOTH the recreate-fail and the health-fail branches
      expect((source.match(/if recover_previous "\$current" /g) ?? []).length).toBe(2);
      // a distinct, non-expiring recovery_required terminal state when recovery itself fails
      expect(source).toContain("set_recovery_required");
      expect(source).toMatch(/redis SET "\$STATUS_KEY".*recovery_required/); // status persisted WITHOUT a TTL
      expect(source).toContain('redis SET "instance:update:recovery_required"'); // durable gate marker
    });

    it("writes .env atomically (same-dir temp + mv, never a truncate-in-place)", () => {
      expect(source).toContain('mktemp "${ENV_FILE}.XXXXXX"');
      expect(source).toContain('mv "$tmp" "$ENV_FILE"');
      expect(source).not.toContain('cat "$tmp" > "$ENV_FILE"'); // the old non-atomic truncate-write is gone
    });

    const dir = mkdtempSync(join(tmpdir(), "update-sh-f02-"));
    const envFile = join(dir, ".env");
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const runHealth = (health: string): string => {
      writeFileSync(envFile, "TUGRA_VERSION=0.1.0\n");
      return execFileSync("bash", [UPDATE_SH, "--dry-run", "--target", "0.2.0"], {
        stdio: "pipe",
        env: { PATH: process.env.PATH, ENV_FILE: envFile, DRY_HEALTH: health } as NodeJS.ProcessEnv,
      }).toString();
    };

    it("on a failed health check restores AND verifies the previous version — status failed, not done", () => {
      const out = runHealth("fail-once"); // unhealthy on the update, healthy again after the restore
      expect(out).toContain("SET_ENV: TUGRA_VERSION=0.2.0"); // tried the target
      expect(out).toContain("SET_ENV: TUGRA_VERSION=0.1.0"); // restored the previous version
      expect(out).toContain("restored 0.1.0 and verified healthy");
      expect(out).toContain('"phase":"failed"');
      expect(out).not.toContain('"phase":"done"');
    });

    it("escalates to recovery_required when the previous version cannot be restored + verified", () => {
      const out = runHealth("fail"); // stays unhealthy even after the restore attempt
      expect(out).toContain('"phase":"recovery_required"');
      expect(out).toContain("RECOVERY REQUIRED");
      expect(out).toContain("instance:update:recovery_required"); // the persistent no-TTL marker is written
      expect(out).not.toContain('"phase":"done"');
    });
  });
  describe("digest-pinned updates (job parsing, pins, label check, digest-aware rollback)", () => {
    const H = "a".repeat(64);
    const W = "b".repeat(64);
    const PH = "c".repeat(64); // previously pinned hub digest
    const PW = "d".repeat(64);
    const dir = mkdtempSync(join(tmpdir(), "update-sh-digest-"));
    const envFile = join(dir, ".env");
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    const job = (target: string, hub?: string, web?: string): string =>
      JSON.stringify({ targetVersion: target, ...(hub !== undefined ? { hubDigest: hub } : {}), ...(web !== undefined ? { webDigest: web } : {}) });
    const run = (jobJson: string, envText: string, extraEnv: Record<string, string> = {}): string => {
      writeFileSync(envFile, envText);
      return execFileSync("bash", [UPDATE_SH, "--dry-run", "--job", jobJson], {
        stdio: "pipe",
        env: { PATH: process.env.PATH, ENV_FILE: envFile, ...extraEnv } as NodeJS.ProcessEnv,
      }).toString();
    };
    const idx = (out: string, needle: string): number => {
      const i = out.indexOf(needle);
      expect(i).toBeGreaterThanOrEqual(0);
      return i;
    };

    it("parses hubDigest/webDigest from the job: SET_ENV version < digests < pull < label check < up < done", () => {
      const out = run(job("0.2.0", H, W), "TUGRA_VERSION=0.1.0\n");
      const v = idx(out, "SET_ENV: TUGRA_VERSION=0.2.0");
      const h = idx(out, `SET_ENV: TUGRA_HUB_DIGEST=${H}`);
      const w = idx(out, `SET_ENV: TUGRA_WEB_DIGEST=${W}`);
      const pull = idx(out, "pull hub-api web");
      const labelHub = idx(out, `docker image inspect ghcr.io/simeraycom/tugra-hub@sha256:${H}`);
      const labelWeb = idx(out, `docker image inspect ghcr.io/simeraycom/tugra-web@sha256:${W}`);
      const up = idx(out, "up -d --no-deps hub-api web");
      const done = idx(out, '"phase":"done"');
      expect([v, h, w, pull, labelHub, labelWeb, up, done]).toEqual([...[v, h, w, pull, labelHub, labelWeb, up, done]].sort((a, b) => a - b));
      expect(out).toContain("digest-pinned");
      expect(readFileSync(envFile, "utf8")).toBe("TUGRA_VERSION=0.1.0\n"); // dry-run never mutates the file
    });

    it("LEGACY job (no digest fields) behaves exactly as before: only TUGRA_VERSION is written, no label check", () => {
      const out = run(job("0.2.0"), "TUGRA_VERSION=0.1.0\n");
      expect(out).toContain("SET_ENV: TUGRA_VERSION=0.2.0");
      expect(out).not.toContain("TUGRA_HUB_DIGEST");
      expect(out).not.toContain("TUGRA_WEB_DIGEST");
      expect(out).not.toContain("docker image inspect");
      expect(out).toContain('"phase":"done"');
    });

    it("ignores a non-hex / 63-char / partial digest pair (legacy tag path) and says so", () => {
      for (const [hub, web] of [
        ["a".repeat(63), W],
        [H, "Z".repeat(64)],
        [H.toUpperCase(), W],
        [`sha256:${H}`, W],
        [H, undefined],
      ] as Array<[string, string | undefined]>) {
        const out = run(job("0.2.0", hub, web), "TUGRA_VERSION=0.1.0\n");
        expect(out).toContain("ignoring malformed/partial image digests");
        expect(out).not.toContain("TUGRA_HUB_DIGEST");
        expect(out).toContain("SET_ENV: TUGRA_VERSION=0.2.0");
        expect(out).toContain('"phase":"done"');
      }
    });

    it("a malformed job (no targetVersion) is still ignored, even with digests", () => {
      const out = run(JSON.stringify({ hubDigest: H, webDigest: W }), "TUGRA_VERSION=0.1.0\n");
      expect(out).toContain("ignoring malformed job");
      expect(out).not.toContain("pull hub-api web");
      expect(out).not.toContain("SET_ENV");
    });

    it("a legacy target on a PINNED stack clears the old pin (an old digest must not override the new tag)", () => {
      const out = run(job("0.2.0"), `TUGRA_VERSION=0.1.0\nTUGRA_HUB_DIGEST=${PH}\nTUGRA_WEB_DIGEST=${PW}\n`);
      expect(out).toContain("SET_ENV: TUGRA_VERSION=0.2.0");
      expect(out).toContain("SET_ENV: TUGRA_HUB_DIGEST=\n");
      expect(out).toContain("SET_ENV: TUGRA_WEB_DIGEST=\n");
    });

    it("rollback after a failed health check restores the PREVIOUS digests along with the previous tag", () => {
      const out = run(job("0.2.0", H, W), `TUGRA_VERSION=0.1.0\nTUGRA_HUB_DIGEST=${PH}\nTUGRA_WEB_DIGEST=${PW}\n`, { DRY_HEALTH: "fail-once" });
      const afterFail = out.slice(out.indexOf("restoring previous version 0.1.0"));
      expect(afterFail).toContain("SET_ENV: TUGRA_VERSION=0.1.0");
      expect(afterFail).toContain(`SET_ENV: TUGRA_HUB_DIGEST=${PH}`);
      expect(afterFail).toContain(`SET_ENV: TUGRA_WEB_DIGEST=${PW}`);
      expect(afterFail).toContain("up -d --no-deps hub-api web");
      expect(afterFail).toContain("restored 0.1.0 and verified healthy");
      expect(out).not.toContain('"phase":"done"');
    });

    it("rollback of a previously UNPINNED stack unpins (empty digest) instead of leaving the new pin", () => {
      const out = run(job("0.2.0", H, W), "TUGRA_VERSION=0.1.0\n", { DRY_HEALTH: "fail-once" });
      const afterFail = out.slice(out.indexOf("restoring previous version 0.1.0"));
      expect(afterFail).toContain("SET_ENV: TUGRA_VERSION=0.1.0");
      expect(afterFail).toContain("SET_ENV: TUGRA_HUB_DIGEST=\n");
      expect(afterFail).toContain("SET_ENV: TUGRA_WEB_DIGEST=\n");
    });

    it("a tag-only -> tag-only rollback never touches the digest keys (legacy bytes preserved)", () => {
      const out = run(job("0.2.0"), "TUGRA_VERSION=0.1.0\n", { DRY_HEALTH: "fail-once" });
      expect(out).toContain("SET_ENV: TUGRA_VERSION=0.1.0");
      expect(out).not.toContain("TUGRA_HUB_DIGEST");
    });

    it("recovery_required after a failed restore names the previous digests for manual recovery", () => {
      const out = run(job("0.2.0", H, W), `TUGRA_VERSION=0.1.0\nTUGRA_HUB_DIGEST=${PH}\nTUGRA_WEB_DIGEST=${PW}\n`, { DRY_HEALTH: "fail" });
      expect(out).toContain('"phase":"recovery_required"');
      expect(out).toContain(`TUGRA_HUB_DIGEST=${PH}`);
    });

    it("OCI version label MISMATCH rolls back like a pull failure — .env restored, nothing recreated", () => {
      const out = run(job("0.2.0", H, W), "TUGRA_VERSION=0.1.0\n", { DRY_LABEL: "0.1.5" });
      expect(out).toContain("image version label mismatch: hub reports 0.1.5, expected 0.2.0");
      expect(out).toContain('"phase":"failed"');
      expect(out).toContain("SET_ENV: TUGRA_VERSION=0.1.0"); // restored
      expect(out).toContain("SET_ENV: TUGRA_HUB_DIGEST=\n"); // new pin cleared
      expect(out).not.toContain("up -d --no-deps hub-api web"); // never recreated
      expect(out).not.toContain('"phase":"done"');
    });

    it("a MISSING label or a failed inspect FAILS CLOSED for a digest-pinned update (an unlabelled image is an older release someone pointed us at); a leading v on the label matches", () => {
      const missing = run(job("0.2.0", H, W), "TUGRA_VERSION=0.1.0\n", { DRY_LABEL: "missing" });
      expect(missing).toContain("image version label missing: hub image carries no org.opencontainers.image.version label");
      expect(missing).toContain("rolling back .env");
      expect(missing).not.toContain("up -d --no-deps hub-api web");
      expect(missing).toContain(`SET_ENV: TUGRA_VERSION=0.1.0`); // .env restored
      const failed = run(job("0.2.0", H, W), "TUGRA_VERSION=0.1.0\n", { DRY_LABEL: "inspect-fail" });
      expect(failed).toContain("image version check failed: could not inspect the pulled hub image");
      expect(failed).not.toContain("up -d --no-deps hub-api web");
      const v = run(job("0.2.0", H, W), "TUGRA_VERSION=0.1.0\n", { DRY_LABEL: "v0.2.0" });
      expect(v).toContain("up -d --no-deps hub-api web");
    });

    it("an OLD compose file (no digest vars) with the NEW update.sh ignores the job's digests and pulls by tag — never writes pins the stack cannot honour", () => {
      const tmp = mkdtempSync(join(tmpdir(), "tugra-oldcompose-"));
      mkdirSync(join(tmp, "scripts", "lib"), { recursive: true });
      mkdirSync(join(tmp, "deploy"));
      writeFileSync(join(tmp, "scripts", "update.sh"), readFileSync(UPDATE_SH, "utf8"), { mode: 0o755 });
      writeFileSync(join(tmp, "scripts", "lib", "snapshot.sh"), readFileSync(join(UPDATE_SH, "..", "lib", "snapshot.sh")));
      writeFileSync(join(tmp, "deploy", "docker-compose.yml"), "services:\n  hub-api:\n    image: ghcr.io/simeraycom/tugra-hub:${TUGRA_VERSION:-latest}\n");
      writeFileSync(join(tmp, ".env"), "TUGRA_VERSION=0.1.0\n");
      const out = execFileSync("bash", [join(tmp, "scripts", "update.sh"), "--dry-run", "--job", job("0.2.0", H, W)], {
        stdio: "pipe",
        env: { PATH: process.env.PATH, ENV_FILE: join(tmp, ".env") } as NodeJS.ProcessEnv,
      }).toString();
      rmSync(tmp, { recursive: true, force: true });
      expect(out).toContain("no digest pin support");
      expect(out).toContain("SET_ENV: TUGRA_VERSION=0.2.0");
      expect(out).not.toContain("SET_ENV: TUGRA_HUB_DIGEST");
      expect(out).not.toContain("docker image inspect");
    });

    it("keeps the downgrade guard in front of digests (non-newer target -> no write, no pull)", () => {
      const out = run(job("0.0.9", H, W), "TUGRA_VERSION=0.1.0\n");
      expect(out).toContain("refusing non-newer target");
      expect(out).not.toContain("SET_ENV");
      expect(out).not.toContain("pull hub-api web");
    });

    it("tolerates a malformed previous pin in .env (treated as unpinned, never written back)", () => {
      const out = run(job("0.2.0", H, W), "TUGRA_VERSION=0.1.0\nTUGRA_HUB_DIGEST=garbage\n", { DRY_HEALTH: "fail-once" });
      const afterFail = out.slice(out.indexOf("restoring previous version 0.1.0"));
      expect(afterFail).not.toContain("garbage");
      expect(afterFail).toContain("SET_ENV: TUGRA_HUB_DIGEST=\n");
    });

    it("the queue parser reads flat string fields without jq and never aborts when a field is absent (set -e)", () => {
      expect(source).toContain("job_field()");
      expect(source).toMatch(/job_field\(\) \{[^\n]*\|\| true/);
      expect(source).toContain('job_field "$job" hubDigest');
      expect(source).toContain('job_field "$job" webDigest');
      expect(source).toMatch(/is_hex64\(\) \{ \[\[ "\$\{1:-\}" =~ \^\[0-9a-f\]\{64\}\$ \]\]; \}/);
    });
  });
});
