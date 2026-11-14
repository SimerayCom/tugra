import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
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
      mkdirSync(join(tmp, "scripts"));
      mkdirSync(join(tmp, "deploy"));
      writeFileSync(join(tmp, "scripts", "update.sh"), readFileSync(UPDATE_SH, "utf8"), { mode: 0o755 });
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
