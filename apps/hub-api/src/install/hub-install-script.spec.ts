import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

// Repo-root artifacts (jest rootDir is src/, but __dirname resolves to the real source dir).
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const INSTALL_SH = join(REPO_ROOT, "scripts", "install.sh");
const COMPOSE = join(REPO_ROOT, "deploy", "docker-compose.yml");
const HTTP_URLS = ["--hub-url", "http://10.0.0.5:3000", "--web-url", "http://10.0.0.5:3001"];

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

    describe("--cloudflare-proxy (orange-cloud client IP mode)", () => {
      const runCf = (args: string[], envPath: string) =>
        spawnSync("bash", [INSTALL_SH, "--dry-run", "--env-file", envPath, ...args], { encoding: "utf8", env: cleanEnv });

      it("is off by default: nothing is written for a plain --domain install", () => {
        const envPath = join(dir, "cf-default.env");
        run(["--domain", "tugra.example.com"], envPath);
        expect(parseEnv(readFileSync(envPath, "utf8")).HUB_TRUSTED_PROXY_CLOUDFLARE).toBeUndefined();
      });
      it("sets HUB_TRUSTED_PROXY_CLOUDFLARE=true alongside the trusted proxy with --domain", () => {
        const envPath = join(dir, "cf-on.env");
        run(["--domain", "tugra.example.com", "--cloudflare-proxy"], envPath);
        const env = parseEnv(readFileSync(envPath, "utf8"));
        expect(env.HUB_TRUSTED_PROXY).toBe("true");
        expect(env.HUB_TRUSTED_PROXY_CLOUDFLARE).toBe("true");
      });
      it("refuses (and writes nothing) without an https origin: Cloudflare cannot proxy a bare IP", () => {
        const envPath = join(dir, "cf-http.env");
        const r = runCf(["--hub-url", "http://10.0.0.5:3000", "--web-url", "http://10.0.0.5:3001", "--cloudflare-proxy"], envPath);
        expect(r.status).not.toBe(0);
        expect(`${r.stdout}${r.stderr}`).toMatch(/--cloudflare-proxy needs the panel served over https/);
        expect(existsSync(envPath)).toBe(false);
      });
      it("a flag-less re-run keeps it; --no-cloudflare-proxy turns it off", () => {
        const envPath = join(dir, "cf-rerun.env");
        run(["--domain", "tugra.example.com", "--cloudflare-proxy"], envPath);
        run([], envPath);
        expect(parseEnv(readFileSync(envPath, "utf8")).HUB_TRUSTED_PROXY_CLOUDFLARE).toBe("true");
        run(["--no-cloudflare-proxy"], envPath);
        expect(parseEnv(readFileSync(envPath, "utf8")).HUB_TRUSTED_PROXY_CLOUDFLARE).toBe("false");
      });
      it("downgrading to plain http CLEARS it (the hub refuses to boot with CLOUDFLARE=true and no trusted proxy)", () => {
        const envPath = join(dir, "cf-downgrade.env");
        run(["--domain", "tugra.example.com", "--cloudflare-proxy"], envPath);
        run(["--hub-url", "http://10.0.0.5:3000", "--web-url", "http://10.0.0.5:3001"], envPath);
        const env = parseEnv(readFileSync(envPath, "utf8"));
        expect(env.HUB_TRUSTED_PROXY).toBe("false");
        expect(env.HUB_TRUSTED_PROXY_CLOUDFLARE).toBe("false");
      });
      it("rejects a bad TUGRA_CLOUDFLARE_PROXY value", () => {
        const envPath = join(dir, "cf-bad.env");
        const r = spawnSync("bash", [INSTALL_SH, "--dry-run", "--env-file", envPath, "--domain", "tugra.example.com"], {
          encoding: "utf8",
          env: { ...cleanEnv, TUGRA_CLOUDFLARE_PROXY: "maybe" },
        });
        expect(r.status).not.toBe(0);
      });
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

    it("the --raw-ports quick-start binds the published ports to 0.0.0.0 (agents dial host:3000)", () => {
      const envPath = join(dir, "bind-quick.env");
      run(["--raw-ports"], envPath);
      const env = parseEnv(readFileSync(envPath, "utf8"));
      expect(env.HUB_BIND).toBe("0.0.0.0");
      expect(env.WEB_BIND).toBe("0.0.0.0");
    });

    describe("IP mode: a plain install serves the panel on http://<ip>/ (port 80) through Tugra's own proxy", () => {
      const runIp = (args: string[], envPath: string, extra: Record<string, string> = {}) =>
        execFileSync("bash", [INSTALL_SH, "--dry-run", "--env-file", envPath, ...args], { stdio: "pipe", env: { ...cleanEnv, ...extra } });
      const rawEnv = (name: string): string => {
        // an install made before IP mode existed: raw ports, no PANEL_IP_ROUTE
        const p = join(dir, name);
        run(["--raw-ports"], p);
        return p;
      };

      it("a fresh install with NO flags: no port in the URLs, trusted proxy, http cookies, loopback raw ports, IP route on", () => {
        const p = join(dir, "ip-fresh.env");
        run([], p);
        const env = parseEnv(readFileSync(p, "utf8"));
        expect(env.HUB_PUBLIC_URL).toMatch(/^http:\/\/[^:/]+$/);
        expect(env.WEB_PUBLIC_URL).toBe(env.HUB_PUBLIC_URL);
        expect(env.PANEL_IP_ROUTE).toBe("1");
        expect(env.HUB_TRUSTED_PROXY).toBe("true"); // exactly one hop: Tugra's own proxy
        expect(env.COOKIE_SECURE).toBe("false"); // plain http: Secure cookies would kill the login
        expect(env.HUB_BIND).toBe("127.0.0.1"); // only the proxy needs the raw ports, so 80/443 are all that must be open
        expect(env.WEB_BIND).toBe("127.0.0.1");
        expect(env.PANEL_TLS).toBeUndefined();
      });
      it("--public-ip names the address the URL uses (a cloud box behind NAT)", () => {
        const p = join(dir, "ip-pub.env");
        run(["--public-ip", "203.0.113.9"], p);
        expect(parseEnv(readFileSync(p, "utf8")).WEB_PUBLIC_URL).toBe("http://203.0.113.9");
      });
      it("--raw-ports (and TUGRA_RAW_PORTS=1) keep the classic http://<ip>:3001 quick start with no proxy", () => {
        for (const [name, args, extra] of [["ip-raw-a.env", ["--raw-ports"], {}], ["ip-raw-b.env", [], { TUGRA_RAW_PORTS: "1" }]] as const) {
          const p = join(dir, name);
          runIp([...args], p, extra);
          const env = parseEnv(readFileSync(p, "utf8"));
          expect(env.HUB_PUBLIC_URL).toMatch(/:3000$/);
          expect(env.WEB_PUBLIC_URL).toMatch(/:3001$/);
          expect(env.PANEL_IP_ROUTE).toBeUndefined();
          expect(env.HUB_TRUSTED_PROXY).toBe("false");
        }
      });
      it("explicit --hub-url/--web-url are honored as before (no IP mode)", () => {
        const p = join(dir, "ip-explicit.env");
        run(HTTP_URLS, p);
        const env = parseEnv(readFileSync(p, "utf8"));
        expect(env.HUB_PUBLIC_URL).toBe("http://10.0.0.5:3000");
        expect(env.PANEL_IP_ROUTE).toBeUndefined();
      });
      it("an EXISTING install (raw ports, no PANEL_IP_ROUTE) is never moved by a flag-less upgrade re-run", () => {
        const p = rawEnv("ip-existing.env");
        const before = parseEnv(readFileSync(p, "utf8"));
        run([], p);
        const after = parseEnv(readFileSync(p, "utf8"));
        expect(after.HUB_PUBLIC_URL).toBe(before.HUB_PUBLIC_URL);
        expect(after.WEB_PUBLIC_URL).toBe(before.WEB_PUBLIC_URL);
        expect(after.PANEL_IP_ROUTE).toBeUndefined();
        expect(after.HUB_TRUSTED_PROXY).toBe("false");
        expect(after.HUB_BIND).toBe("0.0.0.0");
      });
      it("an IP-mode install keeps its mode and URLs on a flag-less re-run", () => {
        const p = join(dir, "ip-rerun.env");
        run(["--public-ip", "203.0.113.9"], p);
        const first = parseEnv(readFileSync(p, "utf8"));
        run([], p);
        const second = parseEnv(readFileSync(p, "utf8"));
        expect(second.WEB_PUBLIC_URL).toBe(first.WEB_PUBLIC_URL);
        expect(second.PANEL_IP_ROUTE).toBe("1");
        expect(second.HUB_TRUSTED_PROXY).toBe("true");
        expect(second.POSTGRES_PASSWORD).toBe(first.POSTGRES_PASSWORD);
      });
      it("moving an IP-mode install to --domain turns the IP route off and bundled TLS on", () => {
        const p = join(dir, "ip-to-domain.env");
        run([], p);
        run(["--domain", "panel.example.com"], p);
        const env = parseEnv(readFileSync(p, "utf8"));
        expect(env.HUB_PUBLIC_URL).toBe("https://panel.example.com");
        expect(env.PANEL_IP_ROUTE).toBe("0");
        expect(env.PANEL_TLS).toBe("1");
        expect(env.PANEL_DOMAIN).toBe("panel.example.com");
        expect(env.COOKIE_SECURE).toBe("true");
      });
      it("going back to explicit http URLs turns IP mode off and clears the proxy trust (spoof-safe)", () => {
        const p = join(dir, "ip-downgrade.env");
        run([], p);
        run(HTTP_URLS, p);
        const env = parseEnv(readFileSync(p, "utf8"));
        expect(env.PANEL_IP_ROUTE).toBe("0");
        expect(env.HUB_TRUSTED_PROXY).toBe("false");
      });
      it("--cloudflare-proxy is refused on the http IP-mode origin (Cloudflare only proxies a hostname)", () => {
        const p = join(dir, "ip-cf.env");
        const r = spawnSync("bash", [INSTALL_SH, "--dry-run", "--env-file", p, "--cloudflare-proxy"], { encoding: "utf8", env: cleanEnv });
        expect(r.status).not.toBe(0);
        expect(`${r.stdout}${r.stderr}`).toMatch(/--cloudflare-proxy needs the panel served over https/);
      });
    });

    describe("--domain provisions the panel HTTPS by itself: no token, no email", () => {
      it("headless --domain alone turns bundled TLS on and writes NO ACME email", () => {
        const p = join(dir, "dom-default.env");
        run(["--domain", "panel.example.com"], p);
        const env = parseEnv(readFileSync(p, "utf8"));
        expect(env.PANEL_TLS).toBe("1");
        expect(env.PANEL_DOMAIN).toBe("panel.example.com");
        expect(env.ACME_EMAIL).toBeUndefined();
        expect(env.ACME_DNS_TOKEN).toBeUndefined(); // no Cloudflare token anywhere
      });
      it("--no-auto-tls keeps bring-your-own-proxy", () => {
        const p = join(dir, "dom-byo.env");
        run(["--domain", "panel.example.com", "--no-auto-tls"], p);
        expect(parseEnv(readFileSync(p, "utf8")).PANEL_TLS).toBe("0");
      });
      it("an optional --acme-email is stored, and a placeholder one is refused before anything is written", () => {
        const ok = join(dir, "dom-mail.env");
        run(["--domain", "panel.example.com", "--acme-email", "ops@real-domain.io"], ok);
        expect(parseEnv(readFileSync(ok, "utf8")).ACME_EMAIL).toBe("ops@real-domain.io");
        const bad = join(dir, "dom-mail-bad.env");
        const r = spawnSync("bash", [INSTALL_SH, "--dry-run", "--env-file", bad, "--domain", "panel.example.com", "--acme-email", "admin@example.com"], { encoding: "utf8", env: cleanEnv });
        expect(r.status).not.toBe(0);
        expect(existsSync(bad)).toBe(false);
      });
      it("an https install from before PANEL_TLS existed (own proxy, maybe on another host) is NOT switched to bundled TLS by a flag-less --domain re-run", () => {
        const p = join(dir, "dom-legacy-https.env");
        run(["--domain", "a.example.com", "--no-auto-tls"], p);
        writeFileSync(p, readFileSync(p, "utf8").replace(/^PANEL_TLS=.*\n/m, "").replace(/^HUB_BIND=.*$/m, "HUB_BIND=0.0.0.0").replace(/^WEB_BIND=.*$/m, "WEB_BIND=0.0.0.0"));
        run(["--domain", "a.example.com"], p);
        const env = parseEnv(readFileSync(p, "utf8"));
        expect(env.PANEL_TLS).toBeUndefined();
        expect(env.HUB_BIND).toBe("0.0.0.0");
        run(["--domain", "a.example.com", "--auto-tls"], p); // the explicit opt-in still works
        expect(parseEnv(readFileSync(p, "utf8")).PANEL_TLS).toBe("1");
      });
      it("a re-run with a new --domain keeps an install's stored PANEL_TLS decision (BYO stays BYO)", () => {
        const p = join(dir, "dom-keep.env");
        run(["--domain", "a.example.com", "--no-auto-tls"], p);
        run(["--domain", "b.example.com"], p);
        expect(parseEnv(readFileSync(p, "utf8")).PANEL_TLS).toBe("0");
      });
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

    describe("signed self-update checks are ON by default (opt-out)", () => {
      const KEYS = ["UPDATE_MANIFEST_URL", "UPDATE_PUBLISHER_KEY", "TUGRA_UPDATE_CHECKS"];
      const lineCount = (p: string, key: string): number => (readFileSync(p, "utf8").match(new RegExp(`^${key}=`, "gm")) ?? []).length;

      it("no flags writes neither the manifest URL, the publisher key nor TUGRA_UPDATE_CHECKS (the hub carries the official values)", () => {
        const p = join(dir, "upd-default.env");
        run([], p);
        const env = parseEnv(readFileSync(p, "utf8"));
        for (const k of KEYS) expect(env[k]).toBeUndefined();
      });

      it("--no-update-checks writes TUGRA_UPDATE_CHECKS=0 and a flag-less re-run keeps it", () => {
        const p = join(dir, "upd-off.env");
        run(["--no-update-checks"], p);
        expect(parseEnv(readFileSync(p, "utf8")).TUGRA_UPDATE_CHECKS).toBe("0");
        run([], p);
        expect(parseEnv(readFileSync(p, "utf8")).TUGRA_UPDATE_CHECKS).toBe("0");
      });

      it("--enable-update-checks on a re-run flips a stored opt-out back to 1 with exactly one line", () => {
        const p = join(dir, "upd-reenable.env");
        run(["--no-update-checks"], p);
        run(["--enable-update-checks"], p);
        expect(parseEnv(readFileSync(p, "utf8")).TUGRA_UPDATE_CHECKS).toBe("1");
        expect(lineCount(p, "TUGRA_UPDATE_CHECKS")).toBe(1);
      });

      it("the two flags together are rejected", () => {
        const p = join(dir, "upd-both.env");
        const r = spawnSync("bash", [INSTALL_SH, "--dry-run", "--env-file", p, "--no-update-checks", "--enable-update-checks"], { env: cleanEnv, encoding: "utf8" });
        expect(r.status).toBe(1);
        expect(`${r.stdout}${r.stderr}`).toContain("mutually exclusive");
      });

      it("the env form TUGRA_UPDATE_CHECKS=0 opts out (the one-line bootstrap passes the variable the hub reads)", () => {
        const p = join(dir, "upd-envform.env");
        execFileSync("bash", [INSTALL_SH, "--dry-run", "--env-file", p], { stdio: "pipe", env: { ...cleanEnv, TUGRA_UPDATE_CHECKS: "0" } });
        expect(parseEnv(readFileSync(p, "utf8")).TUGRA_UPDATE_CHECKS).toBe("0");
      });

      it("an operator's explicit URL + key pair survives a re-run untouched", () => {
        const p = join(dir, "upd-custom.env");
        run([], p);
        const url = "https://updates.example.com/versions.json";
        const key = "MCowBQYDK2VwAyEAcustomcustomcustomcustomcustomcustomcus=";
        writeFileSync(p, `${readFileSync(p, "utf8")}UPDATE_MANIFEST_URL=${url}\nUPDATE_PUBLISHER_KEY=${key}\n`);
        run([], p);
        const env = parseEnv(readFileSync(p, "utf8"));
        expect(env.UPDATE_MANIFEST_URL).toBe(url);
        expect(env.UPDATE_PUBLISHER_KEY).toBe(key);
        expect(env.TUGRA_UPDATE_CHECKS).toBeUndefined();
        expect(lineCount(p, "UPDATE_MANIFEST_URL")).toBe(1);
      });
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
      for (const f of ["--raw-ports", "--restore-from", "--public-ip", "--detect-public-ip", "--no-telemetry", "--no-update-checks", "--enable-update-checks", "--home", "--dry-run", "--keep-raw-ports", "--acme-dns-cloudflare-file"]) {
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
      // .gitignore is root-anchored for the same reason: an unanchored `backups/` silently ignored new source
      // files under apps/hub-api/src/backups and apps/web/src/components/backups.
      const gi = readFileSync(join(REPO_ROOT, ".gitignore"), "utf8").split("\n").map((l) => l.trim());
      expect(gi).toContain("/backups/");
      expect(gi.filter((l) => /^(\*\*\/)?backups\/?$/.test(l))).toEqual([]);
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
  info) [ -n "$SHIM_DOCKER_ROOT" ] && echo "$SHIM_DOCKER_ROOT"; exit 0 ;;
  version) echo 27.0.0; exit 0 ;;
  volume) echo "$SHIM_VOLUMES"; exit 0 ;;
  inspect) echo "$SHIM_INSPECT"; exit 0 ;;
  rm) exit 0 ;;
  logs) [ -n "$SHIM_AGENT_LOG" ] && printf '%s\\n' "$SHIM_AGENT_LOG"; exit 0 ;;
  pull) if [ -n "$SHIM_AGENT_PULL_ERR" ]; then echo "$SHIM_AGENT_PULL_ERR" >&2; exit 1; fi; exit 0 ;;
  image) # SHIM_IMAGES: rows ID|REPO|TAG|DIGEST|VERSION|SOURCE|TITLE|SIZE|INUSE (unset = an empty image store)
      [ -n "$SHIM_IMAGES" ] || exit 0
      case "$2" in
        ls) awk -F'|' '{print $1"|"$2"|"$3"|"$4}' "$SHIM_IMAGES" ;;
        inspect) shift 2; fmt=""; if [ "$1" = "-f" ]; then fmt="$2"; shift 2; fi
          row="$(awk -F'|' -v r="$1" '$1==r || ($2!="<none>" && $3!="<none>" && $2":"$3==r) {print; exit}' "$SHIM_IMAGES")"
          [ -n "$row" ] || exit 1
          case "$fmt" in
            *"{{.Size}}"*) echo "$row" | cut -d'|' -f8 ;;
            *"image.source"*) echo "$row" | cut -d'|' -f5-7 ;;
          esac ;;
      esac
      exit 0 ;;
  rmi) [ -n "$SHIM_IMAGES" ] || exit 0
      row="$(awk -F'|' -v r="$2" '$1==r || ($2!="<none>" && $3!="<none>" && $2":"$3==r) {print; exit}' "$SHIM_IMAGES")"
      [ -n "$row" ] || exit 1
      [ "$(echo "$row" | cut -d'|' -f9)" = "1" ] && exit 1
      id="$(echo "$row" | cut -d'|' -f1)"
      # a removed image frees its size on the faked Docker data root (see the df shim)
      [ -f "$SHIM_LOG.avail" ] && echo $(( $(cat "$SHIM_LOG.avail") + $(echo "$row" | cut -d'|' -f8) / 1024 )) > "$SHIM_LOG.avail"
      awk -F'|' -v i="$id" '$1!=i' "$SHIM_IMAGES" > "$SHIM_IMAGES.n"; mv "$SHIM_IMAGES.n" "$SHIM_IMAGES"; exit 0 ;;
  ps) # plain docker ps (the compose branch handles 'docker compose ps'): an unmanaged agent exists only without the label filter
      case "$*" in *"{{.Names}}|{{.Ports}}"*) [ -n "$SHIM_DOCKER_PS" ] && printf '%s\\n' "$SHIM_DOCKER_PS"; exit 0 ;; esac
      case "$*" in *"name=^/tugra-proxy"*) [ -n "$SHIM_PROXY_UP" ] && echo proxycid; exit 0 ;; esac
      case "$*" in *"{{.State}}"*) [ -n "$SHIM_UNMANAGED_AGENT_STATE" ] && echo "$SHIM_UNMANAGED_AGENT_STATE"; exit 0 ;; esac
      case "$*" in *tugra-agent-1*) case "$*" in *label=*) : ;; *) [ -n "$SHIM_UNMANAGED_AGENT" ] && echo stalecid ;; esac ;; esac
      exit 0 ;;
  compose)
    shift
    while [ $# -gt 0 ]; do case "$1" in --profile|--env-file|-f) shift 2 ;; *) break ;; esac; done
    sub="$1"; shift
    case "$sub" in
      version) exit 0 ;;
      pull) if [ -n "$SHIM_PULL_ERR" ]; then : > "$SHIM_LOG.pullfail"; echo "$SHIM_PULL_ERR" >&2; exit 1; fi; exit 0 ;;
      config) case "$*" in *--images*) [ -n "$SHIM_COMPOSE_IMAGES" ] && printf '%s\\n' $SHIM_COMPOSE_IMAGES ;; esac; exit 0 ;;
      up) case "$*" in *postgres*) : > "$SHIM_LOG.pgup" ;; esac; exit 0 ;;
      logs) [ -n "$SHIM_AGENT_LOG" ] && printf '%s\\n' "$SHIM_AGENT_LOG"; exit 0 ;;
      ps) case "$*" in *"--format"*) [ -n "$SHIM_COMPOSE_PS" ] && printf '%s\\n' "$SHIM_COMPOSE_PS"; exit 0 ;; esac
          last="\${@: -1}"
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
    // curl: SHIM_CURL_FAIL_MATCH fails only the calls whose arguments contain that text (e.g. the proxy probe, not the hub health check).
    writeFileSync(
      join(shims, "curl"),
      `#!/bin/bash\necho "curl $*" >> "$SHIM_LOG"\nif [ -n "$SHIM_CURL_FAIL_MATCH" ]; then case "$*" in *"$SHIM_CURL_FAIL_MATCH"*) exit 1 ;; esac; fi\n# SHIM_CURL_STRICT_RC: the certificate-verifying probe (--resolve without -k) fails with this exit code (60 = untrusted cert)\nif [ -n "$SHIM_CURL_STRICT_RC" ]; then case "$*" in *--resolve*) case "$*" in *-fsSk*) ;; *) exit "$SHIM_CURL_STRICT_RC" ;; esac ;; esac; fi\nexit "\${SHIM_CURL_RC:-0}"\n`,
    );
    // ss: the faked listening sockets ($SHIM_SS, rows like "LISTEN 0 511 0.0.0.0:80 0.0.0.0:*"); getent: the faked DNS answer ($SHIM_GETENT, IPs).
    writeFileSync(join(shims, "ss"), `#!/bin/sh\n[ -n "$SHIM_SS" ] && printf '%s\\n' "$SHIM_SS"\nexit 0\n`);
    writeFileSync(join(shims, "getent"), `#!/bin/sh\nif [ "$1" = ahostsv6 ]; then for ip in $SHIM_GETENT6; do echo "$ip STREAM $2"; done; exit 0; fi\nfor ip in $SHIM_GETENT; do echo "$ip STREAM $2"; done\nexit 0\n`);
    chmodSync(join(shims, "ss"), 0o755);
    chmodSync(join(shims, "getent"), 0o755);
    // hostname: SHIM_HOSTNAME_I fakes \`hostname -I\` (the interface address); everything else is the real tool.
    const REAL_HOSTNAME = execFileSync("sh", ["-c", "command -v hostname"]).toString().trim();
    writeFileSync(join(shims, "hostname"), `#!/bin/sh\nif [ "$1" = "-I" ] && [ -n "$SHIM_HOSTNAME_I" ]; then echo "$SHIM_HOSTNAME_I"; exit 0; fi\nexec ${REAL_HOSTNAME} "$@"\n`);
    chmodSync(join(shims, "hostname"), 0o755);
    // df: the faked Docker data root ($SHIM_DOCKER_ROOT) reads $SHIM_LOG.avail (KiB; a removed image raises it), every other
    // path the real filesystem. mktemp: SHIM_MKTEMP_FAIL (a path prefix) makes the temp file for that .env unavailable (the
    // create fails); SHIM_MKTEMP_FULL makes it a file every write to which fails (/dev/full where it exists, else a directory).
    const REAL_DF = execFileSync("sh", ["-c", "command -v df"]).toString().trim();
    const REAL_MKTEMP = execFileSync("sh", ["-c", "command -v mktemp"]).toString().trim();
    writeFileSync(
      join(shims, "df"),
      `#!/bin/sh
last=""; for a in "$@"; do last="$a"; done
if [ -n "$SHIM_DOCKER_ROOT" ] && [ "$last" = "$SHIM_DOCKER_ROOT" ]; then printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\nfs 0 0 %s 0%% /\n' "$(cat "$SHIM_LOG.avail")"; exit 0; fi
exec ${REAL_DF} "$@"
`,
    );
    writeFileSync(
      join(shims, "mktemp"),
      `#!/bin/sh
if [ -n "$SHIM_MKTEMP_FAIL" ]; then case "$1" in "$SHIM_MKTEMP_FAIL".*) echo "mktemp: failed to create file via template: No space left on device" >&2; exit 1 ;; esac; fi
if [ -n "$SHIM_MKTEMP_FAIL_AFTER_PULL" ] && [ -e "$SHIM_LOG.pullfail" ]; then case "$1" in "$SHIM_MKTEMP_FAIL_AFTER_PULL".*) echo "mktemp: failed to create file via template: No space left on device" >&2; exit 1 ;; esac; fi
if [ -n "$SHIM_MKTEMP_FULL" ]; then case "$1" in "$SHIM_MKTEMP_FULL".*)
  name="\${1%XXXXXX}full$$"
  if [ -e /dev/full ]; then ln -s /dev/full "$name"; else ln -s "$(dirname "$1")" "$name"; fi
  echo "$name"; exit 0 ;; esac; fi
exec ${REAL_MKTEMP} "$@"
`,
    );
    // cp: SHIM_CP_FAIL makes the installer's copy of the pre-run .env (a path ending in env.before) fail, as on a full disk.
    const REAL_CP = execFileSync("sh", ["-c", "command -v cp"]).toString().trim();
    writeFileSync(
      join(shims, "cp"),
      `#!/bin/sh
if [ -n "$SHIM_CP_FAIL" ]; then for a in "$@"; do case "$a" in */env.before) echo "cp: error writing '$a': No space left on device" >&2; exit 1 ;; esac; done; fi
exec ${REAL_CP} "$@"
`,
    );
    chmodSync(join(shims, "docker"), 0o755);
    chmodSync(join(shims, "curl"), 0o755);
    chmodSync(join(shims, "cp"), 0o755);
    chmodSync(join(shims, "df"), 0o755);
    chmodSync(join(shims, "mktemp"), 0o755);

    // A PATH WITHOUT curl: symlink the host tools the installer needs next to the docker shim.
    const noCurl = join(shims, "nocurl");
    mkdirSync(noCurl);
    for (const t of ["awk", "sed", "grep", "head", "tail", "cut", "tr", "cat", "date", "mktemp", "chmod", "chown", "rm", "mv", "cp", "mkdir", "dirname", "basename", "uname", "od", "base64", "openssl", "sort", "sleep", "stat", "ls", "git", "hostname", "id", "wc", "df", "env", "sh", "bash", "uniq", "tee", "ip", "dig", "getent", "sync"]) {
      try {
        const real = execFileSync("sh", ["-c", `command -v ${t}`]).toString().trim();
        if (real.startsWith("/")) symlinkSync(real, join(noCurl, t));
      } catch {
        /* tool not present on this host — fine */
      }
    }
    symlinkSync(join(shims, "docker"), join(noCurl, "docker"));

    interface RunOpts { env?: Record<string, string>; noCurl?: boolean; script?: string }
    const reset = (): void => {
      writeFileSync(LOG, "");
      rmSync(`${LOG}.pgup`, { force: true });
      rmSync(`${LOG}.pullfail`, { force: true });
    };
    const calls = (): string => readFileSync(LOG, "utf8");
    /** First install writes the .env in dry-run (no Docker), the real run then exercises compose. */
    const install = (envPath: string, args: string[], opts: RunOpts = {}): { code: number; out: string } => {
      // TUGRA_CHECKOUT_SYNC=0: the repo these runs execute from may be a developer's dirty tree; never let a spec fetch or move git.
      const base = { PATH: `${opts.noCurl ? noCurl : shims}:${process.env.PATH}`, SHIM_LOG: LOG, TUGRA_HEALTH_TRIES: "1", TUGRA_HEALTH_INTERVAL: "0", TMPDIR: work, TUGRA_CHECKOUT_SYNC: "0" };
      const env = { ...base, ...(opts.noCurl ? { PATH: noCurl } : {}), ...(opts.env ?? {}) } as NodeJS.ProcessEnv;
      const r = spawnSync(BASH, [opts.script ?? INSTALL_SH, "--env-file", envPath, "--no-telemetry", ...args], { env, encoding: "utf8" });
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

    describe("a git checkout the in-app updater wrote compose/scripts into", () => {
      const gitIn = (cwd: string, ...args: string[]): string =>
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      const porcelain = (repo: string) => execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repo, encoding: "utf8" }).replace(/\n$/, "");
      let n = 0;

      /** A copy of the real scripts as a git checkout at v0.1.0 (remote has v0.2.0), then the "update" written over it. */
      function dirtyCheckout(): { repo: string; origin: string; v1: string; v2: string; envPath: string } {
        n += 1;
        const root = join(work, `co${n}`);
        const repo = join(root, "repo");
        const origin = join(root, "origin.git");
        mkdirSync(join(repo, "deploy"), { recursive: true });
        cpSync(join(REPO_ROOT, "scripts"), join(repo, "scripts"), { recursive: true });
        cpSync(COMPOSE, join(repo, "deploy", "docker-compose.yml"));
        writeFileSync(join(repo, ".gitignore"), ".env\n.env.*\nbackups/\n.tugra-host-applied\n");
        gitIn(repo, "init", "-q", "-b", "main");
        gitIn(repo, "add", "-A");
        gitIn(repo, "commit", "-q", "-m", "v1");
        gitIn(repo, "tag", "v0.1.0");
        const v1 = gitIn(repo, "rev-parse", "HEAD");
        gitIn(root, "init", "-q", "--bare", origin);
        gitIn(root, "clone", "-q", repo, "w");
        const w = join(root, "w");
        const installV2 = `${readFileSync(join(w, "scripts", "install.sh"), "utf8")}\n# release 0.2.0\n`;
        writeFileSync(join(w, "scripts", "install.sh"), installV2, { mode: 0o755 });
        writeFileSync(join(w, "scripts", "lib", "extra.sh"), "# new in 0.2.0\n", { mode: 0o755 });
        gitIn(w, "add", "-A");
        gitIn(w, "commit", "-q", "-m", "v2");
        gitIn(w, "tag", "v0.2.0");
        const v2 = gitIn(w, "rev-parse", "HEAD");
        gitIn(w, "push", "-q", origin, "main", "--tags");
        gitIn(repo, "remote", "add", "origin", origin);
        gitIn(repo, "update-ref", "refs/remotes/origin/main", v1);
        gitIn(repo, "branch", "-q", "--set-upstream-to=origin/main", "main");
        // what the in-app updater did
        writeFileSync(join(repo, "scripts", "install.sh"), installV2, { mode: 0o755 });
        writeFileSync(join(repo, "scripts", "lib", "extra.sh"), "# new in 0.2.0\n", { mode: 0o755 });
        expect(porcelain(repo)).toBe(" M scripts/install.sh\n?? scripts/lib/extra.sh");
        return { repo, origin, v1, v2, envPath: join(root, "env") };
      }
      const sync = { TUGRA_CHECKOUT_SYNC: "1" };

      it("git itself refuses the documented upgrade paths on such a checkout (the problem)", () => {
        const c = dirtyCheckout();
        expect(() => gitIn(c.repo, "fetch", "-q", "origin", "main")).not.toThrow();
        expect(() => gitIn(c.repo, "pull", "-q", "--ff-only")).toThrow();
      });

      it("a re-run with TUGRA_VERSION=<v> proceeds (exit 0, stack brought up) and leaves the checkout clean at that release", () => {
        const c = dirtyCheckout();
        reset();
        const r = install(c.envPath, HTTP, { script: join(c.repo, "scripts", "install.sh"), env: { ...sync, TUGRA_VERSION: "0.2.0" } });
        expect(r.code).toBe(0);
        expect(r.out).toContain("git checkout moved to release tag v0.2.0");
        expect(porcelain(c.repo)).toBe("");
        expect(gitIn(c.repo, "rev-parse", "HEAD")).toBe(c.v2);
        expect(gitIn(c.repo, "symbolic-ref", "--short", "HEAD")).toBe("main");
        expect(calls()).toContain("docker compose"); // it went on to install
        expect(readEnv(c.envPath).TUGRA_VERSION).toBe("0.2.0");
      });

      it("the version may come from .env (what the updater wrote) instead of the environment", () => {
        const c = dirtyCheckout();
        mkdirSync(dirname(c.envPath), { recursive: true });
        writeFileSync(c.envPath, "TUGRA_VERSION=0.2.0\n");
        const r = install(c.envPath, HTTP, { script: join(c.repo, "scripts", "install.sh"), env: sync });
        expect(r.code).toBe(0);
        expect(porcelain(c.repo)).toBe("");
        expect(gitIn(c.repo, "rev-parse", "HEAD")).toBe(c.v2);
      });

      it("--sync-checkout does only that: no Docker call, exit 0", () => {
        const c = dirtyCheckout();
        reset();
        const r = install(c.envPath, ["--sync-checkout"], { script: join(c.repo, "scripts", "install.sh"), env: { ...sync, TUGRA_VERSION: "0.2.0" } });
        expect(r.code).toBe(0);
        expect(porcelain(c.repo)).toBe("");
        expect(calls()).not.toContain("docker");
      });

      it("--sync-checkout without a version to match says so and changes nothing", () => {
        const c = dirtyCheckout();
        const r = install(c.envPath, ["--sync-checkout"], { script: join(c.repo, "scripts", "install.sh"), env: sync });
        expect(r.code).toBe(1);
        expect(r.out).toContain("TUGRA_VERSION=<version>");
        expect(porcelain(c.repo)).toContain("M scripts/install.sh");
      });

      it("a real local edit is kept and the install still proceeds; git is left untouched with a warning", () => {
        const c = dirtyCheckout();
        const mine = `${readFileSync(join(c.repo, "scripts", "install.sh"), "utf8")}# my own edit\n`;
        writeFileSync(join(c.repo, "scripts", "install.sh"), mine);
        const r = install(c.envPath, HTTP, { script: join(c.repo, "scripts", "install.sh"), env: { ...sync, TUGRA_VERSION: "0.2.0" } });
        expect(r.code).toBe(0);
        expect(r.out).toContain("scripts/install.sh differs from release v0.2.0");
        expect(readFileSync(join(c.repo, "scripts", "install.sh"), "utf8")).toBe(mine);
        expect(gitIn(c.repo, "rev-parse", "HEAD")).toBe(c.v1);
      });

      it("offline (the release tag cannot be fetched): the install proceeds, git untouched, reason shown", () => {
        const c = dirtyCheckout();
        gitIn(c.repo, "remote", "set-url", "origin", join(c.repo, "..", "gone.git"));
        const r = install(c.envPath, HTTP, { script: join(c.repo, "scripts", "install.sh"), env: { ...sync, TUGRA_VERSION: "0.2.0" } });
        expect(r.code).toBe(0);
        expect(r.out).toContain("could not be fetched");
        expect(gitIn(c.repo, "rev-parse", "HEAD")).toBe(c.v1);
      });

      it("TUGRA_CHECKOUT_SYNC=0 in .env (not the process environment) switches the step off too", () => {
        const c = dirtyCheckout();
        mkdirSync(dirname(c.envPath), { recursive: true });
        writeFileSync(c.envPath, "TUGRA_CHECKOUT_SYNC=0\n");
        const r = install(c.envPath, HTTP, { script: join(c.repo, "scripts", "install.sh"), env: { TUGRA_CHECKOUT_SYNC: "", TUGRA_VERSION: "0.2.0" } });
        expect(r.code).toBe(0);
        expect(gitIn(c.repo, "rev-parse", "HEAD")).toBe(c.v1);
        expect(porcelain(c.repo)).toContain("M scripts/install.sh");
      });

      it("a clean checkout and TUGRA_CHECKOUT_SYNC=0 are never moved", () => {
        const c = dirtyCheckout();
        const r0 = install(c.envPath, HTTP, { script: join(c.repo, "scripts", "install.sh"), env: { TUGRA_CHECKOUT_SYNC: "0", TUGRA_VERSION: "0.2.0" } });
        expect(r0.code).toBe(0);
        expect(gitIn(c.repo, "rev-parse", "HEAD")).toBe(c.v1);
        gitIn(c.repo, "checkout", "-q", "--", "scripts/install.sh");
        rmSync(join(c.repo, "scripts", "lib", "extra.sh"));
        expect(porcelain(c.repo)).toBe("");
        const r1 = install(c.envPath, HTTP, { script: join(c.repo, "scripts", "install.sh"), env: { ...sync, TUGRA_VERSION: "0.2.0" } });
        expect(r1.code).toBe(0);
        expect(gitIn(c.repo, "rev-parse", "HEAD")).toBe(c.v1);
      });
    });

    describe("update-check hint", () => {
      it("says checks are ON by default and OFF after --no-update-checks", () => {
        const on = join(work, "hint-on.env"); reset();
        const ron = install(on, HTTP);
        expect(ron.code).toBe(0);
        expect(ron.out).toContain("Update checks are ON");
        const off = join(work, "hint-off.env"); reset();
        const roff = install(off, [...HTTP, "--no-update-checks"]);
        expect(roff.code).toBe(0);
        expect(roff.out).toContain("Update checks are OFF");
        expect(roff.out).not.toContain("Update checks are ON");
        expect(readEnv(off).TUGRA_UPDATE_CHECKS).toBe("0");
      });
    });

    describe("compose take-over of a self-updated agent", () => {
      it("removes a tugra-agent-1 container that exists WITHOUT compose labels before `compose up`, and leaves a managed one alone", () => {
        const p = join(work, "stale-agent.env"); reset();
        const r = install(p, HTTP, { env: { SHIM_UNMANAGED_AGENT: "1" } });
        expect(r.code).toBe(0);
        expect(r.out).toContain("exists outside docker compose");
        expect(calls()).toMatch(/docker rm -f tugra-agent-1/);
        // the removal happens BEFORE compose up, so compose can create the managed container on the same volume
        const log = calls();
        expect(log.indexOf("docker rm -f tugra-agent-1")).toBeLessThan(log.indexOf("up -d"));
        const q = join(work, "managed-agent.env"); reset();
        install(q, HTTP, {});
        expect(calls()).not.toMatch(/docker rm -f/);
      });
    });

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

    describe("disk preflight, half-updated installs and a checked .env write", () => {
      const ROOT = join(work, "docker-root");
      mkdirSync(ROOT, { recursive: true });
      const GB = 1024 ** 3;
      const setAvail = (bytes: number): void => writeFileSync(`${LOG}.avail`, String(Math.floor(bytes / 1024)));
      afterEach(() => rmSync(`${LOG}.avail`, { force: true }));
      const SRC = "https://github.com/SimerayCom/tugra";
      const imgRow = (id: string, repo: string, ver: string, size: number, title: string): string => [id, repo, ver, "<none>", ver, SRC, title, String(size), "0"].join("|");
      const withImages = (name: string, rows: string[]): string => {
        const f = join(work, name);
        writeFileSync(f, rows.join("\n") + "\n");
        return f;
      };
      const HUBR = "ghcr.io/simeraycom/tugra-hub";

      it("a fresh install with too little room stops BEFORE pulling: the numbers + remedy, nothing pulled, no containers", () => {
        const p = join(work, "disk-fresh.env"); reset(); setAvail(2 * GB);
        const r = install(p, HTTP, { env: { SHIM_DOCKER_ROOT: ROOT } });
        expect(r.code).toBe(1);
        expect(r.out).toMatch(/not enough free disk space: needs about 10\.0 GB free on .*docker-root, has 2\.0 GB/);
        expect(r.out).toContain("Nothing was pulled");
        expect(calls()).not.toMatch(/ pull/);
        expect(calls()).not.toContain("up -d");
      });

      it("a re-run with too little room leaves the pre-run .env BYTE-IDENTICAL", () => {
        const p = join(work, "disk-rerun.env"); dry(p, HTTP);
        const before = readFileSync(p); reset(); setAvail(GB);
        const r = install(p, ["--domain", "tugra.example.com"], { env: { SHIM_DOCKER_ROOT: ROOT } });
        expect(r.code).toBe(1);
        expect(r.out).toContain("restored to its pre-run state");
        expect(readFileSync(p).equals(before)).toBe(true);
        expect(calls()).not.toMatch(/ pull/);
      });

      it("short, but old Tugra releases can go: the safe cleanup runs first (running + previous stay), then it pulls", () => {
        const p = join(work, "disk-prune.env"); dry(p, HTTP, { TUGRA_VERSION: "0.1.0" }); reset();
        const images = withImages("disk-prune.images", [
          imgRow("sha256:h07", HUBR, "0.0.7", 6 * GB, "Tugra Hub API"),
          imgRow("sha256:h08", HUBR, "0.0.8", GB, "Tugra Hub API"),
          imgRow("sha256:h10", HUBR, "0.1.0", 2 * GB, "Tugra Hub API"),
        ]);
        setAvail(4 * GB); // the running 0.1.0 is 2 GB: needs 2 x 2 + 2 = 6 GB; removing 0.0.7 frees 6 GB
        const r = install(p, HTTP, { env: { SHIM_DOCKER_ROOT: ROOT, SHIM_IMAGES: images } });
        expect(r.code).toBe(0);
        expect(r.out).toContain("removing old Tugra release images first");
        expect(r.out).toContain("enough space after the cleanup");
        const rmi = calls().split("\n").filter((l) => l.startsWith("docker rmi "));
        expect(rmi.join("\n")).toContain("0.0.7");
        expect(rmi.join("\n")).not.toMatch(/0\.0\.8|0\.1\.0/);
        expect(calls().indexOf("docker rmi ")).toBeLessThan(calls().search(/compose .* pull /));
      });

      it("--build has no pull to protect, and TUGRA_DISK_CHECK=0 skips the check", () => {
        const a = join(work, "disk-build.env"); reset(); setAvail(GB);
        expect(install(a, HTTP, { env: { SHIM_DOCKER_ROOT: ROOT } }).code).toBe(1);
        reset(); setAvail(GB);
        const b = install(join(work, "disk-build2.env"), [...HTTP, "--build"], { env: { SHIM_DOCKER_ROOT: ROOT } });
        expect(b.out).not.toContain("not enough free disk space");
        reset(); setAvail(GB);
        const c = install(join(work, "disk-off.env"), HTTP, { env: { SHIM_DOCKER_ROOT: ROOT, TUGRA_DISK_CHECK: "0" } });
        expect(c.code).toBe(0);
        expect(c.out).toContain("disk check disabled");
      });

      it("a re-run on a HALF-updated install (.env names 0.2.0, the containers run 0.1.0) proceeds and finishes the update", () => {
        const p = join(work, "half-ok.env"); dry(p, HTTP, { TUGRA_VERSION: "0.2.0" }); reset();
        const r = install(p, HTTP, { env: { SHIM_INSPECT: "0.1.0" } });
        expect(r.code).toBe(0);
        expect(r.out).toContain("names 0.2.0 but the running stack is on 0.1.0");
        expect(calls()).toMatch(/compose .* pull /); // pulls what .env names though its images are absent
        expect(calls()).toContain("up -d --no-build");
        expect(readEnv(p).TUGRA_VERSION).toBe("0.2.0");
      });

      it("... and when 0.2.0 cannot be pulled the .env is put back to the RUNNING release instead of keeping a version that is not installed", () => {
        const p = join(work, "half-fail.env"); dry(p, HTTP, { TUGRA_VERSION: "0.2.0" });
        writeFileSync(p, `${readFileSync(p, "utf8")}TUGRA_HUB_DIGEST=${"c".repeat(64)}\nTUGRA_WEB_DIGEST=${"d".repeat(64)}\n`);
        reset();
        const r = install(p, HTTP, { env: { SHIM_INSPECT: "0.1.0", SHIM_PULL_ERR: "manifest unknown" } });
        expect(r.code).toBe(1);
        expect(r.out).toContain("a release that was never installed here");
        expect(readEnv(p).TUGRA_VERSION).toBe("0.1.0");
        expect(readEnv(p).TUGRA_HUB_DIGEST).toBe("");
        expect(readEnv(p).TUGRA_WEB_DIGEST).toBe("");
        expect(calls()).not.toContain("up -d");
      });

      it("a consistent install (.env = running version) is not reported as half-updated", () => {
        const p = join(work, "half-none.env"); dry(p, HTTP, { TUGRA_VERSION: "0.1.0" }); reset();
        const r = install(p, HTTP, { env: { SHIM_INSPECT: "0.1.0" } });
        expect(r.code).toBe(0);
        expect(r.out).not.toContain("half-finished update");
      });

      it("a .env write that cannot even create its temp file stops the run with a clear error, the original .env untouched, nothing started", () => {
        const p = join(work, "envfull-create.env"); dry(p, HTTP);
        const before = readFileSync(p); reset();
        const r = install(p, HTTP, { env: { SHIM_MKTEMP_FAIL: p } });
        expect(r.code).not.toBe(0);
        expect(r.out).toContain("cannot create a temporary file next to");
        expect(r.out).toContain("was not changed");
        expect(readFileSync(p).equals(before)).toBe(true);
        expect(calls()).not.toContain("up -d");
      });

      it("a .env write that runs out of space part-way (every write to the temp fails) never replaces the good file", () => {
        const p = join(work, "envfull-write.env"); dry(p, HTTP);
        const before = readFileSync(p); reset();
        const r = install(p, HTTP, { env: { SHIM_MKTEMP_FULL: p } });
        expect(r.code).not.toBe(0);
        expect(r.out).toMatch(/cannot write .*\(disk full\?\)|did not verify/);
        expect(readFileSync(p).equals(before)).toBe(true);
        expect(readdirSync(dirname(p)).filter((f) => f.startsWith("envfull-write.env.") && existsSync(join(dirname(p), f)))).toEqual([]);
        expect(calls()).not.toContain("up -d");
      });

      it("the abort's restore of the pre-run .env is atomic too: when it cannot write, the live .env is NOT truncated, the failure is said out loud, and the saved copy is kept", () => {
        const p = join(work, "restore-fail.env"); dry(p, HTTP, { TUGRA_VERSION: "0.1.0" });
        const before = readFileSync(p); reset();
        const r = install(p, ["--domain", "tugra.example.com"], { env: { SHIM_PULL_ERR: "manifest unknown", SHIM_MKTEMP_FAIL_AFTER_PULL: p } });
        expect(r.code).toBe(1);
        expect(r.out).toContain("could NOT be restored");
        expect(r.out).not.toContain("restored to its pre-run state");
        expect(readEnv(p).JWT_ACCESS_SECRET).toBeTruthy(); // a complete file (this run's), never a truncated one
        const saved = /saved at (\S+env\.before)/.exec(r.out)?.[1];
        expect(saved).toBeTruthy();
        expect(readFileSync(saved as string).equals(before)).toBe(true); // the pre-run copy survives for a manual restore
      });

      it("a pre-run .env copy that cannot be made (full disk) stops the run before anything is rewritten, instead of pretending a fresh install", () => {
        const p = join(work, "copy-fail.env"); dry(p, HTTP, { TUGRA_VERSION: "0.1.0" });
        const before = readFileSync(p); reset();
        const r = install(p, ["--domain", "tugra.example.com"], { env: { SHIM_CP_FAIL: "1" } });
        expect(r.code).toBe(1);
        expect(r.out).toContain("could not save a copy of");
        expect(r.out).not.toContain("fresh install");
        expect(readFileSync(p).equals(before)).toBe(true);
        expect(calls()).not.toMatch(/ pull|up -d/);
      });

      it("a re-run that pulls nothing (every image of the pinned release is already local) is not refused for lack of room", () => {
        const p = join(work, "disk-skip.env"); dry(p, HTTP, { TUGRA_VERSION: "0.1.0" }); reset(); setAvail(GB);
        const r = install(p, HTTP, { env: { SHIM_DOCKER_ROOT: ROOT, SHIM_COMPOSE_IMAGES: "ghcr.io/simeraycom/tugra-hub:0.1.0 ghcr.io/simeraycom/tugra-web:0.1.0" } });
        expect(r.code).toBe(0);
        expect(r.out).not.toContain("not enough free disk space");
        expect(r.out).not.toContain("disk check");
      });

      it("... but one missing image (or an unpinned `latest`) brings the check back, and the refusal names the TUGRA_DISK_CHECK=0 escape", () => {
        const p = join(work, "disk-missing.env"); dry(p, HTTP, { TUGRA_VERSION: "0.1.0" }); reset(); setAvail(GB);
        const images = withImages("disk-missing.images", [imgRow("sha256:h10", HUBR, "0.1.0", 2 * GB, "Tugra Hub API")]);
        const r = install(p, HTTP, { env: { SHIM_DOCKER_ROOT: ROOT, SHIM_IMAGES: images, SHIM_COMPOSE_IMAGES: "ghcr.io/simeraycom/tugra-hub:0.1.0 ghcr.io/simeraycom/tugra-web:0.1.0" } });
        expect(r.code).toBe(1);
        expect(r.out).toContain("not enough free disk space");
        expect(r.out).toContain("TUGRA_DISK_CHECK=0");
        const q = join(work, "disk-latest.env"); reset(); setAvail(GB);
        const l = install(q, HTTP, { env: { SHIM_DOCKER_ROOT: ROOT, SHIM_COMPOSE_IMAGES: "ghcr.io/simeraycom/tugra-hub:latest" } });
        expect(l.out).toContain("not enough free disk space"); // a moving tag is always re-pulled
      });

      it("appending a new key goes through the same atomic write: other lines, their order and the file mode survive", () => {
        const p = join(work, "env-append.env");
        writeFileSync(p, "A=1\nB=two", { mode: 0o640 }); // no trailing newline, and a mode the installer must keep
        execFileSync(BASH, [INSTALL_SH, "--dry-run", "--env-file", p, "--no-telemetry", ...HTTP], { stdio: "pipe", env: { PATH: process.env.PATH } as NodeJS.ProcessEnv });
        const text = readFileSync(p, "utf8");
        expect(text.startsWith("A=1\nB=two\n")).toBe(true);
        expect(readEnv(p).JWT_ACCESS_SECRET).toBeTruthy();
      });
    });

    describe("agent image + old release images", () => {
      const AGENT_IMG = "ghcr.io/simeraycom/tugra-agent";
      it("never `compose pull`s the bundled agent (its multi-platform index broke that pull on the containerd image store): a plain docker pull of the tag does it", () => {
        const p = join(work, "agent-pull.env"); reset();
        const r = install(p, HTTP, { env: { TUGRA_VERSION: "0.1.0-beta.19" } });
        expect(r.code).toBe(0);
        const log = calls();
        const composePull = log.split("\n").find((l) => / pull /.test(l) && l.startsWith("docker compose")) as string;
        expect(composePull).toBeDefined();
        expect(composePull).toMatch(/pull postgres redis hub-api web$/); // neither the agent nor the updater goes through `compose pull`
        expect(log).toContain(`docker pull ${AGENT_IMG}:0.1.0-beta.19`);
        expect(log).toContain("docker pull ghcr.io/simeraycom/tugra-updater:0.1.0-beta.19");
        expect(log.indexOf(`docker pull ${AGENT_IMG}`)).toBeLessThan(log.indexOf("up -d"));
        expect(log).not.toContain("build agent");
        // an unpinned install follows :latest, exactly as the compose file does
        const q = join(work, "agent-pull-latest.env"); reset();
        install(q, HTTP);
        expect(calls()).toContain(`docker pull ${AGENT_IMG}:latest`);
        expect(calls()).toContain("docker pull ghcr.io/simeraycom/tugra-updater:latest");
      });

      it("an agent image that cannot be pulled stops a pinned install before any container is recreated", () => {
        const p = join(work, "agent-pull-fail.env"); reset();
        const r = install(p, HTTP, { env: { TUGRA_VERSION: "0.1.0-beta.19", SHIM_AGENT_PULL_ERR: "failed to copy: httpReadSeeker: failed open: could not fetch content descriptor" } });
        expect(r.code).toBe(1);
        expect(calls()).not.toMatch(/up -d/);
        expect(r.out).toContain("pinned");
      });

      const HUB = "ghcr.io/simeraycom/tugra-hub";
      const SRC = "https://github.com/SimerayCom/tugra";
      const images = [
        `sha256:old11|${HUB}|0.1.0-beta.11|<none>|0.1.0-beta.11|${SRC}|Tugra Hub API|3000|0`,
        `sha256:old17|${HUB}|0.1.0-beta.17|<none>|0.1.0-beta.17|${SRC}|Tugra Hub API|3000|1`, // in use: stays
        `sha256:prev18|${HUB}|<none>|sha256:aa18|0.1.0-beta.18|${SRC}|Tugra Hub API|3000|0`,
        `sha256:cur19|${HUB}|<none>|sha256:aa19|0.1.0-beta.19|${SRC}|Tugra Hub API|3000|0`,
        "sha256:pg|postgres|16-alpine|<none>|||||0",
      ];
      /** An existing install on beta.18 that is upgraded to beta.19 by this run. */
      const upgrade = (name: string, extra: string[]) => {
        const p = join(work, name);
        dry(p, HTTP);
        writeFileSync(p, readFileSync(p, "utf8").replace(/^TUGRA_VERSION=.*\n?/m, "") + "TUGRA_VERSION=0.1.0-beta.18\n");
        const table = join(work, `${name}.images`);
        writeFileSync(table, images.join("\n") + "\n");
        reset();
        const r = install(p, [...HTTP, ...extra], { env: { TUGRA_VERSION: "0.1.0-beta.19", SHIM_IMAGES: table } });
        return { r, table };
      };

      it("without --prune-images it only reports what could be freed (nothing is removed)", () => {
        const { r, table } = upgrade("prune-hint.env", []);
        expect(r.code).toBe(0);
        expect(r.out).toMatch(/2 old Tugra release image\(s\), about 0 MB.*--prune-images/);
        expect(calls()).not.toContain("docker rmi");
        expect(readFileSync(table, "utf8")).toContain("sha256:old11");
      });

      it("--prune-images removes Tugra's own releases older than the previous one, keeps current + previous and everything foreign or in use, and logs it", () => {
        const { r, table } = upgrade("prune-now.env", ["--prune-images"]);
        expect(r.code).toBe(0);
        const left = readFileSync(table, "utf8");
        expect(left).not.toContain("sha256:old11");
        for (const keep of ["sha256:old17", "sha256:prev18", "sha256:cur19", "sha256:pg"]) expect(left).toContain(keep);
        expect(calls()).toMatch(/docker rmi ghcr\.io\/simeraycom\/tugra-hub:0\.1\.0-beta\.11/);
        expect(calls()).not.toMatch(/docker rmi [^\n]*(postgres|prev18|cur19)/);
        expect(r.out).toMatch(/image cleanup: removed 1 old Tugra release image\(s\)/);
      });

      it("an install that built from source never offers or runs the cleanup", () => {
        const p = join(work, "prune-build.env"); reset();
        const r = install(p, [...HTTP, "--build", "--prune-images"], { env: { SHIM_IMAGES: join(work, "prune-hint.env.images") } });
        expect(r.code).toBe(0);
        expect(calls()).not.toContain("docker rmi");
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

      describe("IP mode (the plain install): the panel on http://<ip>/ through Tugra's own proxy", () => {
        const fast = { TUGRA_PANEL_TRIES: "2", TUGRA_PANEL_INTERVAL: "0" };

        it("starts the proxy with the IP route, probes port 80 and prints the http://<ip>/ URL (only 80/443 needed)", () => {
          const p = join(work, "ip-run.env"); reset();
          const r = install(p, ["--public-ip", "203.0.113.9"], { env: fast });
          expect(r.code).toBe(0);
          expect(calls()).toMatch(/compose .*run .*-e PANEL_IP_ROUTE=1 /); // the hub image renders the host-less router
          expect(calls()).toContain("curl -fsS --max-time 4 http://127.0.0.1/health");
          expect(r.out).toContain("Open http://203.0.113.9 in your browser");
          expect(r.out).toMatch(/only ports 80 and 443 need to be open/);
          expect(readEnv(p).HUB_BIND).toBe("127.0.0.1");
        });

        it("falls back to the raw ports (URLs, trust and binds) when the proxy does not answer, instead of leaving a dead URL", () => {
          const p = join(work, "ip-fallback.env"); reset();
          const r = install(p, ["--public-ip", "203.0.113.9"], { env: { ...fast, SHIM_CURL_FAIL_MATCH: "http://127.0.0.1/health" } });
          expect(r.code).toBe(0);
          const env = readEnv(p);
          expect(env.WEB_PUBLIC_URL).toBe("http://203.0.113.9:3001");
          expect(env.HUB_PUBLIC_URL).toBe("http://203.0.113.9:3000");
          expect(env.PANEL_IP_ROUTE).toBe("0");
          expect(env.HUB_TRUSTED_PROXY).toBe("false");
          expect(env.HUB_BIND).toBe("0.0.0.0");
          expect(r.out).toMatch(/falling back to the raw ports/);
          expect(r.out).toContain("Web UI:  http://203.0.113.9:3001");
          expect(calls()).toContain("up -d --no-deps hub-api web");
        });

        it("an EXISTING IP-mode install is never moved to the raw ports when the proxy probe misses on a re-run", () => {
          const p = join(work, "ip-existing-miss.env"); reset();
          expect(install(p, ["--public-ip", "203.0.113.9"], { env: fast }).code).toBe(0);
          const before = readEnv(p);
          reset();
          const r = install(p, [], { env: { ...fast, SHIM_CURL_FAIL_MATCH: "http://127.0.0.1/health" } });
          expect(r.code).toBe(0);
          const after = readEnv(p);
          expect(after.WEB_PUBLIC_URL).toBe(before.WEB_PUBLIC_URL);
          expect(after.HUB_PUBLIC_URL).toBe(before.HUB_PUBLIC_URL);
          expect(after.PANEL_IP_ROUTE).toBe("1");
          expect(after.HUB_TRUSTED_PROXY).toBe("true");
          expect(after.HUB_BIND).toBe("127.0.0.1");
          expect(r.out).not.toMatch(/falling back to the raw ports/);
          expect(r.out).toMatch(/left exactly as it is/);
        });

        it("a private interface address (cloud VM behind NAT) is called out instead of printed as the address to open", () => {
          const p = join(work, "ip-private.env"); reset();
          const r = install(p, [], { env: { ...fast, SHIM_HOSTNAME_I: "10.1.2.3" } });
          expect(r.code).toBe(0);
          expect(r.out).toMatch(/10\.1\.2\.3\) is a private one/);
          expect(r.out).toContain("--public-ip");
          const ok = install(join(work, "ip-private-pinned.env"), ["--public-ip", "203.0.113.9"], { env: { ...fast, SHIM_HOSTNAME_I: "10.1.2.3" } });
          expect(ok.out).not.toMatch(/is a private one/);
        });

        it("port 80 held by another service: the raw-port quick start is used and the operator is told why", () => {
          const p = join(work, "ip-busy.env"); reset();
          const r = install(p, ["--public-ip", "203.0.113.9"], { env: { SHIM_SS: "LISTEN 0 511 0.0.0.0:80 0.0.0.0:*" } });
          expect(r.code).toBe(0);
          expect(r.out).toMatch(/Port 80 is already in use/);
          const env = readEnv(p);
          expect(env.WEB_PUBLIC_URL).toBe("http://203.0.113.9:3001");
          expect(env.PANEL_IP_ROUTE).toBeUndefined();
          expect(calls()).not.toContain("PANEL_IP_ROUTE=1");
        });

        it("--raw-ports never starts the proxy", () => {
          const p = join(work, "ip-rawports.env"); reset();
          const r = install(p, ["--raw-ports"]);
          expect(r.code).toBe(0);
          expect(calls()).not.toContain("print-proxy-setup");
          expect(r.out).not.toContain("Open http://");
        });
      });

      describe("--domain behind Cloudflare: HTTP-01 first, no token required", () => {
        it("a Cloudflare edge address is recognised and the advice names SSL mode Full / Always Use HTTPS, not a token", () => {
          const p = join(work, "cf-http01.env"); reset();
          const r = install(p, ["--domain", "panel.example.com"], { env: { SHIM_GETENT: "104.21.5.5 172.67.9.9" } });
          expect(r.code).toBe(0);
          expect(r.out).toMatch(/behind Cloudflare's proxy/);
          expect(r.out).toMatch(/Tugra asks Let's Encrypt over HTTP-01 first, so no Cloudflare token is needed/);
          expect(r.out).toContain("'Full'");
          expect(r.out).toContain("'Always Use HTTPS'");
          expect(r.out).not.toMatch(/re-run with --acme-dns-cloudflare <token>/);
          expect(readEnv(p).ACME_DNS_TOKEN).toBeUndefined();
          expect(readEnv(p).PANEL_TLS).toBe("1");
        });
        it("a proxied panel turns the verified Cloudflare client-IP mode on by itself (no --cloudflare-proxy needed)", () => {
          const p = join(work, "cf-auto.env"); reset();
          const r = install(p, ["--domain", "panel.example.com"], { env: { SHIM_GETENT: "104.21.5.5" } });
          expect(r.code).toBe(0);
          expect(readEnv(p).HUB_TRUSTED_PROXY).toBe("true");
          expect(readEnv(p).HUB_TRUSTED_PROXY_CLOUDFLARE).toBe("true");
          expect(r.out).toMatch(/Cloudflare proxy detected: real client and server IPs/);
          // an existing install re-run without flags (stored PANEL_TLS, no preflight) still detects it
          const p2 = join(work, "cf-auto-rerun.env"); reset();
          install(p2, ["--domain", "panel.example.com"], { env: { SHIM_GETENT: "203.0.113.50" } });
          expect(readEnv(p2).HUB_TRUSTED_PROXY_CLOUDFLARE).toBeUndefined();
          install(p2, [], { env: { SHIM_GETENT: "104.21.5.5" } });
          expect(readEnv(p2).HUB_TRUSTED_PROXY_CLOUDFLARE).toBe("true");
          // an explicit --no-cloudflare-proxy always wins
          const p3 = join(work, "cf-auto-off.env"); reset();
          install(p3, ["--domain", "panel.example.com", "--no-cloudflare-proxy"], { env: { SHIM_GETENT: "104.21.5.5" } });
          expect(readEnv(p3).HUB_TRUSTED_PROXY_CLOUDFLARE).toBe("false");
        });
        it("uses Cloudflare's published 131.0.72.0/22 range (not 131.0.0.0/22)", () => {
          reset();
          const inside = install(join(work, "cf-131-in.env"), ["--domain", "panel.example.com"], { env: { SHIM_GETENT: "131.0.72.9" } });
          expect(inside.out).toMatch(/behind Cloudflare's proxy/);
          const outside = install(join(work, "cf-131-out.env"), ["--domain", "panel.example.com"], { env: { SHIM_GETENT: "131.0.0.9" } });
          expect(outside.out).not.toMatch(/behind Cloudflare's proxy/);
        });
        it("the token stays an OPTION (named only as --acme-dns-cloudflare-file), and the other record states are unchanged", () => {
          const p = join(work, "cf-opt.env"); reset();
          const cf = install(p, ["--domain", "panel.example.com"], { env: { SHIM_GETENT: "104.21.5.5" } });
          expect(cf.out).toMatch(/optional DNS-01/);
          const other = install(join(work, "cf-other.env"), ["--domain", "panel.example.com"], { env: { SHIM_GETENT: "203.0.113.50" } });
          expect(other.out).not.toMatch(/behind Cloudflare's proxy/);
          expect(other.out).not.toMatch(/--acme-dns-cloudflare <token>/);
        });
        it("a domain while :80 is held by another web server keeps bring-your-own-proxy (the bundled proxy could not bind)", () => {
          const p = join(work, "dom-busy.env"); reset();
          const r = install(p, ["--domain", "panel.example.com"], { env: { SHIM_SS: "LISTEN 0 511 0.0.0.0:80 0.0.0.0:*" } });
          expect(r.code).toBe(0);
          expect(r.out).toMatch(/Port 80 is already in use/);
          expect(readEnv(p).PANEL_TLS).toBe("0");
        });
      });

      it("when the panel router does NOT come up, nothing is rebound (the failure message promises host-port access)", () => {
        const p = legacyTls("tls-down"); reset();
        // every curl fails: the hub never reports healthy, so the panel step is skipped entirely
        const r = install(p, [], { env: { SHIM_CURL_RC: "1" } });
        expect(r.code).toBe(1);
        expect(readEnv(p).HUB_BIND).toBe("0.0.0.0");
      });
    });

    describe("network health checks (preflight) and --doctor: read-only, with shims for ss/docker/ufw/nft/iptables/firewall-cmd and a fake DMI", () => {
      const NETLIB = join(REPO_ROOT, "scripts", "lib", "netcheck.sh");
      const base = mkdtempSync(join(tmpdir(), "install-net-"));
      afterAll(() => rmSync(base, { recursive: true, force: true }));
      let seq = 0;

      // Firewall tool shims (each prints a faked answer from its SHIM_* variable); only the ones a test names are on its PATH.
      const fwShims = join(base, "fwshims");
      mkdirSync(fwShims);
      writeFileSync(join(fwShims, "ufw"), `#!/bin/sh\n[ -n "$SHIM_UFW_RC" ] && { echo "ERROR: You need to be root to run this script" >&2; exit "$SHIM_UFW_RC"; }\nprintf '%s\\n' "$SHIM_UFW"\nexit 0\n`);
      writeFileSync(join(fwShims, "nft"), `#!/bin/sh\nprintf '%s\\n' "$SHIM_NFT"\nexit 0\n`);
      writeFileSync(join(fwShims, "iptables"), `#!/bin/sh\nprintf '%s\\n' "$SHIM_IPTABLES"\nexit 0\n`);
      writeFileSync(
        join(fwShims, "firewall-cmd"),
        `#!/bin/sh\ncase "$1" in --state) echo "\${SHIM_FIREWALLD_STATE:-running}" ;; --list-all) printf '%s\\n' "$SHIM_FIREWALLD" ;; esac\nexit 0\n`,
      );
      // id: SHIM_UID fakes the user (a non-root run), everything else is the real tool.
      const REAL_ID = execFileSync("sh", ["-c", "command -v id"]).toString().trim();
      writeFileSync(join(fwShims, "id"), `#!/bin/sh\n[ "$1" = "-u" ] && [ -n "$SHIM_UID" ] && { echo "$SHIM_UID"; exit 0; }\nexec ${REAL_ID} "$@"\n`);
      for (const t of ["ufw", "nft", "iptables", "firewall-cmd", "id"]) chmodSync(join(fwShims, t), 0o755);

      // A closed PATH: only the host tools the scripts need, the shims, and the firewall shims a test asks for (a CI box with a real iptables must not leak in).
      const TOOLS = ["awk", "sed", "grep", "head", "tail", "cut", "tr", "cat", "sort", "uniq", "wc", "df", "env", "sh", "bash", "uname", "date", "mkdir", "rm", "mv", "cp", "chmod", "dirname", "basename", "stat", "mktemp", "tee", "ls", "od", "base64", "openssl", "sleep", "git", "ln", "printf", "true", "false", "test"];
      const pathFor = (fw: string[]): string => {
        const d = join(base, `bin${(seq += 1)}`);
        mkdirSync(d);
        for (const t of TOOLS) {
          try {
            const real = execFileSync("sh", ["-c", `command -v ${t}`]).toString().trim();
            if (real.startsWith("/")) symlinkSync(real, join(d, t));
          } catch {
            /* tool not present on this host */
          }
        }
        for (const t of ["docker", "curl", "ss", "getent", "hostname"]) symlinkSync(join(shims, t), join(d, t));
        for (const t of ["id", ...fw]) symlinkSync(join(fwShims, t), join(d, t));
        return d;
      };

      interface Box {
        dmi?: Record<string, string>; cloudId?: string; hostname?: string; v6?: string[]; clp?: boolean; plesk?: boolean; cpanel?: boolean;
        /** Full /proc/net/if_inet6 lines (addr ifindex plen scope flags name), instead of the one-eth0-line-per-address default. */
        v6Lines?: string[];
        /** /proc/net/ipv6_route */
        v6Route?: string;
      }
      /** A fake root filesystem for the DMI / cloud-init / panel markers. */
      const fsRoot = (b: Box): { root: string; dmi: string } => {
        const root = join(base, `fs${(seq += 1)}`);
        const dmi = join(root, "sys", "class", "dmi", "id");
        mkdirSync(dmi, { recursive: true });
        for (const [k, v] of Object.entries(b.dmi ?? {})) writeFileSync(join(dmi, k), `${v}\n`);
        if (b.cloudId) {
          mkdirSync(join(root, "run", "cloud-init"), { recursive: true });
          writeFileSync(join(root, "run", "cloud-init", "cloud-id"), `${b.cloudId}\n`);
        }
        if (b.v6 || b.v6Lines) {
          mkdirSync(join(root, "proc", "net"), { recursive: true });
          const lines = b.v6Lines ?? (b.v6 ?? []).map((a) => `${a} 02 40 00 80 eth0`);
          writeFileSync(join(root, "proc", "net", "if_inet6"), lines.join("\n") + "\nfe80000000000000f816feffee123456 02 40 20 80 eth0\n");
        }
        if (b.v6Route) {
          mkdirSync(join(root, "proc", "net"), { recursive: true });
          writeFileSync(join(root, "proc", "net", "ipv6_route"), `${b.v6Route}\n`);
        }
        if (b.clp) mkdirSync(join(root, "home", "clp"), { recursive: true });
        if (b.plesk) mkdirSync(join(root, "usr", "local", "psa"), { recursive: true });
        if (b.cpanel) mkdirSync(join(root, "usr", "local", "cpanel"), { recursive: true });
        return { root, dmi };
      };

      const HETZNER: Box = { dmi: { sys_vendor: "Hetzner", product_name: "vServer", bios_vendor: "Hetzner", chassis_vendor: "Hetzner" }, cloudId: "hetzner", hostname: "tugra-hub" };
      const nginxSs = 'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=812,fd=6),("nginx",pid=813,fd=6))\nLISTEN 0 511 [::]:80 [::]:* users:(("nginx",pid=812,fd=7))';

      /** `install.sh --doctor` on a fake box. Returns the exit code, the combined output and the docker/curl call log. */
      const doctor = (box: Box, env: Record<string, string> = {}, opts: { fw?: string[]; envFile?: string; args?: string[] } = {}): { code: number; out: string; calls: string } => {
        const { root, dmi } = fsRoot(box);
        const log = join(base, `calls${(seq += 1)}.log`);
        writeFileSync(log, "");
        const envPath = opts.envFile ?? join(base, `absent${(seq += 1)}.env`);
        const r = spawnSync(BASH, [INSTALL_SH, "--doctor", "--env-file", envPath, ...(opts.args ?? [])], {
          encoding: "utf8",
          env: { PATH: pathFor(opts.fw ?? []), SHIM_LOG: log, TUGRA_FS_ROOT: root, TUGRA_DMI_ROOT: dmi, TUGRA_HOSTNAME: box.hostname ?? "box", SHIM_HOSTNAME_I: "203.0.113.7", TMPDIR: base, ...env } as NodeJS.ProcessEnv,
        });
        return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}`, calls: readFileSync(log, "utf8") };
      };

      /** An installed hub's .env (what the doctor reads). */
      const installed = (extra: string[] = []): string => {
        const p = join(base, `inst${(seq += 1)}.env`);
        writeFileSync(p, ["TUGRA_VERSION=0.1.0-beta.20", "HUB_PORT=3000", "WEB_PORT=3001", "HUB_PUBLIC_URL=http://203.0.113.7", ...extra, ""].join("\n"));
        return p;
      };
      const ALL_UP = ["postgres|running|healthy", "redis|running|healthy", "hub-api|running|healthy", "web|running|", "agent|running|"].join("\n");

      it("scripts/lib/netcheck.sh is valid bash and ships next to install.sh (the host-file signer picks it up by glob)", () => {
        expect(() => execFileSync("bash", ["-n", NETLIB], { stdio: "pipe" })).not.toThrow();
        expect(readFileSync(join(REPO_ROOT, "scripts", "sign-host-files.mjs"), "utf8")).toContain('endsWith(".sh")');
      });

      describe("a Hetzner box (fresh host)", () => {
        it("recognises Hetzner from DMI + cloud-id and prints the Cloud Console firewall hint, with free ports and a clean exit", () => {
          const r = doctor(HETZNER, {}, { fw: [] });
          expect(r.out).toContain("Hosting: Hetzner");
          expect(r.out).toContain("Hetzner Cloud Console -> your project -> Firewalls");
          expect(r.out).toContain("allow TCP 80, 443");
          expect(r.out).toContain("Port 80 is free");
          expect(r.out).toContain("Port 443 is free");
          expect(r.out).toContain("No host firewall in the way");
          expect(r.out).toContain("Tugra is not installed here");
          expect(r.out).toContain("Doctor: no problems found.");
          expect(r.code).toBe(0);
        });
        it("recognises Hetzner from DMI alone (no cloud-init)", () => {
          const r = doctor({ ...HETZNER, cloudId: undefined });
          expect(r.out).toContain("Hosting: Hetzner");
        });
      });

      describe("a CloudPanel box with nginx on :80/:443", () => {
        const clp: Box = { ...HETZNER, clp: true };
        const ss = `${nginxSs}\nLISTEN 0 511 0.0.0.0:443 0.0.0.0:* users:(("nginx",pid=812,fd=8))`;
        it("names the holder and refuses to advise stopping CloudPanel: the exact command and what goes down", () => {
          const r = doctor(clp, { SHIM_SS: ss });
          expect(r.out).toContain("Port 80 is held by nginx (pid 812).");
          expect(r.out).toContain("Port 443 is held by nginx (pid 812), the same as above.");
          expect(r.out).toContain("That is CloudPanel's web server. Do NOT stop it for Tugra");
          expect(r.out.match(/Do NOT stop it for Tugra/g)).toHaveLength(1); // the advice once, not per port
          expect(r.out).toContain("systemctl stop nginx would take every site CloudPanel hosts offline");
          expect(r.out).toContain("--domain <host> --no-auto-tls");
          expect(r.code).toBe(0); // fresh host: advice, not a failure
        });
        it("the installer's own preflight prints the same advice, changes nothing and carries on (raw-port fallback)", () => {
          const { root, dmi } = fsRoot(clp);
          const p = join(work, "net-clp.env");
          reset();
          const r = install(p, [], { env: { SHIM_SS: ss, TUGRA_FS_ROOT: root, TUGRA_DMI_ROOT: dmi, TUGRA_HOSTNAME: "tugra-hub" } });
          expect(r.out).toContain("Port 80 is held by nginx (pid 812).");
          expect(r.out).toContain("That is CloudPanel's web server");
          expect(r.out).toMatch(/Port 80 is already in use by another service, so the panel is published on the raw ports/);
          expect(calls()).not.toMatch(/docker (stop|kill|rm)\b/);
        });
        it("an installed hub in IP mode with a foreign :80 holder is a red cross with exit 1", () => {
          const p = installed(["PANEL_IP_ROUTE=1"]);
          const r = doctor(clp, { SHIM_SS: ss, SHIM_COMPOSE_PS: ALL_UP, SHIM_PROXY_UP: "1" }, { envFile: p });
          expect(r.out).toContain("Port 80 is held by nginx (pid 812).");
          expect(r.code).toBe(1);
        });
      });

      describe("who holds the port: advice per holder (never a change)", () => {
        const advice: Array<[string, string, Box, string[]]> = [
          ["nginx", 'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=1,fd=6))', {}, ["That is a system web server, not Tugra", "systemctl disable --now nginx", "every site nginx serves goes offline"]],
          ["apache2", 'LISTEN 0 511 *:80 *:* users:(("apache2",pid=1,fd=4))', {}, ["systemctl disable --now apache2", "every site it serves goes offline"]],
          ["httpd", 'LISTEN 0 511 *:80 *:* users:(("httpd",pid=1,fd=4))', {}, ["systemctl disable --now httpd"]],
          ["caddy", 'LISTEN 0 4096 *:80 *:* users:(("caddy",pid=1,fd=7))', {}, ["Caddy can front Tugra itself", "systemctl disable --now caddy"]],
          ["clp-nginx", 'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("clp-nginx",pid=1,fd=6))', {}, ["That is CloudPanel's web server"]],
          ["plesk (nginx)", 'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=1,fd=6))', { plesk: true }, ["That is Plesk's web server", "takes every Plesk-hosted site offline"]],
          ["cpanel (httpd)", 'LISTEN 0 511 *:80 *:* users:(("httpd",pid=1,fd=4))', { cpanel: true }, ["That is cPanel/WHM's web server"]],
          ["cpanel (ea-nginx)", 'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=1,fd=6))', { cpanel: true }, ["That is cPanel/WHM's web server", "no supported way to put a custom reverse proxy"]],
          ["generic", 'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("mystery",pid=77,fd=4))', {}, ["Port 80 is held by mystery (pid 77).", "systemctl disable --now mystery"]],
          ["unreadable (not root)", "LISTEN 0 511 0.0.0.0:80 0.0.0.0:*", {}, ["Port 80 is held by a process.", "Run as root to see which process it is"]],
        ];
        it.each(advice)("%s", (_n, ss, box, expected) => {
          const r = doctor({ ...HETZNER, ...box }, { SHIM_SS: ss });
          for (const e of expected) expect(r.out).toContain(e);
          expect(r.calls).not.toMatch(/docker (stop|kill|rm)\b/);
        });

        it("a docker-proxy holder is mapped to its container: Coolify's proxy gets the Coolify advice and `docker stop coolify-proxy` with its consequence", () => {
          const r = doctor(HETZNER, {
            SHIM_SS: 'LISTEN 0 4096 0.0.0.0:80 0.0.0.0:* users:(("docker-proxy",pid=999,fd=7))',
            SHIM_DOCKER_PS: "coolify-proxy|0.0.0.0:80->80/tcp, :::80->80/tcp, 0.0.0.0:443->443/tcp\ncoolify|8000/tcp",
          });
          expect(r.out).toContain("Port 80 is held by container coolify-proxy.");
          expect(r.out).toContain("That is Coolify's proxy (Traefik)");
          expect(r.out).toContain("docker stop coolify-proxy");
          expect(r.out).toContain("every app Coolify serves through its proxy goes offline");
          expect(r.calls).not.toMatch(/docker (stop|kill|rm)\b/);
        });

        it("another Tugra's proxy on a host where THIS install has no .env", () => {
          const r = doctor(HETZNER, { SHIM_SS: 'LISTEN 0 4096 0.0.0.0:80 0.0.0.0:* users:(("docker-proxy",pid=9,fd=7))', SHIM_DOCKER_PS: "tugra-proxy|0.0.0.0:80->80/tcp" });
          expect(r.out).toContain("another Tugra install on this host");
          expect(r.out).toContain("docker stop tugra-proxy");
        });

        it("Tugra's own proxy on an installed host is fine, not a conflict", () => {
          const p = installed(["PANEL_IP_ROUTE=1"]);
          const r = doctor(HETZNER, { SHIM_SS: 'LISTEN 0 4096 0.0.0.0:80 0.0.0.0:* users:(("docker-proxy",pid=9,fd=7))', SHIM_DOCKER_PS: "tugra-proxy|0.0.0.0:80->80/tcp", SHIM_COMPOSE_PS: ALL_UP, SHIM_PROXY_UP: "1" }, { envFile: p });
          expect(r.out).toContain("Port 80 is held by Tugra's own tugra-proxy (this install)");
          expect(r.out).not.toContain("another Tugra");
        });

        it("a stranger on the raw hub port gets the HUB_PORT/WEB_PORT advice", () => {
          const r = doctor(HETZNER, { SHIM_SS: 'LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=5,fd=18))' });
          expect(r.out).toContain("Port 3000 is held by node (pid 5).");
          expect(r.out).toContain("HUB_PORT=3100 WEB_PORT=3101 ./scripts/install.sh");
        });
      });

      describe("host firewall", () => {
        const UFW_DENY = "Status: active\nLogging: on (low)\nDefault: deny (incoming), allow (outgoing), disabled (routed)\nNew profiles: skip\n\nTo                         Action      From\n--                         ------      ----\n22/tcp                     ALLOW IN    Anywhere\n22/tcp (v6)                ALLOW IN    Anywhere (v6)";
        // A host web server (not Docker) on :80/:443: the one case where an INPUT rule decides whether the port is reachable.
        const NGINX_80_443 = `${nginxSs}\nLISTEN 0 511 0.0.0.0:443 0.0.0.0:* users:(("nginx",pid=812,fd=8))`;
        it("ufw active, default deny, 80/443 not allowed, a host web server on them: the one-line command + the Docker/ufw bypass explanation", () => {
          const r = doctor(HETZNER, { SHIM_UFW: UFW_DENY, SHIM_SS: NGINX_80_443 }, { fw: ["ufw"] });
          expect(r.out).toContain("ufw is filtering inbound traffic and does not allow port(s) 80 443 (nginx on :80, nginx on :443)");
          expect(r.out).toContain("ufw allow 80/tcp && ");
          expect(r.out).toContain("ufw allow 443/tcp");
          expect(r.out).toContain("Docker-published ports bypass ufw/iptables INPUT rules");
          expect(r.out).toContain("HUB_BIND=127.0.0.1");
        });
        it("ufw deny with nothing on 80/443 (Tugra's own Docker-published ports): a note, never a red cross, and it says Docker is not filtered", () => {
          const r = doctor(HETZNER, { SHIM_UFW: UFW_DENY }, { fw: ["ufw"] });
          expect(r.out).toContain("ufw has no rule for port(s) 80 443. That does not block Tugra");
          expect(r.out).not.toContain("is filtering inbound traffic");
          expect(r.code).toBe(0);
        });
        it("ufw ignores ALLOW OUT rules and an ALLOW IN limited to one source: neither opens the port to the world", () => {
          const ufw = `${UFW_DENY}\n80/tcp                     ALLOW OUT   Anywhere\n443/tcp                    ALLOW IN    10.0.0.0/8`;
          const r = doctor(HETZNER, { SHIM_UFW: ufw, SHIM_SS: NGINX_80_443 }, { fw: ["ufw"] });
          expect(r.out).toContain("does not allow port(s) 80 443");
          const open = doctor(HETZNER, { SHIM_UFW: `${ufw}\n80,443/tcp                 ALLOW IN    Anywhere` }, { fw: ["ufw"] });
          expect(open.out).toContain("ufw is active and allows 80,443");
        });
        it("ufw allowing 80,443/tcp or the 'Nginx Full' profile is fine; 'Nginx HTTP' alone is not enough", () => {
          expect(doctor(HETZNER, { SHIM_UFW: `${UFW_DENY}\n80,443/tcp                 ALLOW IN    Anywhere` }, { fw: ["ufw"] }).out).toContain("ufw is active and allows 80,443");
          expect(doctor(HETZNER, { SHIM_UFW: `${UFW_DENY}\nNginx Full                 ALLOW IN    Anywhere` }, { fw: ["ufw"] }).out).toContain("ufw is active and allows 80,443");
          const r = doctor(HETZNER, { SHIM_UFW: `${UFW_DENY}\nNginx HTTP                 ALLOW IN    Anywhere` }, { fw: ["ufw"] });
          expect(r.out).toContain("no rule for port(s) 443.");
          expect(r.out).not.toContain("no rule for port(s) 80");
        });
        it("ufw inactive filters nothing; a firewall that cannot be read (not root) is UNKNOWN, never 'no firewall in the way'", () => {
          expect(doctor(HETZNER, { SHIM_UFW: "Status: inactive" }, { fw: ["ufw"] }).out).toContain("ufw is installed but inactive");
          const r = doctor(HETZNER, { SHIM_UFW_RC: "1" }, { fw: ["ufw"] });
          expect(r.out).toContain("ufw is installed but its state could not be read");
          expect(r.out).toContain("Host firewall: UNKNOWN -- ufw is installed but could not be read as this user");
          expect(r.out).not.toContain("No host firewall in the way");
        });
        it("a non-root run says so once (hidden process names, unreadable rules)", () => {
          expect(doctor(HETZNER, { SHIM_UID: "1000" }).out).toContain("Not running as root");
          expect(doctor(HETZNER, { SHIM_UID: "0" }).out).not.toContain("Not running as root");
        });
        it("a ufw that blocks :80 on an installed IP-mode hub whose tugra-proxy is up is NOT a problem (Docker-published ports skip INPUT)", () => {
          const r = doctor(HETZNER, { SHIM_UFW: UFW_DENY, SHIM_COMPOSE_PS: ALL_UP, SHIM_PROXY_UP: "1", SHIM_SS: 'LISTEN 0 4096 0.0.0.0:80 0.0.0.0:* users:(("docker-proxy",pid=9,fd=7))', SHIM_DOCKER_PS: "tugra-proxy|0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp" }, { fw: ["ufw"], envFile: installed(["PANEL_IP_ROUTE=1"]) });
          expect(r.code).toBe(0);
          expect(r.out).toContain("That does not block Tugra");
        });
        it("a bring-your-own-proxy install: the host nginx on :80/:443 is the front door (no 'disable nginx' advice) and a ufw that blocks it IS a red cross", () => {
          const byo = installed(["HUB_TRUSTED_PROXY=true", "HUB_PUBLIC_URL=https://panel.example.com", "HUB_BIND=127.0.0.1", "WEB_BIND=127.0.0.1"]);
          const ok = doctor(HETZNER, { SHIM_UFW: `${UFW_DENY}\n80,443/tcp                 ALLOW IN    Anywhere`, SHIM_SS: NGINX_80_443, SHIM_COMPOSE_PS: ALL_UP }, { fw: ["ufw"], envFile: byo });
          expect(ok.out).toContain("Install: byo mode");
          expect(ok.out).toContain("Port 80 is held by nginx (pid 812), the proxy in front of Tugra (bring-your-own-proxy install)");
          expect(ok.out).not.toContain("systemctl disable --now nginx");
          expect(ok.out).toContain("allow TCP 80, 443");
          expect(ok.out).not.toMatch(/allow TCP 80, 443, 3000/);
          expect(ok.code).toBe(0);
          const blocked = doctor(HETZNER, { SHIM_UFW: UFW_DENY, SHIM_SS: NGINX_80_443, SHIM_COMPOSE_PS: ALL_UP }, { fw: ["ufw"], envFile: byo });
          expect(blocked.out).toContain("ufw is filtering inbound traffic and does not allow port(s) 80 443");
          expect(blocked.code).toBe(1);
        });
        it("a raw-port install needs only its hub/web ports reachable, not 80/443", () => {
          const r = doctor(HETZNER, { SHIM_COMPOSE_PS: ALL_UP }, { envFile: installed([]) });
          expect(r.out).toContain("allow TCP 3000, 3001");
          expect(r.out).not.toContain("allow TCP 80");
        });
        it("firewalld: http/https services allowed -> ok; missing -> the firewall-cmd one-liner", () => {
          expect(doctor(HETZNER, { SHIM_FIREWALLD: "public (active)\n  target: default\n  services: dhcpv6-client http https ssh\n  ports: " }, { fw: ["firewall-cmd"] }).out).toContain("firewalld is running and allows 80,443");
          const r = doctor(HETZNER, { SHIM_FIREWALLD: "public (active)\n  target: default\n  services: ssh\n  ports: 8080/tcp", SHIM_SS: NGINX_80_443 }, { fw: ["firewall-cmd"] });
          expect(r.out).toContain("firewall-cmd --permanent --add-port=80/tcp --add-port=443/tcp && ");
          expect(r.out).toContain("firewall-cmd --reload");
        });
        it("nftables: an input chain with policy drop that lacks 80/443 -> `nft insert rule` (first, not shadowed); one that accepts them -> ok", () => {
          const drop = (rule: string): string => `table inet filter {\n\tchain input {\n\t\ttype filter hook input priority filter; policy drop;\n\t\tct state established,related accept\n${rule}\n\t}\n}`;
          const r = doctor(HETZNER, { SHIM_NFT: drop("\t\ttcp dport 22 accept"), SHIM_SS: NGINX_80_443 }, { fw: ["nft"] });
          expect(r.out).toContain("nftables is filtering inbound traffic and does not allow port(s) 80 443");
          expect(r.out).toContain("nft insert rule inet filter input tcp dport { 80, 443 } accept");
          expect(r.out).not.toContain("nft add rule");
          expect(doctor(HETZNER, { SHIM_NFT: drop("\t\ttcp dport { 22, 80, 443 } accept") }, { fw: ["nft"] }).out).toContain("nftables: the input chain allows 80,443");
        });
        it("iptables: policy ACCEPT but a trailing REJECT blocks; an ACCEPT written AFTER that REJECT never matches (use -I)", () => {
          const rules = "-P INPUT ACCEPT\n-A INPUT -p tcp -m tcp --dport 22 -j ACCEPT\n-A INPUT -j REJECT --reject-with icmp-host-prohibited\n-A INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT";
          const r = doctor(HETZNER, { SHIM_IPTABLES: rules, SHIM_SS: NGINX_80_443 }, { fw: ["iptables"] });
          expect(r.out).toContain("iptables is filtering inbound traffic and does not allow port(s) 80 443");
          expect(r.out).toContain("iptables -I INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT");
          const okRules = "-P INPUT DROP\n-A INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT";
          expect(doctor(HETZNER, { SHIM_IPTABLES: okRules }, { fw: ["iptables"] }).out).toContain("iptables: the INPUT chain allows 80,443");
        });
        it("iptables: a DROP policy with a jump to a custom chain (CSF, firewalld-direct, Imunify) is 'cannot tell', not blocked -- even on an installed hub", () => {
          const rules = "-P INPUT DROP\n-A INPUT -i lo -j ACCEPT\n-A INPUT -j CSF-INPUT";
          const r = doctor(HETZNER, { SHIM_IPTABLES: rules, SHIM_SS: NGINX_80_443 }, { fw: ["iptables"], envFile: installed(["HUB_TRUSTED_PROXY=true", "HUB_PUBLIC_URL=https://p.example.com", "HUB_BIND=127.0.0.1", "WEB_BIND=127.0.0.1"]) });
          expect(r.out).toContain("hands traffic to other chains (CSF-INPUT)");
          expect(r.out).not.toContain("is filtering inbound traffic");
        });
        it("iptables: an ACCEPT limited to one source (-s) or to loopback does not open the port", () => {
          const rules = "-P INPUT DROP\n-A INPUT -s 10.0.0.0/8 -p tcp -m multiport --dports 80,443 -j ACCEPT\n-A INPUT -i lo -p tcp -m tcp --dport 80 -j ACCEPT";
          const r = doctor(HETZNER, { SHIM_IPTABLES: rules, SHIM_SS: NGINX_80_443 }, { fw: ["iptables"] });
          expect(r.out).toContain("does not allow port(s) 80 443");
        });
        it("an active ufw owns the answer: nft/iptables are not consulted on top of it", () => {
          const r = doctor(HETZNER, { SHIM_UFW: `${UFW_DENY}\nNginx Full ALLOW IN Anywhere`, SHIM_IPTABLES: "-P INPUT DROP" }, { fw: ["ufw", "iptables"] });
          expect(r.out).toContain("ufw is active and allows 80,443");
          expect(r.out).not.toMatch(/iptables: /);
        });
      });

      describe("cloud provider detection (local files only, no network)", () => {
        const cases: Array<[string, Box, string, string]> = [
          ["AWS", { dmi: { sys_vendor: "Amazon EC2", product_name: "t3.micro", bios_vendor: "Amazon EC2" }, cloudId: "aws" }, "Hosting: AWS (EC2)", "Security Groups -> the group on this instance -> Inbound rules"],
          ["AWS (DMI only)", { dmi: { sys_vendor: "Amazon EC2", product_name: "m5.large" } }, "Hosting: AWS (EC2)", "Security Groups"],
          ["GCP", { dmi: { sys_vendor: "Google", product_name: "Google Compute Engine", bios_vendor: "Google" }, cloudId: "gce" }, "Hosting: Google Cloud", "VPC network -> Firewall: an ingress rule allowing tcp:80,443"],
          ["Azure", { dmi: { sys_vendor: "Microsoft Corporation", product_name: "Virtual Machine", chassis_asset_tag: "7783-7084-3265-9085-8269-3286-77" } }, "Hosting: Microsoft Azure", "Network security group -> Inbound security rules"],
          ["DigitalOcean", { dmi: { sys_vendor: "DigitalOcean", product_name: "Droplet" }, cloudId: "digitalocean" }, "Hosting: DigitalOcean", "Networking -> Firewalls"],
          ["Vultr", { dmi: { sys_vendor: "Vultr", product_name: "VC2" }, cloudId: "vultr" }, "Hosting: Vultr", "Products -> Firewall"],
          ["Linode / Akamai", { dmi: { sys_vendor: "Linode", product_name: "Linode" } }, "Hosting: Linode / Akamai Cloud", "Cloud Manager -> Firewalls"],
          ["Oracle", { dmi: { sys_vendor: "QEMU", chassis_asset_tag: "OracleCloud.com" }, cloudId: "oracle" }, "Hosting: Oracle Cloud", "Security List"],
          ["Scaleway", { dmi: { sys_vendor: "Scaleway", product_name: "SCW-DEV1-S" }, cloudId: "scaleway" }, "Hosting: Scaleway", "Security Groups"],
          ["OVH", { dmi: { sys_vendor: "OVH", product_name: "OpenStack Nova" } }, "Hosting: OVHcloud", "Edge Network Firewall"],
          ["Contabo (hostname)", { dmi: { sys_vendor: "QEMU", product_name: "Standard PC (Q35 + ICH9, 2009)" }, hostname: "vmi1234567.contaboserver.net" }, "Hosting: Contabo", "no provider firewall unless you attached one"],
          ["generic KVM", { dmi: { sys_vendor: "QEMU", product_name: "Standard PC (i440FX + PIIX, 1996)", bios_vendor: "SeaBIOS" }, hostname: "myhost" }, "Hosting: a KVM/QEMU virtual server", "wherever your provider filters inbound traffic"],
          ["bare metal", { dmi: { sys_vendor: "Dell Inc.", product_name: "PowerEdge R640" }, hostname: "metal" }, "no cloud provider recognised", "allow TCP 80, 443"],
        ];
        it.each(cases)("%s", (_n, box, hosting, hint) => {
          const r = doctor(box);
          expect(r.out).toContain(hosting);
          expect(r.out).toContain(hint);
          expect(r.calls).not.toMatch(/curl/); // no network call to find out
        });
        it("the cloud-init datasource file identifies a provider when cloud-id is absent", () => {
          const { root, dmi } = fsRoot({ dmi: { sys_vendor: "Something" } });
          mkdirSync(join(root, "var", "lib", "cloud", "instance"), { recursive: true });
          writeFileSync(join(root, "var", "lib", "cloud", "instance", "datasource"), "DataSourceHetzner [seed=dsmode]\n");
          const r = spawnSync(BASH, [INSTALL_SH, "--doctor", "--env-file", join(base, "nope.env")], { encoding: "utf8", env: { PATH: pathFor([]), SHIM_LOG: join(base, "ds.log"), TUGRA_FS_ROOT: root, TUGRA_DMI_ROOT: dmi, TUGRA_HOSTNAME: "x", TMPDIR: base } as NodeJS.ProcessEnv });
          expect(`${r.stdout}${r.stderr}`).toContain("Hosting: Hetzner");
        });
      });

      describe("IPv6 / AAAA", () => {
        const V6 = "2a0104f800010000000000000000abcd"; // 2a01:4f8:1::abcd
        it("a global IPv6 is reported with the AAAA / cloud-firewall hint", () => {
          const r = doctor({ ...HETZNER, v6: [V6] });
          expect(r.out).toContain("IPv6: this host has a global address (2a01:4f8:1:0:0:0:0:abcd)");
          expect(r.out).toContain("allow TCP 80/443 for IPv6");
        });
        it("a domain whose AAAA is NOT this host warns with the fix (Let's Encrypt tries IPv6 first)", () => {
          const r = doctor({ ...HETZNER, v6: [V6] }, { SHIM_GETENT6: "2001:db8::1", SHIM_GETENT: "203.0.113.7" }, { args: ["--domain", "panel.example.com"] });
          expect(r.out).toContain("panel.example.com has an AAAA record (2001:db8::1) that is NOT this host's IPv6");
          expect(r.out).toContain("point the AAAA record at this host's IPv6");
        });
        it("an AAAA that matches this host (compressed vs expanded form) is fine", () => {
          const r = doctor({ ...HETZNER, v6: [V6] }, { SHIM_GETENT6: "2a01:4f8:1::abcd" }, { args: ["--domain", "panel.example.com"] });
          expect(r.out).toContain("panel.example.com's AAAA record points at this host");
        });
        it("an AAAA with no IPv6 on the host warns (the certificate would fail); an A-only name (IPv4-mapped answer) does not", () => {
          const warn = doctor(HETZNER, { SHIM_GETENT6: "2001:db8::1" }, { args: ["--domain", "panel.example.com"] });
          expect(warn.out).toContain("has an AAAA record (2001:db8::1) but this host has no IPv6");
          const quiet = doctor(HETZNER, { SHIM_GETENT6: "::ffff:203.0.113.7" }, { args: ["--domain", "panel.example.com"] });
          expect(quiet.out).not.toContain("AAAA record (");
          expect(quiet.out).toContain("IPv6: none on this host");
        });
      });

      describe("IPv6 address selection and counted AAAA problems", () => {
        const V6 = "2a0104f800010000000000000000abcd";
        const ULA = "fd7a115c a5c0 0000 0000 0000 0000 0001".replace(/ /g, ""); // a Tailscale-style unique-local address
        it("a Tailscale / Docker unique-local (fc00::/7) address is not 'a global address'", () => {
          const r = doctor({ ...HETZNER, v6Lines: [`${ULA} 05 80 00 80 tailscale0`, "fd00000000000000000000000000abcd 06 40 00 80 docker0"] });
          expect(r.out).toContain("IPv6: none on this host");
          expect(r.out).not.toContain("fd7a");
        });
        it("the interface of the IPv6 default route wins; temporary (privacy) addresses are skipped", () => {
          const other = "2001db8000000000000000000000beef";
          const temp = "2001db8000000000aaaaaaaaaaaaaaaa";
          const r = doctor({
            ...HETZNER,
            v6Lines: [`${other} 03 40 00 80 wg0`, `${temp} 02 40 00 01 eth0`, `${V6} 02 40 00 80 eth0`],
            v6Route: "00000000000000000000000000000000 00 00000000000000000000000000000000 00 fe80000000000000f816feffee000001 00000400 00000001 00000000 00000003 eth0",
          });
          expect(r.out).toContain("IPv6: this host has a global address (2a01:4f8:1:0:0:0:0:abcd)");
        });
        it("Cloudflare's 2a06:98c0::/29 (98c0-98c7) counts as a Cloudflare address, 98c8 does not", () => {
          const cf = doctor({ ...HETZNER, v6: [V6] }, { SHIM_GETENT6: "2a06:98c7::1" }, { args: ["--domain", "panel.example.com"] });
          expect(cf.out).toContain("AAAA record is a Cloudflare address (proxied): fine");
          const no = doctor({ ...HETZNER, v6: [V6] }, { SHIM_GETENT6: "2a06:98c8::1" }, { args: ["--domain", "panel.example.com"] });
          expect(no.out).toContain("that is NOT this host's IPv6");
        });
        it("an AAAA that points elsewhere is a warning on a fresh host but a red cross (exit 1) on an installed one", () => {
          const fresh = doctor(HETZNER, { SHIM_GETENT6: "2001:db8::1" }, { args: ["--domain", "panel.example.com"] });
          expect(fresh.code).toBe(0);
          const p = installed(["PANEL_TLS=1", "PANEL_DOMAIN=panel.example.com", "HUB_PUBLIC_URL=https://panel.example.com"]);
          const r = doctor(HETZNER, { SHIM_COMPOSE_PS: ALL_UP, SHIM_PROXY_UP: "1", SHIM_GETENT: "203.0.113.7", SHIM_GETENT6: "2001:db8::1" }, { envFile: p });
          expect(r.out).toContain("has an AAAA record (2001:db8::1) but this host has no IPv6");
          expect(r.code).toBe(1);
        });
      });

      describe("private / NAT address (the installer's existing warning, reused)", () => {
        it("a private interface address with no --public-ip prints the same warning the install does", () => {
          const r = doctor(HETZNER, { SHIM_HOSTNAME_I: "10.0.0.5" });
          expect(r.out).toContain("This server's address (10.0.0.5) is a private one");
          expect(r.out).toContain("--public-ip <the server's public IP>");
        });
      });

      describe("--doctor on an installed hub", () => {
        it("healthy IP-mode install: containers, proxy routes, hub and agent all green -> exit 0", () => {
          const r = doctor(HETZNER, { SHIM_COMPOSE_PS: ALL_UP, SHIM_PROXY_UP: "1", SHIM_AGENT_LOG: "agent starting\n2026/11/23 12:00:00 hub session on ws://hub-api:3000/agent established" }, { envFile: installed(["PANEL_IP_ROUTE=1"]) });
          expect(r.out).toContain("Install: ip mode");
          expect(r.out).toContain("Container hub-api: running (healthy)");
          expect(r.out).toContain("Container tugra-proxy: running");
          expect(r.out).toContain("Hub answers on http://127.0.0.1:3000/health");
          expect(r.out).toContain("Proxy route / host-less -> hub: http://127.0.0.1/health answers");
          expect(r.out).toContain("Proxy route / -> web: http://127.0.0.1/ answers");
          expect(r.out).toContain("Local agent: connected to the hub");
          expect(r.out).toContain("Doctor: no problems found.");
          expect(r.code).toBe(0);
        });
        it("an agent that reconnected after a hub restart is connected: the failure lines BEFORE its 'established' line do not count", () => {
          const log = ["2026/11/23 12:00:00 hub session on ws://hub-api:3000/agent ended: EOF", "2026/11/23 12:00:01 hub endpoint ws://hub-api:3000/agent: dial tcp: connection refused", "2026/11/23 12:00:01 no hub endpoint reachable; retrying in 1s", "2026/11/23 12:00:09 hub session on ws://hub-api:3000/agent established"].join("\n");
          const r = doctor(HETZNER, { SHIM_COMPOSE_PS: ALL_UP, SHIM_PROXY_UP: "1", SHIM_AGENT_LOG: log }, { envFile: installed(["PANEL_IP_ROUTE=1"]) });
          expect(r.out).toContain("Local agent: connected to the hub");
          expect(r.code).toBe(0);
        });
        it("an older agent logs nothing on a successful reconnect: an OLD failure line is not a verdict, a RECENT one is", () => {
          const ago = (sec: number): string => new Date(Date.now() - sec * 1000).toISOString().replace(/\.\d+Z$/, ".123456789Z");
          const fail = (t: string): string => `${t} 2026/11/23 hub endpoint ws://hub-api:3000/agent: dial tcp: connection refused`;
          const stale = doctor(HETZNER, { SHIM_COMPOSE_PS: ALL_UP, SHIM_PROXY_UP: "1", SHIM_AGENT_LOG: fail(ago(900)) }, { envFile: installed(["PANEL_IP_ROUTE=1"]) });
          expect(stale.out).toMatch(/Local agent: running; the last connection error in its log is 1\d min old/);
          expect(stale.code).toBe(0);
          const fresh = doctor(HETZNER, { SHIM_COMPOSE_PS: ALL_UP, SHIM_PROXY_UP: "1", SHIM_AGENT_LOG: fail(ago(20)) }, { envFile: installed(["PANEL_IP_ROUTE=1"]) });
          expect(fresh.out).toContain("Local agent is not connected to the hub: 2026/11/23 hub endpoint");
          expect(fresh.code).toBe(1);
        });
        it("a self-updated agent (plain `docker run` as tugra-agent-1, unknown to compose) is found and checked, not reported as 'not created'", () => {
          const ps = ["postgres|running|healthy", "redis|running|healthy", "hub-api|running|healthy", "web|running|"].join("\n");
          const r = doctor(HETZNER, { SHIM_COMPOSE_PS: ps, SHIM_PROXY_UP: "1", SHIM_UNMANAGED_AGENT_STATE: "running", SHIM_AGENT_LOG: "2026/11/23 12:00:09 hub session on ws://hub-api:3000/agent established" }, { envFile: installed(["PANEL_IP_ROUTE=1"]) });
          expect(r.out).toContain("Container agent: running as tugra-agent-1 (self-updated, outside docker compose");
          expect(r.out).not.toContain("Container agent: not created");
          expect(r.out).toContain("Local agent: connected to the hub");
          expect(r.code).toBe(0);
          const dead = doctor(HETZNER, { SHIM_COMPOSE_PS: ps, SHIM_PROXY_UP: "1", SHIM_UNMANAGED_AGENT_STATE: "exited" }, { envFile: installed(["PANEL_IP_ROUTE=1"]) });
          expect(dead.out).toContain("Container agent (tugra-agent-1, outside docker compose): exited.");
          expect(dead.code).toBe(1);
          const none = doctor(HETZNER, { SHIM_COMPOSE_PS: ps, SHIM_PROXY_UP: "1" }, { envFile: installed(["PANEL_IP_ROUTE=1"]) });
          expect(none.out).toContain("Container agent: not created.");
        });
        it("a stopped container, a dead proxy, an unreachable panel and a disconnected agent each get a red cross AND a fix; exit 1", () => {
          const ps = ["postgres|running|healthy", "redis|running|healthy", "hub-api|exited|", "web|running|", "agent|running|"].join("\n");
          const r = doctor(
            HETZNER,
            { SHIM_COMPOSE_PS: ps, SHIM_CURL_FAIL_MATCH: "127.0.0.1", SHIM_AGENT_LOG: "2026/11/23 hub endpoint ws://hub-api:3000/agent: dial tcp: connection refused\n2026/11/23 no hub endpoint reachable; retrying in 4s" },
            { envFile: installed(["PANEL_IP_ROUTE=1"]) },
          );
          expect(r.code).toBe(1);
          expect(r.out).toContain("Container hub-api: exited.");
          expect(r.out).toContain("up -d hub-api");
          expect(r.out).toContain("Container tugra-proxy is not running");
          expect(r.out).toContain("The hub does not answer on http://127.0.0.1:3000/health");
          expect(r.out).toContain("The proxy does not route http://127.0.0.1/health to the hub");
          expect(r.out).toContain("Local agent is not connected to the hub");
          expect(r.out).toMatch(/Doctor: \d+ problem\(s\) found/);
        });
        it("a bundled-TLS install: the certificate for PANEL_DOMAIN is checked; an untrusted default cert is a red cross with the ACME fix", () => {
          const p = installed(["PANEL_TLS=1", "PANEL_DOMAIN=panel.example.com", "HUB_PUBLIC_URL=https://panel.example.com"]);
          const good = doctor(HETZNER, { SHIM_COMPOSE_PS: ALL_UP, SHIM_PROXY_UP: "1", SHIM_GETENT: "203.0.113.7" }, { envFile: p });
          expect(good.out).toContain("Proxy route https://panel.example.com/health -> hub answers");
          expect(good.out).toContain("Certificate for panel.example.com is present and trusted");
          expect(good.code).toBe(0);
          const bad = doctor(HETZNER, { SHIM_COMPOSE_PS: ALL_UP, SHIM_PROXY_UP: "1", SHIM_GETENT: "203.0.113.7", SHIM_CURL_STRICT_RC: "60" }, { envFile: p });
          expect(bad.out).toContain("No valid certificate for panel.example.com (curl exit 60)");
          expect(bad.out).toContain("docker logs tugra-proxy 2>&1 | grep -i acme");
          expect(bad.code).toBe(1);
        });
        it("a bundled-TLS install reuses the DNS/Cloudflare advice (panel_dns_preflight): a record that points elsewhere is flagged", () => {
          const p = installed(["PANEL_TLS=1", "PANEL_DOMAIN=panel.example.com", "HUB_PUBLIC_URL=https://panel.example.com"]);
          const r = doctor(HETZNER, { SHIM_COMPOSE_PS: ALL_UP, SHIM_PROXY_UP: "1", SHIM_GETENT: "198.51.100.9" }, { envFile: p });
          expect(r.out).toContain("panel.example.com resolves to 198.51.100.9, but this host's address is 203.0.113.7");
          const cf = doctor(HETZNER, { SHIM_COMPOSE_PS: ALL_UP, SHIM_PROXY_UP: "1", SHIM_GETENT: "104.21.1.1" }, { envFile: p });
          expect(cf.out).toContain("behind Cloudflare's proxy (orange cloud)");
        });
        it("a raw-ports install probes the hub and web ports", () => {
          const r = doctor(HETZNER, { SHIM_COMPOSE_PS: ALL_UP }, { envFile: installed([]) });
          expect(r.out).toContain("Install: raw mode");
          expect(r.out).toContain("Web UI answers on port 3001");
          expect(r.code).toBe(0);
        });
        it("is strictly read-only: no .env is created or rewritten, and Docker only ever sees reads", () => {
          const p = installed(["PANEL_IP_ROUTE=1"]);
          const before = readFileSync(p, "utf8");
          const r = doctor(HETZNER, { SHIM_COMPOSE_PS: ALL_UP, SHIM_PROXY_UP: "1" }, { envFile: p });
          expect(readFileSync(p, "utf8")).toBe(before);
          expect(readdirSync(base).filter((f) => f.startsWith("inst") && f.endsWith(".env.before"))).toEqual([]);
          const dockerCalls = r.calls.split("\n").filter((l) => l.startsWith("docker "));
          expect(dockerCalls.length).toBeGreaterThan(0);
          for (const c of dockerCalls) expect(c).toMatch(/^docker (info|version|ps|logs|compose .*\b(ps|logs|version)\b)/);
          const fresh = join(base, "fresh-never-created.env");
          doctor(HETZNER, {}, { envFile: fresh });
          expect(existsSync(fresh)).toBe(false);
        });
      });

      it("--help documents --doctor", () => {
        const r = spawnSync(BASH, [INSTALL_SH, "--help"], { encoding: "utf8" });
        expect(r.stdout).toContain("--doctor");
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

    it("hands the web container the SAME proxy-trust settings as the hub so it can guard the forwarded client IP", () => {
      const webEnv = compose.services["web"].environment ?? {};
      const hubEnv = compose.services["hub-api"].environment ?? {};
      expect(webEnv.HUB_TRUSTED_PROXY).toBe(hubEnv.HUB_TRUSTED_PROXY);
      expect(webEnv.HUB_TRUSTED_PROXY).toBe("${HUB_TRUSTED_PROXY:-false}"); // spoof-safe default: off
      expect(webEnv.HUB_TRUSTED_PROXY_CIDRS).toBe("${HUB_TRUSTED_PROXY_CIDRS:-}");
      expect(webEnv.HUB_TRUSTED_PROXY_STRICT).toBe("${HUB_TRUSTED_PROXY_STRICT:-false}");
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
