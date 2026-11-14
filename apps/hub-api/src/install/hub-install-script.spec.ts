import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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

    it("a flag-less re-run KEEPS the updater's digest pins; an explicit TUGRA_VERSION repin or --build clears them", () => {
      const hex = "ab".repeat(32);
      const withPins = (name: string): string => {
        const envPath = join(dir, name);
        run([], envPath);
        writeFileSync(envPath, readFileSync(envPath, "utf8") + `TUGRA_VERSION=0.2.0\nTUGRA_HUB_DIGEST=${hex}\nTUGRA_WEB_DIGEST=${hex}\n`);
        return envPath;
      };
      const keep = withPins("pins-keep.env");
      run([], keep);
      expect(parseEnv(readFileSync(keep, "utf8")).TUGRA_HUB_DIGEST).toBe(hex);

      const repin = withPins("pins-repin.env");
      execFileSync("bash", [INSTALL_SH, "--dry-run", "--env-file", repin], { stdio: "pipe", env: { ...cleanEnv, TUGRA_VERSION: "0.3.0" } });
      const repinned = parseEnv(readFileSync(repin, "utf8"));
      expect(repinned.TUGRA_VERSION).toBe("0.3.0");
      expect(repinned.TUGRA_HUB_DIGEST).toBe(""); // a stale pin would override the new tag
      expect(repinned.TUGRA_WEB_DIGEST).toBe("");

      const built = withPins("pins-build.env");
      run(["--build"], built);
      expect(parseEnv(readFileSync(built, "utf8")).TUGRA_HUB_DIGEST).toBe(""); // a built image can't carry a digest tag
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

    const runEnv = (args: string[], envPath: string, extra: Record<string, string>) =>
      execFileSync("bash", [INSTALL_SH, "--dry-run", "--env-file", envPath, ...args], {
        stdio: "pipe",
        env: { ...cleanEnv, ...extra },
      });
    const HTTP = ["--hub-url", "http://10.0.0.5:3000", "--web-url", "http://10.0.0.5:3001"];
    const read = (p: string) => parseEnv(readFileSync(p, "utf8"));

    describe("http -> https transition rebinds the raw ports (H1)", () => {
      it("http install then --domain moves a 0.0.0.0 bind to 127.0.0.1 and tells the operator", () => {
        const p = join(dir, "tr-rebind.env");
        run(HTTP, p);
        expect(read(p).HUB_BIND).toBe("0.0.0.0");
        const out = run(["--domain", "tugra.example.com"], p).toString();
        const env = read(p);
        expect(env.HUB_TRUSTED_PROXY).toBe("true");
        expect(env.HUB_BIND).toBe("127.0.0.1");
        expect(env.WEB_BIND).toBe("127.0.0.1");
        expect(out).toContain("bound to 127.0.0.1");
        expect(out).toContain("--keep-raw-ports");
      });

      it("--keep-raw-ports (and TUGRA_KEEP_RAW_PORTS=1) leave the 0.0.0.0 bind alone", () => {
        const a = join(dir, "tr-keep-flag.env");
        run(HTTP, a);
        run(["--domain", "tugra.example.com", "--keep-raw-ports"], a);
        expect(read(a).HUB_BIND).toBe("0.0.0.0");
        expect(read(a).WEB_BIND).toBe("0.0.0.0");
        const b = join(dir, "tr-keep-env.env");
        run(HTTP, b);
        runEnv(["--domain", "tugra.example.com"], b, { TUGRA_KEEP_RAW_PORTS: "1" });
        expect(read(b).HUB_BIND).toBe("0.0.0.0");
      });

      it("an explicit private-IP bind survives the transition (never touch a non-0.0.0.0 bind)", () => {
        const p = join(dir, "tr-private.env");
        runEnv(HTTP, p, { HUB_BIND: "10.0.0.9", WEB_BIND: "10.0.0.9" });
        run(["--domain", "tugra.example.com"], p);
        expect(read(p).HUB_BIND).toBe("10.0.0.9");
        expect(read(p).WEB_BIND).toBe("10.0.0.9");
      });

      it("an explicit HUB_BIND=0.0.0.0 on the transition run is honored (operator choice wins)", () => {
        const p = join(dir, "tr-explicit.env");
        run(HTTP, p);
        runEnv(["--domain", "tugra.example.com"], p, { HUB_BIND: "0.0.0.0" });
        expect(read(p).HUB_BIND).toBe("0.0.0.0"); // explicit on this run → untouched
        expect(read(p).WEB_BIND).toBe("127.0.0.1"); // the other half had no explicit choice
      });

      it("a flag-less re-run of an ALREADY-trusted install keeps its binds (the hub peer check protects those)", () => {
        const p = join(dir, "tr-already.env");
        run(["--domain", "tugra.example.com"], p);
        // simulate a legacy https install that was left on 0.0.0.0
        const legacy = readFileSync(p, "utf8").replace(/^HUB_BIND=.*$/m, "HUB_BIND=0.0.0.0").replace(/^WEB_BIND=.*$/m, "WEB_BIND=0.0.0.0");
        writeFileSync(p, legacy);
        const out = run([], p).toString();
        expect(read(p).HUB_BIND).toBe("0.0.0.0");
        expect(read(p).WEB_BIND).toBe("0.0.0.0");
        expect(out).not.toContain("Switching to https");
      });
    });

    describe(".env layer idempotency (H2)", () => {
      it("a custom HUB_PORT/WEB_PORT in an existing .env survives a flag-less re-run (no reset to 3000/3001)", () => {
        const p = join(dir, "ports.env");
        run(["--hub-url", "http://10.0.0.5:3500", "--web-url", "http://10.0.0.5:3501"], p);
        writeFileSync(p, readFileSync(p, "utf8").replace(/^HUB_PORT=.*$/m, "HUB_PORT=3500").replace(/^WEB_PORT=.*$/m, "WEB_PORT=3501"));
        run([], p);
        const env = read(p);
        expect(env.HUB_PORT).toBe("3500");
        expect(env.WEB_PORT).toBe("3501");
        expect(env.HUB_PUBLIC_URL).toBe("http://10.0.0.5:3500");
        // an explicit HUB_PORT in the process env still wins
        runEnv([], p, { HUB_PORT: "4000" });
        expect(read(p).HUB_PORT).toBe("4000");
      });

      it("passing only --hub-url keeps the stored WEB_PUBLIC_URL (the halves are no longer recomputed from the host IP)", () => {
        const p = join(dir, "half-url.env");
        run(["--domain", "tugra.example.com"], p);
        run(["--hub-url", "https://hub.example.org"], p);
        const env = read(p);
        expect(env.HUB_PUBLIC_URL).toBe("https://hub.example.org");
        expect(env.WEB_PUBLIC_URL).toBe("https://tugra.example.com");
        expect(env.HUB_TRUSTED_PROXY).toBe("true");
      });

      it("with bundled TLS on, a new --domain re-points PANEL_DOMAIN (no stale host for the panel router)", () => {
        const p = join(dir, "panel-domain.env");
        run(["--domain", "a.example.com", "--auto-tls", "--acme-email", "ops@real-domain.io"], p);
        expect(read(p).PANEL_DOMAIN).toBe("a.example.com");
        run(["--domain", "b.example.com"], p); // no TLS decision this run
        const env = read(p);
        expect(env.PANEL_TLS).toBe("1");
        expect(env.PANEL_DOMAIN).toBe("b.example.com");
        expect(env.HUB_PUBLIC_URL).toBe("https://b.example.com");
      });

      it("an .env with NO trailing newline is not corrupted: no key glue, JWT secret preserved", () => {
        const p = join(dir, "nonl.env");
        run(HTTP, p);
        const jwt = read(p).JWT_ACCESS_SECRET;
        writeFileSync(p, readFileSync(p, "utf8").replace(/\n+$/, "") + "\nMAIL_HOST=smtp.example.com"); // hand edit, no final \n
        run([], p);
        const text = readFileSync(p, "utf8");
        expect(text).toMatch(/^MAIL_HOST=smtp\.example\.com$/m); // not glued to the next key
        expect(text).not.toMatch(/smtp\.example\.com[A-Z_]+=/);
        expect(read(p).JWT_ACCESS_SECRET).toBe(jwt);
        // and a fresh ensure_env append (a not-yet-present key) after a newline-less tail
        writeFileSync(p, text.replace(/\n+$/, ""));
        run(["--home"], p);
        expect(readFileSync(p, "utf8")).toMatch(/^DEFAULT_UI_MODE=home$/m);
        expect(readFileSync(p, "utf8")).not.toMatch(/[^\n]DEFAULT_UI_MODE=/);
      });

      it("rewrites .env atomically (same-dir temp + mv) and keeps mode 0600 even from a 0644 file", () => {
        const src = readFileSync(INSTALL_SH, "utf8");
        expect(src).toContain('mktemp "${ENV_FILE}.XXXXXX"');
        expect(src).toContain('mv "$tmp" "$ENV_FILE"');
        expect(src).not.toContain('cat "$tmp" > "$ENV_FILE"'); // the old truncate-in-place write is gone
        const p = join(dir, "perm.env");
        run(HTTP, p);
        chmodSync(p, 0o644);
        run(["--no-telemetry"], p);
        expect(statSync(p).mode & 0o777).toBe(0o600);
        expect(readdirSync(dir).filter((f) => /^perm\.env\./.test(f))).toEqual([]); // no stray temp files
      });
    });

    describe("agent image (H4b)", () => {
      it("a fresh install writes neither TUGRA_AGENT_IMAGE nor AGENT_IMAGE (hub default + digest pin apply)", () => {
        const p = join(dir, "agent-fresh.env");
        runEnv(HTTP, p, { TUGRA_VERSION: "0.1.0-beta.9" });
        const env = read(p);
        expect(env.AGENT_IMAGE).toBeUndefined();
        expect(env.TUGRA_AGENT_IMAGE).toBeUndefined();
        expect(env.TUGRA_VERSION).toBe("0.1.0-beta.9");
      });

      it("removes a stale installer-default AGENT_IMAGE but keeps a custom/mirror override", () => {
        const p = join(dir, "agent-stale.env");
        run(HTTP, p);
        writeFileSync(
          p,
          readFileSync(p, "utf8") +
            "TUGRA_AGENT_IMAGE=ghcr.io/simeraycom/tugra-agent:latest\nAGENT_IMAGE=ghcr.io/simeraycom/tugra-agent:0.1.0-beta.1\n",
        );
        run([], p);
        expect(read(p).AGENT_IMAGE).toBeUndefined();
        expect(read(p).TUGRA_AGENT_IMAGE).toBeUndefined();

        const q = join(dir, "agent-mirror.env");
        run(HTTP, q);
        writeFileSync(q, readFileSync(q, "utf8") + "AGENT_IMAGE=registry.internal/mirror/tugra-agent:1.2.3\n");
        run([], q);
        expect(read(q).AGENT_IMAGE).toBe("registry.internal/mirror/tugra-agent:1.2.3");
      });
    });

    describe("DNS-01 token hygiene", () => {
      it("--acme-dns-cloudflare-file reads the token from a file (not argv) and stores it in the 0600 .env", () => {
        const tokFile = join(dir, "cf.token");
        writeFileSync(tokFile, "cf-token-from-file-0123456789\n");
        const p = join(dir, "cf-file.env");
        run(["--domain", "tugra.example.com", "--acme-dns-cloudflare-file", tokFile, "--acme-email", "ops@real-domain.io"], p);
        const env = read(p);
        expect(env.ACME_DNS_PROVIDER).toBe("cloudflare");
        expect(env.ACME_DNS_TOKEN).toBe("cf-token-from-file-0123456789");
        expect(env.PANEL_TLS).toBe("1");
      });

      it("rejects a missing/empty token file, and warns when the token is given on the command line", () => {
        expect(() => run(["--domain", "t.example.com", "--acme-dns-cloudflare-file", join(dir, "nope")], join(dir, "x1.env"))).toThrow();
        const empty = join(dir, "empty.token");
        writeFileSync(empty, "\n");
        expect(() => run(["--domain", "t.example.com", "--acme-dns-cloudflare-file", empty], join(dir, "x2.env"))).toThrow();
        const r = execFileSync(
          "bash",
          [INSTALL_SH, "--dry-run", "--env-file", join(dir, "x3.env"), "--domain", "t.example.com", "--acme-email", "ops@real-domain.io", "--acme-dns-cloudflare", "tok123456789"],
          { stdio: ["ignore", "pipe", "pipe"], env: cleanEnv, encoding: "utf8" },
        );
        expect(r).not.toContain("tok123456789"); // never echoed back
      });
    });

    it("--help prints EVERY flag (it used to cut off after --env-file)", () => {
      const help = execFileSync("bash", [INSTALL_SH, "--help"], { stdio: "pipe", env: cleanEnv }).toString();
      for (const f of ["--restore-from", "--public-ip", "--detect-public-ip", "--no-telemetry", "--enable-update-checks", "--home", "--dry-run", "--keep-raw-ports", "--acme-dns-cloudflare-file"]) {
        expect(help).toContain(f);
      }
      expect(help).not.toContain("set -euo pipefail");
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

  describe("source guards (token / log hygiene, bootstrap-safe)", () => {
    const src = readFileSync(INSTALL_SH, "utf8");
    it("keeps pre-update snapshots (DB dumps + .env copies) out of Docker build contexts and git", () => {
      const lines = readFileSync(join(REPO_ROOT, ".dockerignore"), "utf8").split("\n").map((l) => l.trim());
      expect(lines).toContain("/backups/"); // root-anchored: the repo-root snapshot dir only
      // NEVER an unanchored `backups` / `**/backups`: it would also exclude apps/hub-api/src/backups (source code)
      // from the build context and break the hub image (this happened in the v0.1.0-beta.12 release run).
      expect(lines.filter((l) => /^(\*\*\/)?backups\/?$/.test(l))).toEqual([]);
      expect(lines).toContain("**/pre-update-*.dump");
      expect(lines).toContain("**/pre-update-*.env");
      expect(readFileSync(join(REPO_ROOT, ".gitignore"), "utf8").split("\n")).toContain("backups/");
    });
    it("never puts the DNS token in argv: no `-e ACME_DNS_TOKEN=`, no `Bearer` in a curl -H argument", () => {
      expect(src).not.toContain("-e ACME_DNS_TOKEN=");
      expect(src).not.toMatch(/curl[^\n]*-H[^\n]*Bearer/);
      expect(src).toContain("-K -"); // bearer header travels on stdin as a curl config
    });
    it("has no fixed, predictable /tmp/tugra-*.log paths (a private mktemp -d is used)", () => {
      expect(src).not.toMatch(/\/tmp\/tugra-[a-z-]*\.log/);
      expect(src).toContain('mktemp -d "${TMPDIR:-/tmp}/tugra-install.XXXXXX"');
    });
    it("deletes the generated panel-setup script (it embeds the token) via an EXIT trap and creates it 0600", () => {
      expect(src).toMatch(/trap '[^']*rm -f "\$_setup"/);
      expect(src).toContain('umask 077; mktemp "$LOGDIR/panel-setup.XXXXXX"');
    });
    it("probes the hub on 127.0.0.1 / the specific HUB_BIND and has a docker-inspect fallback when curl is missing", () => {
      expect(src).toContain('_ph="127.0.0.1"');
      expect(src).toContain("docker inspect -f");
      expect(src).not.toContain("http://localhost:${HUB_PORT}/health");
    });
  });

  describe("real run with PATH shims (no Docker needed)", () => {
    const shims = mkdtempSync(join(tmpdir(), "install-shims-"));
    const work = mkdtempSync(join(tmpdir(), "install-run-"));
    afterAll(() => {
      rmSync(shims, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    });
    const BASH = execFileSync("sh", ["-c", "command -v bash"]).toString().trim();
    const LOG = join(shims, "calls.log");

    // docker: logs every call; behaviour is driven by SHIM_* env vars.
    writeFileSync(
      join(shims, "docker"),
      `#!/bin/bash
echo "docker $*" >> "$SHIM_LOG"
case "$1" in
  info) exit 0 ;;
  version) echo 27.0.0; exit 0 ;;
  volume) echo "$SHIM_VOLUMES"; exit 0 ;;
  inspect) echo "$SHIM_INSPECT"; exit 0 ;;
  compose)
    shift
    while [ $# -gt 0 ]; do case "$1" in --profile|--env-file|-f) shift 2 ;; *) break ;; esac; done
    sub="$1"; shift
    case "$sub" in
      version) exit 0 ;;
      pull) if [ -n "$SHIM_PULL_ERR" ]; then echo "$SHIM_PULL_ERR" >&2; exit 1; fi; exit 0 ;;
      up) case "$*" in *postgres*) : > "$SHIM_LOG.pgup" ;; esac; exit 0 ;;
      ps) last="\${@: -1}"
          case "$last" in
            postgres) case " $* " in
                        *" -aq "*) { [ -n "$SHIM_PG_RUNNING" ] || [ -n "$SHIM_PG_STOPPED" ] || [ -e "$SHIM_LOG.pgup" ]; } && echo pgcid ;;
                        *) { [ -n "$SHIM_PG_RUNNING" ] || [ -e "$SHIM_LOG.pgup" ]; } && echo pgcid ;;
                      esac ;;
            *) echo "cid-$last" ;;
          esac
          exit 0 ;;
      exec) case "$*" in *pg_dump*) [ -n "$SHIM_DUMP_FAIL" ] && exit 1; printf 'PGDMP-fake-dump'; exit 0 ;; esac; exit 0 ;;
      run) echo "exit 0"; exit 0 ;;
    esac ;;
esac
exit 0
`,
    );
    writeFileSync(join(shims, "curl"), `#!/bin/bash\necho "curl $*" >> "$SHIM_LOG"\nexit "\${SHIM_CURL_RC:-0}"\n`);
    chmodSync(join(shims, "docker"), 0o755);
    chmodSync(join(shims, "curl"), 0o755);

    // A PATH WITHOUT curl: symlink the host tools the installer needs next to the docker shim.
    const noCurl = join(shims, "nocurl");
    mkdirSync(noCurl);
    for (const t of ["awk", "sed", "grep", "head", "tail", "cut", "tr", "cat", "date", "mktemp", "chmod", "chown", "rm", "mv", "cp", "mkdir", "dirname", "basename", "uname", "od", "base64", "openssl", "sort", "sleep", "stat", "ls", "git", "hostname", "id", "wc", "df", "env", "sh", "bash", "uniq", "tee", "ip", "dig", "getent"]) {
      try {
        const real = execFileSync("sh", ["-c", `command -v ${t}`]).toString().trim();
        if (real.startsWith("/")) symlinkSync(real, join(noCurl, t));
      } catch {
        /* tool not present on this host — fine */
      }
    }
    symlinkSync(join(shims, "docker"), join(noCurl, "docker"));

    interface RunOpts { env?: Record<string, string>; noCurl?: boolean }
    const reset = (): void => {
      writeFileSync(LOG, "");
      rmSync(`${LOG}.pgup`, { force: true });
    };
    const calls = (): string => readFileSync(LOG, "utf8");
    /** First install writes the .env in dry-run (no Docker), the real run then exercises compose. */
    const install = (envPath: string, args: string[], opts: RunOpts = {}): { code: number; out: string } => {
      const base = { PATH: `${opts.noCurl ? noCurl : shims}:${process.env.PATH}`, SHIM_LOG: LOG, TUGRA_HEALTH_TRIES: "1", TUGRA_HEALTH_INTERVAL: "0", TMPDIR: work };
      const env = { ...base, ...(opts.noCurl ? { PATH: noCurl } : {}), ...(opts.env ?? {}) } as NodeJS.ProcessEnv;
      const r = spawnSync(BASH, [INSTALL_SH, "--env-file", envPath, "--no-telemetry", ...args], { env, encoding: "utf8" });
      return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
    };
    const dry = (envPath: string, args: string[], extra: Record<string, string> = {}): void => {
      execFileSync(BASH, [INSTALL_SH, "--dry-run", "--env-file", envPath, "--no-telemetry", ...args], {
        stdio: "pipe",
        env: { PATH: process.env.PATH, ...extra } as NodeJS.ProcessEnv,
      });
    };
    const HTTP = ["--hub-url", "http://10.0.0.5:3000", "--web-url", "http://10.0.0.5:3001"];
    const readEnv = (p: string) => parseEnv(readFileSync(p, "utf8"));

    describe("health check (H3)", () => {
      it("exits 1 and never claims 'up' when the hub never becomes healthy", () => {
        const p = join(work, "h-fail.env"); reset();
        const r = install(p, HTTP, { env: { SHIM_CURL_RC: "1" } });
        expect(r.code).toBe(1);
        expect(r.out).not.toContain("Tugra is up");
      });

      it("probes 127.0.0.1 by default, and the specific HUB_BIND when the operator bound a private IP", () => {
        const a = join(work, "h-ok.env"); reset();
        const ra = install(a, HTTP, { env: { SHIM_CURL_RC: "0" } });
        expect(ra.code).toBe(0);
        expect(ra.out).toContain("Tugra is up");
        expect(calls()).toContain("curl -fsS http://127.0.0.1:3000/health");
        const b = join(work, "h-bind.env"); reset();
        install(b, HTTP, { env: { HUB_BIND: "10.0.0.9", WEB_BIND: "10.0.0.9" } });
        expect(calls()).toContain("curl -fsS http://10.0.0.9:3000/health");
        expect(calls()).not.toContain("localhost");
      });

      it("without curl it falls back to the docker health status", () => {
        const p = join(work, "h-nocurl.env"); reset();
        const r = install(p, HTTP, { noCurl: true, env: { SHIM_INSPECT: "healthy" } });
        expect(r.code).toBe(0);
        expect(r.out).toContain("Tugra is up");
        expect(calls()).toContain("docker inspect");
      });

      it("without curl AND no readable docker health it exits 0 but does NOT claim 'up'", () => {
        const p = join(work, "h-unknown.env"); reset();
        const r = install(p, HTTP, { noCurl: true, env: { SHIM_INSPECT: "" } });
        expect(r.code).toBe(0);
        expect(r.out).toContain("Could not verify");
        expect(r.out).not.toContain("Tugra is up");
      });
    });

    describe("pull failure policy (H5)", () => {
      it("a pinned TUGRA_VERSION whose pull fails stops — it never builds unreleased checkout code", () => {
        const p = join(work, "pull-pinned.env"); reset();
        const r = install(p, HTTP, { env: { TUGRA_VERSION: "0.1.0-beta.9", SHIM_PULL_ERR: "manifest unknown" } });
        expect(r.code).toBe(1);
        expect(calls()).not.toMatch(/up -d/);
        expect(r.out).toContain("pinned");
      });

      it("a transient failure (rate limit) on an unpinned install also stops instead of source-building", () => {
        const p = join(work, "pull-rate.env"); reset();
        const r = install(p, HTTP, { env: { SHIM_PULL_ERR: "toomanyrequests: You have reached your pull rate limit" } });
        expect(r.code).toBe(1);
        expect(calls()).not.toContain("--build");
      });

      it("only a genuinely missing image (no matching manifest) on an unpinned install falls back to --build", () => {
        const p = join(work, "pull-missing.env"); reset();
        const r = install(p, HTTP, { env: { SHIM_PULL_ERR: "no matching manifest for linux/arm64/v8 in the manifest list entries" } });
        expect(r.code).toBe(0);
        expect(calls()).toContain("up -d --build");
      });
    });

    describe("pre-update snapshot on a re-run (H6)", () => {
      const withBackupDir = (name: string, extra: Record<string, string> = {}) => {
        const dirp = join(work, `bk-${name}`);
        return { dirp, env: { TUGRA_BACKUP_DIR: dirp, SHIM_PG_RUNNING: "1", ...extra } };
      };

      it("dumps the database + .env BEFORE any pull/up, into a 0700 dir with 0600 files", () => {
        const p = join(work, "snap-ok.env"); dry(p, HTTP);
        const { dirp, env } = withBackupDir("ok"); reset();
        const r = install(p, HTTP, { env });
        expect(r.code).toBe(0);
        const log = calls();
        expect(log.indexOf("exec -T postgres pg_dump -U tugra -Fc tugra")).toBeGreaterThan(-1);
        expect(log.indexOf("pg_dump")).toBeLessThan(log.indexOf(" pull"));
        expect(log.indexOf("pg_dump")).toBeLessThan(log.indexOf("up -d"));
        const files = readdirSync(dirp);
        expect(files.filter((f) => f.endsWith(".dump")).length).toBe(1);
        expect(files.filter((f) => f.endsWith(".env")).length).toBe(1);
        expect(statSync(dirp).mode & 0o777).toBe(0o700);
        for (const f of files) expect(statSync(join(dirp, f)).mode & 0o777).toBe(0o600);
        expect(files.some((f) => f.includes("pre-update-latest-to-latest-"))).toBe(true);
      });

      it("a FAILED dump aborts before anything is pulled or recreated (exit 1, restore hint)", () => {
        const p = join(work, "snap-fail.env"); dry(p, HTTP);
        const { dirp, env } = withBackupDir("fail", { SHIM_DUMP_FAIL: "1" }); reset();
        const r = install(p, HTTP, { env });
        expect(r.code).toBe(1);
        expect(r.out).toContain("Pre-update backup failed");
        expect(calls()).not.toContain(" pull");
        expect(calls()).not.toContain("up -d");
        expect(existsSync(dirp) ? readdirSync(dirp).filter((f) => f.endsWith(".dump") || f.endsWith(".part")) : []).toEqual([]);
      });

      it("PRE_UPDATE_BACKUP=0 is the only opt-out; a fresh install (no running postgres) takes no snapshot", () => {
        const p = join(work, "snap-off.env"); dry(p, HTTP);
        writeFileSync(p, readFileSync(p, "utf8") + "PRE_UPDATE_BACKUP=0\n");
        const { env } = withBackupDir("off"); reset();
        expect(install(p, HTTP, { env }).code).toBe(0);
        expect(calls()).not.toContain("pg_dump");

        const q = join(work, "snap-fresh.env"); reset();
        expect(install(q, HTTP, { env: { TUGRA_BACKUP_DIR: join(work, "bk-fresh") } }).code).toBe(0); // no SHIM_PG_RUNNING
        expect(calls()).not.toContain("pg_dump");
      });
    });

    describe("abort paths leave the pre-run .env intact; stopped stacks are protected; env hygiene", () => {
      const bk = (name: string) => join(work, `bk2-${name}`);

      it("a failing pg_dump on a re-run (even with --domain) aborts and leaves .env BYTE-IDENTICAL", () => {
        const p = join(work, "abort-dump.env"); dry(p, HTTP);
        const before = readFileSync(p);
        reset();
        const r = install(p, ["--domain", "tugra.example.com"], { env: { SHIM_PG_RUNNING: "1", SHIM_DUMP_FAIL: "1", TUGRA_BACKUP_DIR: bk("dumpfail") } });
        expect(r.code).toBe(1);
        expect(r.out).toContain("restored to its pre-run state");
        expect(r.out).not.toContain("nothing was changed");
        expect(readFileSync(p).equals(before)).toBe(true);
        expect(calls()).not.toContain("up -d --no-build");
      });

      it("a pinned TUGRA_VERSION pull failure restores the OLD TUGRA_VERSION (and the whole .env)", () => {
        const p = join(work, "abort-pull.env");
        dry(p, HTTP, { TUGRA_VERSION: "0.1.0-beta.1" });
        const before = readFileSync(p);
        reset();
        const r = install(p, HTTP, { env: { TUGRA_VERSION: "0.1.0-beta.9", SHIM_PULL_ERR: "manifest unknown" } });
        expect(r.code).toBe(1);
        expect(r.out).toContain("beta.9"); // the message names the version that was requested
        expect(readEnv(p).TUGRA_VERSION).toBe("0.1.0-beta.1");
        expect(readFileSync(p).equals(before)).toBe(true);
      });

      it("a FRESH install (no prior .env) keeps its generated .env on a pull failure and says so", () => {
        const p = join(work, "abort-fresh.env"); reset();
        const r = install(p, HTTP, { env: { SHIM_PULL_ERR: "toomanyrequests" } });
        expect(r.code).toBe(1);
        expect(r.out).toContain("fresh install");
        expect(existsSync(p)).toBe(true);
      });

      it("a STOPPED stack (ps -q empty, ps -aq non-empty) gets postgres started, then the dump, then the upgrade", () => {
        const p = join(work, "stopped.env"); dry(p, HTTP); reset();
        const r = install(p, HTTP, { env: { SHIM_PG_STOPPED: "1", SHIM_INSPECT: "healthy", TUGRA_BACKUP_DIR: bk("stopped") } });
        expect(r.code).toBe(0);
        const log = calls();
        const start = log.indexOf("up -d --no-deps postgres");
        expect(start).toBeGreaterThan(-1);
        expect(start).toBeLessThan(log.indexOf("pg_dump"));
        expect(log.indexOf("pg_dump")).toBeLessThan(log.indexOf(" pull"));
        expect(readdirSync(bk("stopped")).some((f) => f.endsWith(".dump"))).toBe(true);
      });

      it("a populated tugra_pg VOLUME alone (no containers) also counts as an existing install", () => {
        const p = join(work, "volume.env"); dry(p, HTTP); reset();
        const r = install(p, HTTP, { env: { SHIM_VOLUMES: "tugra_tugra_pg", SHIM_INSPECT: "healthy", TUGRA_BACKUP_DIR: bk("volume") } });
        expect(r.code).toBe(0);
        expect(calls()).toContain("up -d --no-deps postgres");
        expect(calls()).toContain("pg_dump");
      });

      it("a stopped stack whose postgres never becomes healthy aborts (bounded) with the .env restored", () => {
        const p = join(work, "stopped-bad.env"); dry(p, HTTP);
        const before = readFileSync(p); reset();
        const r = install(p, ["--domain", "t.example.com"], { env: { SHIM_PG_STOPPED: "1", SHIM_INSPECT: "starting", TUGRA_PG_TRIES: "2", TUGRA_BACKUP_DIR: bk("stopped-bad") } });
        expect(r.code).toBe(1);
        expect(r.out).toContain("Could not start postgres");
        expect(calls()).not.toContain("pg_dump");
        expect(readFileSync(p).equals(before)).toBe(true);
      });

      it("an inherited DRY=1 in the environment can NOT skip the real snapshot", () => {
        const p = join(work, "dryenv.env"); dry(p, HTTP); reset();
        const r = install(p, HTTP, { env: { DRY: "1", SHIM_PG_RUNNING: "1", TUGRA_BACKUP_DIR: bk("dryenv") } });
        expect(r.code).toBe(0);
        expect(calls()).toContain("pg_dump");
        expect(readdirSync(bk("dryenv")).some((f) => f.endsWith(".dump"))).toBe(true);
        expect(readFileSync(join(__dirname, "..", "..", "..", "..", "scripts", "lib", "snapshot.sh"), "utf8")).not.toMatch(/\$\{DRY:-/);
      });

      it("a hand-quoted HUB_PORT=\"3500\" / WEB_PORT with CRLF in .env does not trip the numeric guard on a re-run", () => {
        const p = join(work, "quoted.env"); dry(p, HTTP);
        writeFileSync(p, readFileSync(p, "utf8").replace(/^HUB_PORT=.*$/m, 'HUB_PORT="3500"').replace(/^WEB_PORT=.*$/m, "WEB_PORT=3501\r"));
        execFileSync(BASH, [INSTALL_SH, "--dry-run", "--env-file", p, "--no-telemetry"], { stdio: "pipe", env: { PATH: process.env.PATH } as NodeJS.ProcessEnv });
        expect(readEnv(p).HUB_PORT).toBe("3500");
        expect(readEnv(p).WEB_PORT).toBe("3501");
      });
    });

    describe("panel TLS + raw-port rebind (H1) and token hygiene", () => {
      const tokFile = join(work, "cf2.token");
      writeFileSync(tokFile, "cf-secret-token-ABCDEF0123456789\n");

      it("keeps the DNS token out of every docker/curl argv, and removes the setup script on exit", () => {
        const p = join(work, "tls-token.env"); reset();
        const r = install(p, ["--domain", "tugra.example.com", "--acme-email", "ops@real-domain.io", "--acme-dns-cloudflare-file", tokFile]);
        expect(r.code).toBe(0);
        expect(calls()).not.toContain("cf-secret-token-ABCDEF0123456789");
        expect(calls()).toContain("-e ACME_DNS_TOKEN "); // forwarded by name from the environment, no value
        expect(calls()).toContain("curl -sS --max-time 6 -K - https://api.cloudflare.com");
        // the private log dir is under the test TMPDIR; no panel-setup.* script is left behind
        const leftovers = readdirSync(work).filter((d) => d.startsWith("tugra-install."));
        for (const d of leftovers) expect(readdirSync(join(work, d)).filter((f) => f.startsWith("panel-setup.") && !f.endsWith(".log"))).toEqual([]);
        for (const d of leftovers) expect(statSync(join(work, d)).mode & 0o777).toBe(0o700);
      });

      /** A legacy https + bundled-TLS install that is still published on 0.0.0.0. */
      const legacyTls = (name: string): string => {
        const p = join(work, `${name}.env`);
        dry(p, ["--domain", "tugra.example.com", "--auto-tls", "--acme-email", "ops@real-domain.io"]);
        writeFileSync(p, readFileSync(p, "utf8").replace(/^HUB_BIND=.*$/m, "HUB_BIND=0.0.0.0").replace(/^WEB_BIND=.*$/m, "WEB_BIND=0.0.0.0"));
        return p;
      };

      it("once the panel router is verified live, a still-0.0.0.0 bind moves to 127.0.0.1 and hub/web are recreated", () => {
        const p = legacyTls("tls-rebind"); reset();
        const r = install(p, [], { env: { SHIM_CURL_RC: "0" } });
        expect(r.code).toBe(0);
        const env = readEnv(p);
        expect(env.HUB_BIND).toBe("127.0.0.1");
        expect(env.WEB_BIND).toBe("127.0.0.1");
        expect(calls()).toContain("up -d --no-deps hub-api web");
        expect(r.out).toContain("loopback-only");
      });

      it("--keep-raw-ports and an explicit HUB_BIND both opt out of that rebind", () => {
        const a = legacyTls("tls-keep"); reset();
        install(a, ["--keep-raw-ports"]);
        expect(readEnv(a).HUB_BIND).toBe("0.0.0.0");
        expect(calls()).not.toContain("--no-deps hub-api web");
        const b = legacyTls("tls-explicit"); reset();
        install(b, [], { env: { HUB_BIND: "0.0.0.0" } });
        expect(readEnv(b).HUB_BIND).toBe("0.0.0.0");
      });

      it("when the panel router does NOT come up, nothing is rebound (the failure message promises host-port access)", () => {
        const p = legacyTls("tls-down"); reset();
        // every curl fails: the hub never reports healthy, so the panel step is skipped entirely
        const r = install(p, [], { env: { SHIM_CURL_RC: "1" } });
        expect(r.code).toBe(1);
        expect(readEnv(p).HUB_BIND).toBe("0.0.0.0");
      });
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

    it("digest-pins the third-party postgres/redis images (tag-readable AND @sha256-pinned)", () => {
      // Supply-chain: the third-party images must be pinned to a multi-arch index digest so a moved tag
      // can't swap them, while the readable `:16-alpine`/`:7-alpine` tag is kept for docs/messages. Dependabot
      // (.github/dependabot.yml) refreshes the digest within the major. Drift-guard against a silent revert
      // back to a floating tag.
      expect(compose.services["postgres"].image).toMatch(/^postgres:16-alpine@sha256:[0-9a-f]{64}$/);
      expect(compose.services["redis"].image).toMatch(/^redis:7-alpine@sha256:[0-9a-f]{64}$/);
    });

    it("leaves the first-party images on ${TUGRA_VERSION} with NO hard-coded digest (pin is an opt-in env suffix)", () => {
      // First-party images are threaded from the signed update manifest by the updater sidecar (env, not a
      // literal in compose) — so they must stay on the interpolated tag and never carry a literal @sha256:hex
      // that the digest-pin guard above (third-party) would otherwise treat as a Dependabot-managed pin.
      for (const s of ["hub-api", "web", "agent", "tugra-updater"]) {
        expect(compose.services[s].image).toContain("ghcr.io/simeraycom/tugra-");
        expect(compose.services[s].image).toContain("${TUGRA_VERSION");
        expect(compose.services[s].image).not.toMatch(/@sha256:[0-9a-f]{64}/);
      }
    });

    it("hub-api and web gain the OPTIONAL digest suffix (TUGRA_HUB_DIGEST / TUGRA_WEB_DIGEST), tag still first", () => {
      expect(compose.services["hub-api"].image).toBe(
        "ghcr.io/simeraycom/tugra-hub:${TUGRA_VERSION:-latest}${TUGRA_HUB_DIGEST:+@sha256:}${TUGRA_HUB_DIGEST:-}",
      );
      expect(compose.services["web"].image).toBe(
        "ghcr.io/simeraycom/tugra-web:${TUGRA_VERSION:-latest}${TUGRA_WEB_DIGEST:+@sha256:}${TUGRA_WEB_DIGEST:-}",
      );
      // The agent + updater services are NOT part of the digest-pinned update path (update.sh recreates hub-api/web only).
      for (const s of ["agent", "tugra-updater"]) expect(compose.services[s].image).not.toContain("_DIGEST");
    });

    // Minimal emulation of compose's `${VAR:-default}` / `${VAR:+alt}` (unset OR empty counts as unset), enough to
    // prove the two flat (NON-nested) substitutions resolve to the legacy tag ref when unset and `repo:tag@sha256:hex`
    // when set. The real interpolator is exercised by the docker-gated test below.
    const interpolate = (tpl: string, env: Record<string, string>): string =>
      tpl.replace(/\$\{([A-Z_]+)(?::([-+]))?([^}]*)\}/g, (_m, name: string, op: string | undefined, word: string) => {
        const v = env[name] ?? "";
        if (op === "-") return v !== "" ? v : word;
        if (op === "+") return v !== "" ? word : "";
        return v;
      });

    it("resolves to exactly the legacy tag ref when the digest var is unset or empty", () => {
      const hub = compose.services["hub-api"].image!;
      expect(interpolate(hub, { TUGRA_VERSION: "0.1.0" })).toBe("ghcr.io/simeraycom/tugra-hub:0.1.0");
      expect(interpolate(hub, {})).toBe("ghcr.io/simeraycom/tugra-hub:latest");
      expect(interpolate(hub, { TUGRA_VERSION: "0.1.0", TUGRA_HUB_DIGEST: "" })).toBe("ghcr.io/simeraycom/tugra-hub:0.1.0");
    });

    it("resolves to repo:tag@sha256:<hex> when the digest var is set (what the agent pull already uses)", () => {
      const hex = "ab".repeat(32);
      expect(interpolate(compose.services["hub-api"].image!, { TUGRA_VERSION: "0.2.0", TUGRA_HUB_DIGEST: hex })).toBe(
        `ghcr.io/simeraycom/tugra-hub:0.2.0@sha256:${hex}`,
      );
      expect(interpolate(compose.services["web"].image!, { TUGRA_WEB_DIGEST: hex })).toBe(`ghcr.io/simeraycom/tugra-web:latest@sha256:${hex}`);
      // the hub var never leaks into web
      expect(interpolate(compose.services["web"].image!, { TUGRA_HUB_DIGEST: hex })).toBe("ghcr.io/simeraycom/tugra-web:latest");
    });

    // Real compose interpolation, only where a Docker CLI with the compose plugin is present (CI runners have it).
    const hasCompose = (() => {
      try {
        execFileSync("docker", ["compose", "version"], { stdio: "pipe" });
        return true;
      } catch {
        return false;
      }
    })();
    (hasCompose ? it : it.skip)("docker compose config resolves the suffix with and without the digest vars", () => {
      const hex = "cd".repeat(32);
      const images = (env: Record<string, string>): string[] =>
        execFileSync("docker", ["compose", "-f", COMPOSE, "config", "--images"], {
          stdio: "pipe",
          env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } as NodeJS.ProcessEnv,
        })
          .toString()
          .split("\n");
      const plain = images({ TUGRA_VERSION: "0.2.0" });
      expect(plain).toContain("ghcr.io/simeraycom/tugra-hub:0.2.0");
      expect(plain).toContain("ghcr.io/simeraycom/tugra-web:0.2.0");
      const pinned = images({ TUGRA_VERSION: "0.2.0", TUGRA_HUB_DIGEST: hex, TUGRA_WEB_DIGEST: hex });
      expect(pinned).toContain(`ghcr.io/simeraycom/tugra-hub:0.2.0@sha256:${hex}`);
      expect(pinned).toContain(`ghcr.io/simeraycom/tugra-web:0.2.0@sha256:${hex}`);
    });
  });
});
