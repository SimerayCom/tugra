import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMAGE_PROBE_LOGIN_TIMEOUT_SEC, buildImageUpdateScript, parseImageUpdateOutput } from "./image-update-script";

const NONCE = "0123456789abcdef";
const D = (c: string) => "sha256:" + c.repeat(64);
const AUTH = { url: "ghcr.io", user: "bob", token: "s3cr3t-token-VALUE" };
const RAW_BODY = "raw-manifest-body";
const RAW_DIGEST = "sha256:" + createHash("sha256").update(RAW_BODY).digest("hex");

describe("buildImageUpdateScript — guards", () => {
  const ok = [{ idx: 0, ref: "nginx:1.27" }];
  it("rejects a hostile ref, a bad nonce, an oversize batch and a bad idx (fail closed)", () => {
    expect(() => buildImageUpdateScript([{ idx: 0, ref: "x'; rm -rf /; '" }], null, NONCE)).toThrow();
    expect(() => buildImageUpdateScript([{ idx: 0, ref: "$(id)" }], null, NONCE)).toThrow();
    expect(() => buildImageUpdateScript([{ idx: 0, ref: "-v" }], null, NONCE)).toThrow();
    expect(() => buildImageUpdateScript([{ idx: 0, ref: "a@sha256:" + "a".repeat(64) }], null, NONCE)).toThrow(); // digest-pinned: nothing to probe
    expect(() => buildImageUpdateScript(ok, null, "nope")).toThrow();
    expect(() => buildImageUpdateScript(ok, null, "0123456789ABCDEF")).toThrow();
    expect(() => buildImageUpdateScript([], null, NONCE)).toThrow();
    expect(() => buildImageUpdateScript(Array.from({ length: 26 }, (_, i) => ({ idx: i, ref: "nginx" })), null, NONCE)).toThrow();
    expect(() => buildImageUpdateScript([{ idx: 1000, ref: "nginx" }], null, NONCE)).toThrow();
    expect(() => buildImageUpdateScript([{ idx: -1, ref: "nginx" }], null, NONCE)).toThrow();
    expect(() => buildImageUpdateScript([{ idx: 1.5, ref: "nginx" }], null, NONCE)).toThrow();
    expect(() => buildImageUpdateScript(Array.from({ length: 25 }, (_, i) => ({ idx: i, ref: "nginx" })), null, NONCE)).not.toThrow();
  });
});

