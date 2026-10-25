import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

// Repo-root artifacts (jest rootDir is src/, but __dirname resolves to the real source dir).
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const INSTALL_SH = join(REPO_ROOT, "scripts", "install.sh");
const COMPOSE = join(REPO_ROOT, "deploy", "docker-compose.yml");

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

describe("scripts/install.sh", () => {
  it("is valid bash syntax (bash -n)", () => {
    expect(() => execFileSync("bash", ["-n", INSTALL_SH], { stdio: "pipe" })).not.toThrow();
  });

  describe("--dry-run .env generation", () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-install-"));
    // Clean env so a stray HUB_PORT/etc. on the CI box can't skew the generated values.
    const cleanEnv = { PATH: process.env.PATH } as NodeJS.ProcessEnv;
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    const run = (args: string[], envPath: string) =>
      execFileSync("bash", [INSTALL_SH, "--dry-run", "--env-file", envPath, ...args], { stdio: "pipe", env: cleanEnv });

    it("generates every production-required secret in the right format", () => {
      const envPath = join(dir, "quickstart.env");
      run(["--hub-url", "http://10.0.0.5:3000", "--web-url", "http://10.0.0.5:3001"], envPath);
      const env = parseEnv(readFileSync(envPath, "utf8"));

      for (const k of ["JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET", "SECRETS_ENCRYPTION_KEY", "HUB_SIGNING_KEY", "POSTGRES_PASSWORD", "DATABASE_URL", "REDIS_URL", "NODE_ENV"]) {
        expect(env[k]).toBeTruthy();
      }
      // HUB_SIGNING_KEY must decode to exactly 32 bytes (the ed25519 seed the hub validates).
      expect(Buffer.from(env.HUB_SIGNING_KEY, "base64").length).toBe(32);
      // The three app secrets must be ≥16 chars.
      for (const k of ["JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET", "SECRETS_ENCRYPTION_KEY"]) {
        expect(env[k].length).toBeGreaterThanOrEqual(16);
      }
      // DATABASE_URL embeds the generated (url-safe) POSTGRES_PASSWORD.
      expect(env.DATABASE_URL).toContain(env.POSTGRES_PASSWORD);
      expect(env.DATABASE_URL).toMatch(/^postgresql:\/\/tugra:.+@postgres:5432\/tugra\?schema=public$/);
      expect(env.REDIS_URL).toBe("redis://redis:6379"); // unauthenticated (BullMQ)
      expect(env.NODE_ENV).toBe("production");
      // First-run owner-claim code (8 hex chars) — closes the first-visitor-claims-owner window.
      expect(env.SETUP_CODE).toMatch(/^[0-9a-f]{8}$/);
    });

    it("uses COOKIE_SECURE=false for the http quick-start (else login dies over http)", () => {
      const envPath = join(dir, "http.env");
      run(["--hub-url", "http://10.0.0.5:3000", "--web-url", "http://10.0.0.5:3001"], envPath);
      const env = parseEnv(readFileSync(envPath, "utf8"));
      expect(env.COOKIE_SECURE).toBe("false");
      expect(env.HUB_TRUSTED_PROXY).toBe("false"); // explicit false, never "" (spoof-safe default)
    });

    it("uses https + COOKIE_SECURE=true + HUB_TRUSTED_PROXY=true behind a --domain proxy", () => {
      const envPath = join(dir, "domain.env");
      run(["--domain", "tugra.example.com"], envPath);
      const env = parseEnv(readFileSync(envPath, "utf8"));
      expect(env.HUB_PUBLIC_URL).toBe("https://tugra.example.com");
      expect(env.WEB_PUBLIC_URL).toBe("https://tugra.example.com");
      expect(env.COOKIE_SECURE).toBe("true");
      expect(env.HUB_TRUSTED_PROXY).toBe("true");
    });

    it("is idempotent — re-running preserves the five stability-critical secrets", () => {
      const envPath = join(dir, "idem.env");
      run(["--hub-url", "http://10.0.0.5:3000", "--web-url", "http://10.0.0.5:3001"], envPath);
      const first = parseEnv(readFileSync(envPath, "utf8"));
      run(["--hub-url", "http://10.0.0.5:3000", "--web-url", "http://10.0.0.5:3001"], envPath);
      const second = parseEnv(readFileSync(envPath, "utf8"));
      for (const k of ["JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET", "SECRETS_ENCRYPTION_KEY", "HUB_SIGNING_KEY", "POSTGRES_PASSWORD", "SETUP_CODE"]) {
        expect(second[k]).toBe(first[k]);
      }
    });

    it("re-running with a new --domain updates the URLs but keeps the secrets", () => {
      const envPath = join(dir, "switch.env");
      run(["--hub-url", "http://10.0.0.5:3000", "--web-url", "http://10.0.0.5:3001"], envPath);
      const before = parseEnv(readFileSync(envPath, "utf8"));
      run(["--domain", "tugra.example.com"], envPath);
      const after = parseEnv(readFileSync(envPath, "utf8"));
      expect(after.HUB_PUBLIC_URL).toBe("https://tugra.example.com");
      expect(after.COOKIE_SECURE).toBe("true");
      // secrets untouched, and DATABASE_URL still references the preserved password
      expect(after.POSTGRES_PASSWORD).toBe(before.POSTGRES_PASSWORD);
      expect(after.HUB_SIGNING_KEY).toBe(before.HUB_SIGNING_KEY);
      expect(after.DATABASE_URL).toContain(before.POSTGRES_PASSWORD);
    });

    it("downgrading from --domain back to the http quick-start CLEARS HUB_TRUSTED_PROXY (spoof-safe)", () => {
      const envPath = join(dir, "downgrade.env");
      run(["--domain", "tugra.example.com"], envPath);
      expect(parseEnv(readFileSync(envPath, "utf8")).HUB_TRUSTED_PROXY).toBe("true");
      run(["--hub-url", "http://10.0.0.5:3000", "--web-url", "http://10.0.0.5:3001"], envPath);
      const env = parseEnv(readFileSync(envPath, "utf8"));
      expect(env.HUB_TRUSTED_PROXY).toBe("false"); // stale true must not linger over plain http
      expect(env.COOKIE_SECURE).toBe("false");
    });

    it("a flag-less re-run (the documented upgrade path) PRESERVES the configured --domain origin", () => {
      const envPath = join(dir, "upgrade.env");
      run(["--domain", "tugra.example.com"], envPath);
      run([], envPath); // `git pull && ./scripts/install.sh` with no flags — must not revert to http quick-start
      const env = parseEnv(readFileSync(envPath, "utf8"));
      expect(env.HUB_PUBLIC_URL).toBe("https://tugra.example.com");
      expect(env.WEB_PUBLIC_URL).toBe("https://tugra.example.com");
      expect(env.COOKIE_SECURE).toBe("true");
      expect(env.HUB_TRUSTED_PROXY).toBe("true");
    });

    it("the http quick-start binds the published ports to 0.0.0.0 (agents dial host:3000)", () => {
      const envPath = join(dir, "bind-quick.env");
      run([], envPath);
      const env = parseEnv(readFileSync(envPath, "utf8"));
      expect(env.HUB_BIND).toBe("0.0.0.0");
      expect(env.WEB_BIND).toBe("0.0.0.0");
    });

    it("a fresh --domain install binds the published ports to loopback (proxy-only reachability)", () => {
      const envPath = join(dir, "bind-domain.env");
      run(["--domain", "tugra.example.com"], envPath);
      const env = parseEnv(readFileSync(envPath, "utf8"));
      expect(env.HUB_BIND).toBe("127.0.0.1");
      expect(env.WEB_BIND).toBe("127.0.0.1");
    });

    it("anonymous telemetry is ON by default and turns off with --no-telemetry", () => {
      const onPath = join(dir, "tel-on.env");
      run([], onPath); // headless (no TTY): keeps the default on
      expect(parseEnv(readFileSync(onPath, "utf8")).TUGRA_TELEMETRY).toBe("1");
      const offPath = join(dir, "tel-off.env");
      run(["--no-telemetry"], offPath);
      expect(parseEnv(readFileSync(offPath, "utf8")).TUGRA_TELEMETRY).toBe("0");
    });

    it("an explicit --no-telemetry on a RE-RUN overrides a stored TUGRA_TELEMETRY=1 (the advertised anytime off-switch)", () => {
      const p = join(dir, "tel-rerun.env");
      run([], p); // first run leaves it ON
      expect(parseEnv(readFileSync(p, "utf8")).TUGRA_TELEMETRY).toBe("1");
      run(["--no-telemetry"], p); // re-run with the explicit opt-out MUST flip it off
      const after = parseEnv(readFileSync(p, "utf8"));
      expect(after.TUGRA_TELEMETRY).toBe("0");
      // and exactly one line survives (set_env upserts, never duplicates)
      expect(readFileSync(p, "utf8").match(/^TUGRA_TELEMETRY=/gm)?.length).toBe(1);
    });

    it("a flag-less re-run PRESERVES a stored telemetry opt-out (does not silently re-enable)", () => {
      const p = join(dir, "tel-keep.env");
      run(["--no-telemetry"], p); // opted out
      expect(parseEnv(readFileSync(p, "utf8")).TUGRA_TELEMETRY).toBe("0");
      run([], p); // plain re-run must keep the opt-out
      expect(parseEnv(readFileSync(p, "utf8")).TUGRA_TELEMETRY).toBe("0");
    });

    it("--home presets DEFAULT_UI_MODE=home (owner starts in the Home launcher); default install leaves it unset", () => {
      const home = join(dir, "home.env");
      run(["--home"], home);
      expect(parseEnv(readFileSync(home, "utf8")).DEFAULT_UI_MODE).toBe("home");
      const fleet = join(dir, "fleet.env");
      run([], fleet); // no flag → unset (schema default "fleet")
      expect(parseEnv(readFileSync(fleet, "utf8")).DEFAULT_UI_MODE).toBeUndefined();
    });
  });

  describe("deploy/docker-compose.yml", () => {
    const compose = parseYaml(readFileSync(COMPOSE, "utf8")) as {
      services: Record<string, { image?: string; build?: unknown; environment?: Record<string, string>; depends_on?: unknown; healthcheck?: unknown; env_file?: unknown }>;
    };

    it("defines the four production services", () => {
      for (const s of ["postgres", "redis", "hub-api", "web"]) {
        expect(compose.services[s]).toBeTruthy();
      }
    });

    it("hub-api and web carry BOTH a registry image and a build block (pull or build-from-source)", () => {
      for (const s of ["hub-api", "web"]) {
        expect(compose.services[s].image).toContain("ghcr.io/simeraycom/tugra-");
        expect(compose.services[s].build).toBeTruthy();
      }
    });

    it("gates hub-api on a healthy database and has a health check itself", () => {
      const dep = compose.services["hub-api"].depends_on as Record<string, { condition: string }>;
      expect(dep.postgres.condition).toBe("service_healthy");
      expect(compose.services["hub-api"].healthcheck).toBeTruthy();
      expect(compose.services["postgres"].healthcheck).toBeTruthy();
    });

    it("keeps secrets OUT of the web container (only the internal proxy target)", () => {
      const webEnv = compose.services["web"].environment ?? {};
      expect(webEnv.HUB_INTERNAL_URL).toBe("http://hub-api:3000");
      expect(compose.services["web"].env_file).toBeUndefined();
      for (const k of Object.keys(webEnv)) {
        expect(k).not.toMatch(/SECRET|KEY|PASSWORD|DATABASE_URL/);
      }
    });

    it("runs Redis unauthenticated (BullMQ workers only use host/port)", () => {
      const redisEnv = compose.services["redis"].environment ?? {};
      expect(Object.keys(redisEnv)).not.toContain("REQUIREPASS");
    });
  });
});
