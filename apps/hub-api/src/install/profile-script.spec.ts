import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The installer's RAM profiles (scripts/lib/profile.sh): detection thresholds, what each profile writes to .env, that an existing
 * choice / hand edit survives a re-run, and that deploy/docker-compose.yml turns those keys into the right container settings and
 * falls back to sane defaults when they are absent (an install that never ran a profile, i.e. every in-app update of an older one).
 */
const ROOT = join(__dirname, "..", "..", "..", "..");
const LIB = join(ROOT, "scripts", "lib", "profile.sh");
const INSTALL = join(ROOT, "scripts", "install.sh");
const COMPOSE = join(ROOT, "deploy", "docker-compose.yml");
const BASH = execFileSync("sh", ["-c", "command -v bash"]).toString().trim();

const dir = mkdtempSync(join(tmpdir(), "tugra-profile-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const clean = { PATH: process.env.PATH } as NodeJS.ProcessEnv;
const URLS = ["--hub-url", "http://10.0.0.5:3000", "--web-url", "http://10.0.0.5:3001"];

let n = 0;
/** A `docker` stub first on PATH: whether the Postgres volume of "an install that is already running" exists must not depend on this machine's real Docker. */
function dockerStub(volumeExists: boolean): string {
  const bin = join(dir, `bin-${n++}`);
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "docker"), `#!/bin/sh\n[ "$1 $2 $3" = "volume inspect tugra_tugra_pg" ] && exit ${volumeExists ? 0 : 1}\nexit 1\n`, { mode: 0o755 });
  return `${bin}:${process.env.PATH}`;
}
/** A fake host: /proc/meminfo (and an empty /proc/swaps) under a private TUGRA_FS_ROOT. kb=null leaves meminfo out. */
function host(kb: number | null): string {
  const root = join(dir, `host-${n++}`);
  mkdirSync(join(root, "proc"), { recursive: true });
  if (kb !== null) writeFileSync(join(root, "proc", "meminfo"), `MemTotal:       ${kb} kB\n`);
  writeFileSync(join(root, "proc", "swaps"), "Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n");
  return root;
}

function detect(kb: number | null): string {
  return execFileSync(BASH, ["-c", `. "${LIB}"; profile_detect`], { env: { ...clean, TUGRA_FS_ROOT: host(kb) } }).toString().trim();
}

/** Run the real installer in --dry-run against an env file (created from `initial` when given) and return what it wrote. */
function install(args: string[], opts: { kb?: number | null; initial?: string; name?: string } = {}) {
  const envFile = join(dir, `${opts.name ?? `env-${n++}`}.env`);
  if (opts.initial !== undefined) writeFileSync(envFile, opts.initial);
  const r = spawnSync(BASH, [INSTALL, "--dry-run", "--env-file", envFile, ...URLS, ...args], {
    encoding: "utf8",
    env: { ...clean, PATH: dockerStub(false), TUGRA_FS_ROOT: host(opts.kb === undefined ? 3_900_000 : opts.kb) },
  });
  const env = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  const get = (k: string) => new RegExp(`^${k}=(.*)$`, "m").exec(env)?.[1];
  return { status: r.status, out: r.stdout + r.stderr, env, get, envFile };
}