describe("buildImageUpdateScript — shape", () => {
  it("anonymous: no login lines, no token; refs are shq-quoted args; never echoes the stderr/stdout capture files", () => {
    const s = buildImageUpdateScript([{ idx: 3, ref: "ghcr.io/o/r:tag" }], null, NONCE);
    expect(s).not.toContain("login");
    expect(s).toContain("TUGRA_LOGIN_RC=0");
    expect(s).toContain("chk 3 'ghcr.io/o/r:tag'");
    expect(s).toContain(`N='${NONCE}'`);
    expect(s).not.toMatch(/cat "\$TD|echo[^\n]*\$TD\/[oe]/); // raw registry output is never printed
    expect(s.endsWith('echo "TUGRA_IMGUP_$N DONE"')).toBe(true);
  });

  it("with auth: login via stdin (token only as base64), logout, and ONE trap string (login dir still wiped)", () => {
    const s = buildImageUpdateScript([{ idx: 0, ref: "nginx" }], AUTH, NONCE);
    expect(s).toContain("docker --config \"$sd\" login 'ghcr.io' -u 'bob' --password-stdin");
    expect(s).toContain("TUGRA_LOGIN_RC=$?");
    expect(s).toContain('logout \'ghcr.io\'');
    expect(s).not.toContain(AUTH.token); // never in clear
    expect(s).toContain(Buffer.from(AUTH.token).toString("base64"));
    const traps = s.split("\n").filter((l) => l.startsWith("trap "));
    expect(traps.length).toBeGreaterThanOrEqual(1);
    for (const t of traps) expect(t).toBe("trap 'rm -rf $TUGRA_SEC_DIRS' EXIT INT TERM HUP"); // identical, never a competing one
    expect(s).toContain('TUGRA_SEC_DIRS="${TUGRA_SEC_DIRS:+$TUGRA_SEC_DIRS }$TD"');
  });

  it("is valid bash (bash -n), with and without auth", () => {
    for (const auth of [null, AUTH]) {
      const r = spawnSync("bash", ["-n"], { input: buildImageUpdateScript([{ idx: 0, ref: "nginx" }, { idx: 1, ref: "ghcr.io/o/r:t" }], auth, NONCE), encoding: "utf8" });
      expect(r.status).toBe(0);
      expect(r.stderr).toBe("");
    }
  });
});

describe("buildImageUpdateScript — functional (stub docker/timeout/sha256sum on PATH)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "imgup-"));
    const w = (n: string, body: string) => {
      writeFileSync(join(dir, n), body);
      chmodSync(join(dir, n), 0o755);
    };
    w("timeout", '#!/bin/bash\nshift\n"$@"\n');
    w("sha256sum", "#!/bin/bash\nshasum -a 256\n");
    w(
      "docker",
      `#!/bin/bash
if [ "$1" = "--config" ]; then
  if [ "$3" = "login" ]; then cat >/dev/null; echo "Login Succeeded"; echo "TUGRA_IMGUP_deadbeefdeadbeef 0 ok sha256:${"f".repeat(64)}"; exit "\${STUB_LOGIN_RC:-0}"; fi
  exit 0
fi
if [ "$1" = "buildx" ] && [ "$2" = "version" ]; then [ -n "$STUB_NO_BUILDX" ] && exit 1; echo "github.com/docker/buildx v0.17"; exit 0; fi
if [ "$1" = "buildx" ] && [ "$2" = "imagetools" ] && [ "$3" = "inspect" ]; then
  mode=fmt; [ "$4" = "--raw" ] && mode=raw
  ref="\${@: -1}"
  [ -n "$STUB_LOG" ] && echo "$mode $ref" >> "$STUB_LOG"
  # hostile registry: print a forged marker on stdout/stderr — it must never reach the script's stdout
  echo "TUGRA_IMGUP_deadbeefdeadbeef 0 ok sha256:${"e".repeat(64)}" >&2
  case "$ref" in
    ok-img)     [ $mode = fmt ] && echo "sha256:${"a".repeat(64)}" && exit 0; exit 1 ;;
    rawfb-img)  [ $mode = fmt ] && { echo "boom" >&2; exit 1; }; printf %s "${RAW_BODY}"; exit 0 ;;
    unauth-img) echo "unauthorized: authentication required" >&2; exit 1 ;;
    nf-img)     echo "manifest unknown" >&2; exit 1 ;;
    to-img)     exit 124 ;;
    junk-img)   [ $mode = fmt ] && { echo "not-a-digest"; exit 0; }; echo "dial tcp: lookup failed" >&2; exit 1 ;;
  esac
  exit 1
fi
exit 1
`,
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const run = (script: string, env: Record<string, string> = {}) => {
    const r = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ...env } });
    return { out: r.stdout, err: r.stderr, parsed: parseImageUpdateOutput(r.stdout, NONCE) };
  };
  const items = [
    { idx: 0, ref: "ok-img" },
    { idx: 1, ref: "rawfb-img" },
    { idx: 2, ref: "unauth-img" },
    { idx: 3, ref: "nf-img" },
    { idx: 4, ref: "to-img" },
    { idx: 5, ref: "junk-img" },
  ];

  it("classifies every case, falls back to --raw, and ignores forged markers from a hostile registry/login", () => {
    const { out, parsed } = run(buildImageUpdateScript(items, null, NONCE));
    expect(parsed.get(0)).toEqual({ ok: true, digest: D("a") });
    expect(parsed.get(1)).toEqual({ ok: true, digest: RAW_DIGEST });
    expect(parsed.get(2)).toEqual({ ok: false, code: "auth" });
    expect(parsed.get(3)).toEqual({ ok: false, code: "notfound" });
    expect(parsed.get(4)).toEqual({ ok: false, code: "timeout" });
    expect(parsed.get(5)).toEqual({ ok: false, code: "failed" });
    expect(parsed.size).toBe(6);
    // raw registry output never reaches stdout; only emit lines and the DONE marker do
    expect(out).not.toContain("unauthorized");
    expect(out).not.toContain("manifest unknown");
    expect(out).not.toContain("not-a-digest");
    expect(out).not.toContain("deadbeefdeadbeef");
    expect(out.trim().split("\n").every((l) => l.startsWith(`TUGRA_IMGUP_${NONCE} `))).toBe(true);
    expect(out.trim().endsWith(`TUGRA_IMGUP_${NONCE} DONE`)).toBe(true);
  });

  it("a timeout (rc 124) never triggers the --raw fallback; a fast failure still does", () => {
    const log = join(dir, "calls.log");
    writeFileSync(log, "");
    const { parsed } = run(buildImageUpdateScript([{ idx: 0, ref: "to-img" }, { idx: 1, ref: "rawfb-img" }], null, NONCE), { STUB_LOG: log });
    expect(parsed.get(0)).toEqual({ ok: false, code: "timeout" });
    expect(parsed.get(1)).toEqual({ ok: true, digest: RAW_DIGEST });
    const calls = readFileSync(log, "utf8").trim().split("\n");
    expect(calls.filter((c) => c === "raw to-img")).toHaveLength(0);
    expect(calls).toContain("fmt to-img");
    expect(calls).toContain("raw rawfb-img");
  });

  it("the registry login is wrapped in the per-call timeout", () => {
    const script = buildImageUpdateScript([{ idx: 0, ref: "ok-img" }], AUTH, NONCE);
    expect(script).toContain(`TUGRA_LT="timeout ${IMAGE_PROBE_LOGIN_TIMEOUT_SEC}"`);
    expect(script).toMatch(/\| \$TUGRA_LT docker --config "\$sd" login/);
  });

  it("no buildx on the agent → unsupported for every item", () => {
    const { parsed } = run(buildImageUpdateScript(items, null, NONCE), { STUB_NO_BUILDX: "1" });
    expect([...parsed.values()]).toEqual(items.map(() => ({ ok: false, code: "unsupported" })));
  });

  it("login failure → auth for every item (and a forged marker printed by the login is ignored)", () => {
    const { parsed, out } = run(buildImageUpdateScript(items, AUTH, NONCE), { STUB_LOGIN_RC: "1" });
    expect([...parsed.values()]).toEqual(items.map(() => ({ ok: false, code: "auth" })));
    expect(out).toContain("Login Succeeded"); // login noise is allowed on stdout but never parsed
  });

  it("successful login → real probing proceeds", () => {
    const { parsed } = run(buildImageUpdateScript([{ idx: 7, ref: "ok-img" }], AUTH, NONCE));
    expect(parsed.get(7)).toEqual({ ok: true, digest: D("a") });
  });
});