function profileValues(name: string): Record<string, string> {
  const out = execFileSync(BASH, ["-c", `. "${LIB}"; profile_values ${name}`]).toString();
  return Object.fromEntries(out.trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
}
const KEYS = execFileSync(BASH, ["-c", `. "${LIB}"; echo $PROFILE_KEYS`]).toString().trim().split(/\s+/);
const mb = (v: string) => Number(/^(\d+)/.exec(v)![1]) * (/gb$/i.test(v) ? 1024 : 1);

describe("scripts/lib/profile.sh", () => {
  it("is valid bash and ships in scripts/lib (the host-file signer globs lib/*.sh)", () => {
    expect(() => execFileSync("bash", ["-n", LIB], { stdio: "pipe" })).not.toThrow();
    expect(() => execFileSync("bash", ["-n", INSTALL], { stdio: "pipe" })).not.toThrow();
  });

  describe("detection from MemTotal", () => {
    it.each([
      [512_000, "tiny"],
      [990_000, "tiny"], // a "1 GB" VM
      [1_572_863, "tiny"], // one kB under 1.5 GiB
      [1_572_864, "small"],
      [1_950_000, "small"], // a "2 GB" VM
      [3_145_727, "small"], // one kB under 3 GiB
      [3_145_728, "standard"],
      [3_900_000, "standard"], // a "4 GB" VM
      [16_000_000, "standard"],
    ])("%i kB -> %s", (kb, want) => {
      expect(detect(kb)).toBe(want);
    });

    it("an unreadable RAM size is standard: never guess a small host", () => {
      expect(detect(null)).toBe("standard");
    });
  });

  describe("the value tables", () => {
    it.each(["tiny", "small", "standard"])("%s defines every managed key exactly once", (name) => {
      const lines = execFileSync(BASH, ["-c", `. "${LIB}"; profile_values ${name}`]).toString().trim().split("\n");
      expect(lines.map((l) => l.split("=")[0])).toEqual(KEYS);
    });

    it("an unknown profile has no values", () => {
      expect(spawnSync(BASH, ["-c", `. "${LIB}"; profile_values huge`]).status).toBe(1);
    });

    it("grows monotonically with the host: tiny <= small <= standard", () => {
      const [t, s, st] = ["tiny", "small", "standard"].map(profileValues);
      for (const k of ["HUB_MAX_HEAP_MB", "HUB_SEMI_SPACE_MB", "WEB_MAX_HEAP_MB", "TUGRA_PG_MAX_CONNECTIONS", "TUGRA_PG_PARALLEL_WORKERS", "HUB_DB_CONNECTION_LIMIT"]) {
        expect(Number(t[k])).toBeLessThanOrEqual(Number(s[k]));
        expect(Number(s[k])).toBeLessThanOrEqual(Number(st[k]));
      }
      for (const k of ["TUGRA_PG_SHARED_BUFFERS", "TUGRA_PG_EFFECTIVE_CACHE_SIZE", "TUGRA_PG_WORK_MEM", "TUGRA_PG_MAX_WAL_SIZE", "TUGRA_REDIS_MAXMEMORY"]) {
        expect(mb(t[k])).toBeLessThanOrEqual(mb(s[k]));
        expect(mb(s[k])).toBeLessThanOrEqual(mb(st[k]));
      }
    });

    it("keeps the Postgres connection ceiling above the hub's pool plus the other clients (migrate at boot, pg_dump, headroom)", () => {
      for (const name of ["tiny", "small", "standard"]) {
        const v = profileValues(name);
        expect(Number(v.TUGRA_PG_MAX_CONNECTIONS)).toBeGreaterThanOrEqual(Number(v.HUB_DB_CONNECTION_LIMIT) + 10);
      }
    });

    it("never gives the hub a container ceiling at or below what its own heap cap plus the native overhead needs", () => {
      for (const name of ["tiny", "small"]) {
        const v = profileValues(name);
        expect(mb(v.HUB_MEM_LIMIT.replace(/m$/, "mb"))).toBeGreaterThanOrEqual(Number(v.HUB_MAX_HEAP_MB) + 256);
        expect(mb(v.WEB_MEM_LIMIT.replace(/m$/, "mb"))).toBeGreaterThanOrEqual(Number(v.WEB_MAX_HEAP_MB) + 96);
        // Redis: maxmemory plus a copy-on-write headroom for the background save.
        expect(mb(v.REDIS_MEM_LIMIT.replace(/m$/, "mb"))).toBeGreaterThanOrEqual(mb(v.TUGRA_REDIS_MAXMEMORY) + 64);
      }
      const std = profileValues("standard");
      expect([std.HUB_MEM_LIMIT, std.WEB_MEM_LIMIT, std.REDIS_MEM_LIMIT]).toEqual(["0", "0", "0"]);
    });
  });

  describe("container ceilings versus raised heap caps", () => {
    const check = (env: string) => {
      const f = join(dir, `ceil-${n++}.env`);
      writeFileSync(f, env);
      return execFileSync(BASH, ["-c", `ENV_FILE="${f}"; env_get() { { grep "^$1=" "$ENV_FILE" 2>/dev/null || true; } | head -n1 | cut -d= -f2-; }; . "${LIB}"; profile_ceiling_problems`]).toString();
    };
    it("the shipped profiles fit their own ceilings", () => {
      for (const name of ["tiny", "small", "standard"]) {
        const v = profileValues(name);
        expect(check(Object.entries(v).map(([k, x]) => `${k}=${x}`).join("\n"))).toBe("");
      }
    });

    it("flags the documented fix (a raised heap cap) when HUB_MEM_LIMIT stays at the profile's value", () => {
      const out = check("HUB_MAX_HEAP_MB=768\nHUB_MEM_LIMIT=640m\n");
      expect(out).toMatch(/HUB_MEM_LIMIT=640m allows 640 MB but HUB_MAX_HEAP_MB=768 needs about 1152 MB/);
      expect(out).toMatch(/Raise HUB_MEM_LIMIT to at least 1152m/);
    });

    it("is quiet when the ceiling is raised together with the cap, in any unit, or when there is no ceiling", () => {
      expect(check("HUB_MAX_HEAP_MB=768\nHUB_MEM_LIMIT=1152m\n")).toBe("");
      expect(check("HUB_MAX_HEAP_MB=768\nHUB_MEM_LIMIT=2g\n")).toBe("");
      expect(check("HUB_MAX_HEAP_MB=1536\nHUB_MEM_LIMIT=0\n")).toBe("");
      expect(check("HUB_MAX_HEAP_MB=1536\n")).toBe("");
    });

    it("uses the compose default cap (768) when only the ceiling is set, and checks web and Redis too", () => {
      expect(check("HUB_MEM_LIMIT=640m\n")).toMatch(/HUB_MAX_HEAP_MB=768 needs about 1152/);
      expect(check("WEB_MAX_HEAP_MB=256\nWEB_MEM_LIMIT=256m\n")).toMatch(/WEB_MEM_LIMIT=256m allows 256 MB but WEB_MAX_HEAP_MB=256 needs about 416/);
      expect(check("TUGRA_REDIS_MAXMEMORY=192mb\nREDIS_MEM_LIMIT=192m\n")).toMatch(/REDIS_MEM_LIMIT=192m allows 192 MB but TUGRA_REDIS_MAXMEMORY=192mb needs about 256/);
    });
  });
});

describe("scripts/install.sh --profile wiring", () => {
  it.each([
    [900_000, "tiny"],
    [1_950_000, "small"],
    [3_900_000, "standard"],
  ])("a first install on %i kB writes the %s profile and every key", (kb, want) => {
    const r = install([], { kb });
    expect(r.status).toBe(0);
    expect(r.get("TUGRA_PROFILE")).toBe(want);
    const vals = profileValues(want);
    for (const k of KEYS) expect(r.get(k)).toBe(vals[k]);
    expect(r.out).toMatch(new RegExp(`Profile: ${want} \\(detected from`));
  });

  it("--profile overrides the detected one, in both flag forms, and overwrites an earlier choice", () => {
    expect(install(["--profile=tiny"]).get("TUGRA_PROFILE")).toBe("tiny");
    expect(install(["--profile", "small"]).get("TUGRA_PROFILE")).toBe("small");
    const r = install(["--profile=small"], { initial: `TUGRA_PROFILE=tiny\nHUB_MAX_HEAP_MB=256\n` });
    expect(r.get("TUGRA_PROFILE")).toBe("small");
    expect(r.get("HUB_MAX_HEAP_MB")).toBe("384");
    expect(r.env.match(/^HUB_MAX_HEAP_MB=/gm)).toHaveLength(1);
  });

  it("--profile=auto detects again from this host's RAM", () => {
    const r = install(["--profile=auto"], { kb: 1_000_000, initial: `TUGRA_PROFILE=standard\n` });
    expect(r.get("TUGRA_PROFILE")).toBe("tiny");
    expect(r.get("HUB_MAX_HEAP_MB")).toBe("256");
  });

  it("an unknown profile name is refused before anything is written", () => {
    const envFile = join(dir, "bogus.env");
    const r = spawnSync(BASH, [INSTALL, "--dry-run", "--env-file", envFile, ...URLS, "--profile=huge"], { encoding: "utf8", env: clean });
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/--profile must be one of: tiny, small, standard, auto/);
    expect(existsSync(envFile)).toBe(false);
    expect(spawnSync(BASH, [INSTALL, "--dry-run", "--env-file", envFile, "--profile"], { encoding: "utf8", env: clean }).status).toBe(1);
  });

  it("a flag-less re-run keeps the stored profile and the operator's hand edits, and says when the RAM now suggests another", () => {
    const first = install([], { kb: 1_000_000, name: "rerun" });
    expect(first.get("TUGRA_PROFILE")).toBe("tiny");
    writeFileSync(first.envFile, first.env.replace(/^HUB_MAX_HEAP_MB=.*$/m, "HUB_MAX_HEAP_MB=300").replace(/^TUGRA_PG_MAX_CONNECTIONS=.*$/m, "TUGRA_PG_MAX_CONNECTIONS=45"));
    const second = install([], { kb: 8_000_000, name: "rerun" });
    expect(second.get("TUGRA_PROFILE")).toBe("tiny");
    expect(second.get("HUB_MAX_HEAP_MB")).toBe("300");
    expect(second.get("TUGRA_PG_MAX_CONNECTIONS")).toBe("45");
    expect(second.out).toMatch(/suggests the 'standard' profile; re-run with --profile=standard/);
  });

  it("an install that predates profiles keeps the keys it already has (HUB_MAX_HEAP_MB from the old installer or by hand)", () => {
    const r = install([], { kb: 8_000_000, initial: "HUB_MAX_HEAP_MB=1536\n" });
    expect(r.get("TUGRA_PROFILE")).toBe("standard");
    expect(r.get("HUB_MAX_HEAP_MB")).toBe("1536");
    expect(r.get("TUGRA_PG_SHARED_BUFFERS")).toBe("256MB");
  });

  it("a stored profile name that is not one of ours is ignored (re-detected), never fatal", () => {
    const r = install([], { kb: 1_950_000, initial: "TUGRA_PROFILE=giant\n" });
    expect(r.status).toBe(0);
    expect(r.get("TUGRA_PROFILE")).toBe("small");
  });

  it("leaves DATABASE_URL untouched: the pool is applied in the hub process, so pg_dump and migrate keep a plain URL", () => {
    const r = install(["--profile=tiny"]);
    expect(r.get("DATABASE_URL")).toMatch(/^postgresql:\/\/tugra:[^@]+@postgres:5432\/tugra\?schema=public$/);
  });

  it("a re-run on an install that is already running does not shrink it: advice only, nothing written", () => {
    const path = dockerStub(true);
    const envFile = join(dir, `existing-${n++}.env`);
    writeFileSync(envFile, "POSTGRES_PASSWORD=abc\nHUB_PORT=3000\n");
    const r = spawnSync(BASH, [INSTALL, "--dry-run", "--env-file", envFile, ...URLS], {
      encoding: "utf8",
      env: { ...clean, PATH: path, TUGRA_FS_ROOT: host(1_000_000) },
    });
    const env = readFileSync(envFile, "utf8");
    expect(r.status).toBe(0);
    for (const k of ["TUGRA_PROFILE", ...KEYS]) expect(env).not.toMatch(new RegExp(`^${k}=`, "m"));
    expect(r.stdout + r.stderr).toMatch(/Profile: none set; this install keeps the sizing it runs with today/);
    expect(r.stdout + r.stderr).toMatch(/the 'tiny' profile .* fits it\. Nothing was changed; to apply it run:  \.\/scripts\/install\.sh --profile=tiny/);
    // --profile is still the explicit way in.
    const forced = spawnSync(BASH, [INSTALL, "--dry-run", "--env-file", envFile, ...URLS, "--profile=tiny"], {
      encoding: "utf8",
      env: { ...clean, PATH: path, TUGRA_FS_ROOT: host(1_000_000) },
    });
    expect(forced.status).toBe(0);
    expect(readFileSync(envFile, "utf8")).toMatch(/^TUGRA_PROFILE=tiny$/m);
  });

  it("a .env left by an install that never started (no Postgres volume) is still a fresh install and gets its profile", () => {
    const r = install([], { kb: 1_000_000, initial: "POSTGRES_PASSWORD=abc\n" });
    expect(r.get("TUGRA_PROFILE")).toBe("tiny");
  });

  it("warns when the operator raised the heap cap but left the container ceiling, in the installer and in --doctor", () => {
    const r = install([], { kb: 1_000_000, initial: "TUGRA_PROFILE=tiny\nHUB_MAX_HEAP_MB=768\nHUB_MEM_LIMIT=640m\n" });
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/HUB_MEM_LIMIT=640m allows 640 MB but HUB_MAX_HEAP_MB=768 needs about 1152 MB/);
    const envFile = join(dir, `doctor-ceil-${n++}.env`);
    writeFileSync(envFile, "TUGRA_PROFILE=tiny\nHUB_MAX_HEAP_MB=768\nHUB_MEM_LIMIT=640m\n");
    const d = spawnSync(BASH, [INSTALL, "--doctor", "--env-file", envFile], { encoding: "utf8", env: { ...clean, TUGRA_FS_ROOT: host(1_000_000) }, timeout: 60_000 });
    expect(d.stdout + d.stderr).toMatch(/HUB_MEM_LIMIT=640m allows 640 MB but HUB_MAX_HEAP_MB=768/);
    // the installer does not rewrite either value
    expect(r.get("HUB_MAX_HEAP_MB")).toBe("768");
    expect(r.get("HUB_MEM_LIMIT")).toBe("640m");
  });

  it("--doctor on a host that has no profile prints the matching advice and changes nothing", () => {
    const root = host(1_000_000);
    const r = spawnSync(BASH, [INSTALL, "--doctor", "--env-file", join(dir, "doctor-none.env")], { encoding: "utf8", env: { ...clean, TUGRA_FS_ROOT: root }, timeout: 60_000 });
    expect(r.stdout + r.stderr).toMatch(/Profile: none set, but this host has ~\d+ MB RAM: the 'tiny' profile fits it/);
    expect(existsSync(join(dir, "doctor-none.env"))).toBe(false);
  });

  it("--doctor reports a stored profile that matches, and one that does not", () => {
    const envFile = join(dir, "doctor-set.env");
    writeFileSync(envFile, "TUGRA_PROFILE=small\nHUB_PORT=3000\n");
    const run = (kb: number) =>
      spawnSync(BASH, [INSTALL, "--doctor", "--env-file", envFile], { encoding: "utf8", env: { ...clean, TUGRA_FS_ROOT: host(kb) }, timeout: 60_000 });
    expect(run(1_950_000).stdout).toMatch(/Profile: small \(~\d+ MB RAM\)/);
    expect(run(1_000_000).stdout).toMatch(/Profile: small in \.env, but ~\d+ MB RAM fits 'tiny'/);
    expect(readFileSync(envFile, "utf8")).toBe("TUGRA_PROFILE=small\nHUB_PORT=3000\n");
  });
});