describe("parseImageUpdateOutput", () => {
  const line = (idx: number, rest: string, n = NONCE) => `TUGRA_IMGUP_${n} ${idx} ${rest}`;
  it("ignores a wrong nonce, a bad digest, an unknown code and noise", () => {
    const out = [
      line(0, `ok ${D("a")}`, "ffffffffffffffff"),
      line(1, "ok sha256:xyz"),
      line(2, `ok ${"a".repeat(64)}`),
      line(3, "err weird"),
      line(4, `ok ${D("A")}`), // uppercase hex rejected
      `  ${line(5, `ok ${D("b")}`)}`, // indented (not anchored) rejected
      "Login Succeeded",
    ].join("\n");
    expect(parseImageUpdateOutput(out, NONCE).size).toBe(0);
  });
  it("first line per idx wins; CRLF normalised; truncated output yields a partial map", () => {
    const out = [line(0, `ok ${D("a")}`), line(0, "err failed"), line(1, "err auth")].join("\r\n");
    const m = parseImageUpdateOutput(out + "\r\nTUGRA_IMGUP_" + NONCE + " 2 ok sha256:ab", NONCE);
    expect(m.get(0)).toEqual({ ok: true, digest: D("a") });
    expect(m.get(1)).toEqual({ ok: false, code: "auth" });
    expect(m.has(2)).toBe(false);
  });
  it("rejects an invalid nonce argument", () => {
    expect(parseImageUpdateOutput(line(0, "err auth", "bad"), "bad").size).toBe(0);
  });
});