/** deploy/docker-compose.yml: the interpolation itself, against `docker compose config` (skipped where compose is not installed). */
const hasCompose = spawnSync("docker", ["compose", "version"], { stdio: "pipe" }).status === 0;
const describeCompose = hasCompose ? describe : describe.skip;

describeCompose("deploy/docker-compose.yml profile interpolation", () => {
  const REQUIRED = [
    "POSTGRES_PASSWORD=pw",
    "DATABASE_URL=postgresql://tugra:pw@postgres:5432/tugra?schema=public",
    "REDIS_URL=redis://redis:6379",
    "HUB_PUBLIC_URL=http://h",
    "WEB_PUBLIC_URL=http://w",
    "COOKIE_SECURE=false",
    "JWT_ACCESS_SECRET=a",
    "JWT_REFRESH_SECRET=b",
    "SECRETS_ENCRYPTION_KEY=c",
    "HUB_SIGNING_KEY=d",
    "LOCAL_AGENT_ENROLL_TOKEN=e",
  ].join("\n");

  function config(extra: string) {
    const f = join(dir, `compose-${n++}.env`);
    writeFileSync(f, `${REQUIRED}\n${extra}\n`);
    const r = spawnSync("docker", ["compose", "--env-file", f, "-f", COMPOSE, "--profile", "updater", "config", "--format", "json"], { encoding: "utf8", maxBuffer: 10_000_000 });
    if (r.status !== 0) throw new Error(r.stderr);
    return JSON.parse(r.stdout) as { services: Record<string, { command?: string[]; mem_limit?: string | number; environment: Record<string, string> }> };
  }
  /** Every setting must be its own `-c key=value` pair: a bare `key=value` after the program name is not a valid postgres argument. */
  const assertWellFormedPostgresCommand = (cmd: string[] | undefined) => {
    expect(cmd?.[0]).toBe("postgres");
    const rest = cmd!.slice(1);
    expect(rest.length % 2).toBe(0);
    for (let i = 0; i < rest.length; i += 2) {
      expect(rest[i]).toBe("-c");
      expect(rest[i + 1]).toMatch(/^[a-z_]+=\S+$/);
    }
  };
  const flag = (cmd: string[] | undefined, key: string) => cmd?.find((a) => a.startsWith(`${key}=`))?.slice(key.length + 1);

  it("without any profile key (an older install, an in-app update) the stack gets today's behaviour or better", () => {
    const { services: s } = config("");
    assertWellFormedPostgresCommand(s.postgres.command);
    expect(flag(s.postgres.command, "shared_buffers")).toBe("128MB");
    expect(flag(s.postgres.command, "max_connections")).toBe("100");
    expect(flag(s.postgres.command, "max_parallel_workers_per_gather")).toBe("2");
    expect(flag(s.postgres.command, "wal_compression")).toBe("on");
    expect(s.redis.command).toEqual(["redis-server", "--maxmemory", "256mb", "--maxmemory-policy", "noeviction"]);
    expect(s["hub-api"].environment.NODE_OPTIONS).toBe("--max-old-space-size=768 --max-semi-space-size=16");
    expect(s["hub-api"].environment.MALLOC_ARENA_MAX).toBe("2");
    expect(s["hub-api"].environment.HUB_DB_CONNECTION_LIMIT).toBe("16");
    expect(s.web.environment.NODE_OPTIONS).toBe("--max-old-space-size=512");
    for (const svc of ["hub-api", "web", "redis"]) expect(Number(s[svc].mem_limit ?? 0)).toBe(0);
    // Services that must never get a ceiling.
    for (const svc of ["postgres", "agent", "tugra-updater"]) expect(s[svc].mem_limit).toBeUndefined();
  });

  it.each(["tiny", "small", "standard"])("the %s profile's keys reach every service", (name) => {
    const v = profileValues(name);
    const { services: s } = config(Object.entries(v).map(([k, x]) => `${k}=${x}`).join("\n"));
    assertWellFormedPostgresCommand(s.postgres.command);
    expect(flag(s.postgres.command, "shared_buffers")).toBe(v.TUGRA_PG_SHARED_BUFFERS);
    expect(flag(s.postgres.command, "effective_cache_size")).toBe(v.TUGRA_PG_EFFECTIVE_CACHE_SIZE);
    expect(flag(s.postgres.command, "work_mem")).toBe(v.TUGRA_PG_WORK_MEM);
    expect(flag(s.postgres.command, "maintenance_work_mem")).toBe(v.TUGRA_PG_MAINTENANCE_WORK_MEM);
    expect(flag(s.postgres.command, "max_connections")).toBe(v.TUGRA_PG_MAX_CONNECTIONS);
    expect(flag(s.postgres.command, "max_parallel_workers_per_gather")).toBe(v.TUGRA_PG_PARALLEL_WORKERS);
    expect(flag(s.postgres.command, "max_wal_size")).toBe(v.TUGRA_PG_MAX_WAL_SIZE);
    expect(flag(s.postgres.command, "checkpoint_timeout")).toBe(v.TUGRA_PG_CHECKPOINT_TIMEOUT);
    expect(s.redis.command).toEqual(["redis-server", "--maxmemory", v.TUGRA_REDIS_MAXMEMORY, "--maxmemory-policy", "noeviction"]);
    expect(s["hub-api"].environment.NODE_OPTIONS).toBe(`--max-old-space-size=${v.HUB_MAX_HEAP_MB} --max-semi-space-size=${v.HUB_SEMI_SPACE_MB}`);
    expect(s["hub-api"].environment.HUB_DB_CONNECTION_LIMIT).toBe(v.HUB_DB_CONNECTION_LIMIT);
    expect(s["hub-api"].environment.HUB_DB_POOL_TIMEOUT).toBe(v.HUB_DB_POOL_TIMEOUT);
    expect(s.web.environment.NODE_OPTIONS).toBe(`--max-old-space-size=${v.WEB_MAX_HEAP_MB}`);
    if (v.HUB_MEM_LIMIT === "0") {
      for (const svc of ["hub-api", "web", "redis"]) expect(Number(s[svc].mem_limit ?? 0)).toBe(0);
    } else {
      const bytes = (x: string) => Number(x.replace(/m$/, "")) * 1024 * 1024;
      expect(Number(s["hub-api"].mem_limit)).toBe(bytes(v.HUB_MEM_LIMIT));
      expect(Number(s.web.mem_limit)).toBe(bytes(v.WEB_MEM_LIMIT));
      expect(Number(s.redis.mem_limit)).toBe(bytes(v.REDIS_MEM_LIMIT));
    }
  });

  it("Redis keeps the noeviction policy and no persistence override in every case (BullMQ + refresh tokens need it)", () => {
    for (const name of ["tiny", "small", "standard"]) {
      const cmd = config(Object.entries(profileValues(name)).map(([k, x]) => `${k}=${x}`).join("\n")).services.redis.command ?? [];
      expect(cmd).toContain("noeviction");
      expect(cmd.some((a) => /^--(save|appendonly)$/.test(a))).toBe(false);
    }
  });

  it("every profile key is read by the compose file (a key nothing consumes would be a silent no-op)", () => {
    const text = readFileSync(COMPOSE, "utf8");
    for (const k of KEYS) expect(text).toContain("${" + k + ":-");
  });
});
