import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { HOST_FILES_HEADER, buildHostFilesManifest, hostFilesDigest, sha256Hex } from "./host-files";
import { derivePublicKeyB64, seedToPrivateKey, signDetached } from "./manifest-merge";

/**
 * Drives the REAL scripts/update.sh + scripts/lib/hostfiles.sh end to end (non-dry, PATH shims for docker,
 * redis-cli and curl; real openssl, real sha256sum) against a throwaway "checkout" and a fake release server whose
 * files are produced by the SAME TypeScript module the release runner uses — so the format, the ed25519 signature
 * and the path rule are verified across both implementations.
 */

const SCRIPTS = join(__dirname, "..", "..", "..", "..", "scripts");
const REAL_UPDATE = readFileSync(join(SCRIPTS, "update.sh"), "utf8");
const REAL_SNAPSHOT = readFileSync(join(SCRIPTS, "lib", "snapshot.sh"), "utf8");
const REAL_HOSTFILES = readFileSync(join(SCRIPTS, "lib", "hostfiles.sh"), "utf8");
const REAL_IMAGES = readFileSync(join(SCRIPTS, "lib", "images.sh"), "utf8");
const BASH = execFileSync("sh", ["-c", "command -v bash"]).toString().trim();

const BASE_URL = "https://example.test/tugra";
const OLD_COMPOSE = "name: tugra\n# old compose\nservices:\n  hub-api:\n    image: ghcr.io/simeraycom/tugra-hub:${TUGRA_VERSION:-latest}${TUGRA_HUB_DIGEST:+@sha256:}${TUGRA_HUB_DIGEST:-}\n  web:\n    image: ghcr.io/simeraycom/tugra-web:${TUGRA_VERSION:-latest}${TUGRA_WEB_DIGEST:+@sha256:}${TUGRA_WEB_DIGEST:-}\n";
const NEW_COMPOSE = OLD_COMPOSE.replace("# old compose", "# new compose (adds a service)");
const OLD_INSTALL = "#!/usr/bin/env bash\n# old installer\n";
const NEW_INSTALL = "#!/usr/bin/env bash\n# new installer\n";

function keypair() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const seedB64 = Buffer.from(privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32)).toString("base64");
  const priv = seedToPrivateKey(seedB64);
  return { priv, publicKeyB64: derivePublicKeyB64(priv) };
}

// Does this machine's openssl verify ed25519 (OpenSSL >= 3; macOS' stock LibreSSL cannot)? The sidecar image ships
// OpenSSL 3, and so does CI — without it these end-to-end checks cannot run, so they skip rather than lie.
function opensslVerifiesEd25519(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "hf-probe-"));
  try {
    const { priv, publicKeyB64 } = keypair();
    writeFileSync(join(dir, "m"), "probe\n");
    writeFileSync(join(dir, "m.sig"), signDetached(priv, "probe\n"));
    const r = spawnSync(BASH, ["-c", `. "${join(SCRIPTS, "lib", "hostfiles.sh")}"; hf_verify_sig "${join(dir, "m")}" "${join(dir, "m.sig")}" "${publicKeyB64}"`], { encoding: "utf8" });
    return r.status === 0;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const suite = opensslVerifiesEd25519() ? describe : describe.skip;

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

interface Rig {
  dir: string;
  repo: string;
  rel: string;
  envFile: string;
  log: string;
  pub: string;
  priv: ReturnType<typeof keypair>["priv"];
  envText: string;
}

const ENV_LINES = ["POSTGRES_PASSWORD=s3cr3t-do-not-touch", "JWT_ACCESS_SECRET=abc/def+ghi==", "HUB_PUBLIC_URL=https://hub.example.com", "CUSTOM_SETTING=keep me"];

function makeRig(extraEnv: string[] = []): Rig {
  const dir = mkdtempSync(join(tmpdir(), "hf-rig-"));
  dirs.push(dir);
  const repo = join(dir, "repo");
  const bin = join(dir, "bin");
  const rel = join(dir, "rel");
  for (const d of [join(repo, "scripts", "lib"), join(repo, "deploy"), bin, rel]) mkdirSync(d, { recursive: true });
  writeFileSync(join(repo, "scripts", "update.sh"), REAL_UPDATE, { mode: 0o755 });
  writeFileSync(join(repo, "scripts", "lib", "snapshot.sh"), REAL_SNAPSHOT, { mode: 0o755 });
  writeFileSync(join(repo, "scripts", "lib", "hostfiles.sh"), REAL_HOSTFILES, { mode: 0o755 });
  writeFileSync(join(repo, "scripts", "lib", "images.sh"), REAL_IMAGES, { mode: 0o755 });
  writeFileSync(join(repo, "scripts", "install.sh"), OLD_INSTALL, { mode: 0o755 });
  writeFileSync(join(repo, "deploy", "docker-compose.yml"), OLD_COMPOSE);
  const { priv, publicKeyB64 } = keypair();
  const envText = ["TUGRA_VERSION=0.1.0", ...ENV_LINES, `UPDATE_MANIFEST_URL=${BASE_URL}/versions.json`, `UPDATE_PUBLISHER_KEY=${publicKeyB64}`, ...extraEnv].join("\n") + "\n";
  const envFile = join(repo, ".env");
  writeFileSync(envFile, envText);
  const log = join(dir, "calls.log");
  writeFileSync(log, "");

  // docker: logs everything; behaviour switches via env (SHIM_*).
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/bash
echo "docker $*" >> "$SHIM_LOG"
case "$1" in
  inspect)
    case "$*" in
      *Mounts*) echo "/host/checkout"; exit 0 ;;
      *Config.Image*) echo "\${SHIM_UPDATER_HAVE:-ghcr.io/simeraycom/tugra-updater:0.2.0}"; exit 0 ;;
      *"{{.Image}}"*) echo "\$SHIM_UPDATER_RUNNING_ID"; exit 0 ;;
    esac
    n=$(grep -c 'up -d --no-deps hub-api web' "$SHIM_LOG" || true)
    if [ -n "$SHIM_UNHEALTHY_FIRST" ] && [ "$n" -lt 2 ]; then echo unhealthy; exit 0; fi
    echo healthy; exit 0 ;;
  image) [ -n "$SHIM_IMAGE_MISSING" ] && exit 1; echo "\$SHIM_UPDATER_WANT_ID"; exit 0 ;;
  run|rm) [ -n "$SHIM_RUN_FAIL" ] && [ "$1" = run ] && exit 1; exit 0 ;;
  compose)
    case "$*" in
      *pg_dump*) printf 'PGDMP-fake-dump'; exit 0 ;;
      *psql*) exit 0 ;;
      *"config --hash"*)
        f=""; prev=""; for a in "$@"; do if [ "$prev" = "-f" ]; then f="$a"; fi; prev="$a"; done
        d="$(mktemp -d)"
        awk -v d="$d" '/^services:/{s=1;next} /^[A-Za-z]/{s=0} s&&/^  [A-Za-z0-9_-]+:$/{name=$1; sub(":","",name)} s&&name{print >> (d "/" name)}' "$f"
        for n in "$d"/*; do [ -f "$n" ] && echo "$(basename "$n") $(cksum < "$n" | cut -d' ' -f1)"; done
        rm -rf "$d"; exit 0 ;;
      *"--profile updater config"*)
        if [ -n "$SHIM_UPDATER_WANT_FROM_ENV" ]; then
          envf=""; prev=""; for a in "$@"; do if [ "$prev" = "--env-file" ]; then envf="$a"; fi; prev="$a"; done
          SHIM_UPDATER_WANT="ghcr.io/simeraycom/tugra-updater:$(grep '^TUGRA_VERSION=' "$envf" | cut -d= -f2)"
        fi
        [ -n "$SHIM_UPDATER_WANT" ] && printf 'services:\n  hub-api:\n    image: ghcr.io/x/hub:1\n  tugra-updater:\n    image: %s\n    restart: unless-stopped\n  web:\n    image: ghcr.io/x/web:1\n' "$SHIM_UPDATER_WANT"
        exit 0 ;;
      *" config"*)
        f=""; prev=""; for a in "$@"; do if [ "$prev" = "-f" ]; then f="$a"; fi; prev="$a"; done
        if grep -q INVALID_COMPOSE "$f" 2>/dev/null; then echo "invalid compose" >&2; exit 1; fi
        if grep -q NEEDS_NEW_VAR "$f" 2>/dev/null; then
          if [ -n "$SHIM_PLAIN_WARN" ]; then echo 'WARN[0000] The "NEEDS_NEW_VAR" variable is not set. Defaulting to a blank string.' >&2
          else echo 'time="x" level=warning msg="The \\"NEEDS_NEW_VAR\\" variable is not set. Defaulting to a blank string."' >&2; fi
        fi
        exit 0 ;;
      *" pull tugra-updater"*) [ -n "$SHIM_UPDATER_PULL_FAIL" ] && exit 1; exit 0 ;;
      *" pull hub-api web"*)
        [ -n "$SHIM_WIPE_BACKUPS" ] && rm -rf "$SHIM_WIPE_BACKUPS"/host-files-*
        [ -n "$SHIM_PULL_FAIL" ] && exit 1; exit 0 ;;
      *" up -d --no-deps hub-api web"*)
        [ -n "$SHIM_UP_FAIL_ALWAYS" ] && exit 1
        if [ -n "$SHIM_UP_FAIL_FIRST" ] && [ "$(grep -c 'up -d --no-deps hub-api web' "$SHIM_LOG")" -lt 2 ]; then exit 1; fi
        exit 0 ;;
      *" ps -q "*) echo "cid-\${@: -1}"; exit 0 ;;
    esac ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "redis-cli"),
    `#!/bin/bash
echo "redis-cli $*" >> "$SHIM_LOG"
case "$*" in
  *"GET instance:update:updater-refreshed"*)
    # the marker as the script itself last wrote it (so a restart after a refresh sees it), else the seeded value
    v="$(grep '^redis-cli .* SET instance:update:updater-refreshed ' "$SHIM_LOG" | tail -n1 | awk '{print $NF}')"
    printf '%s\\n' "\${v:-$SHIM_REFRESHED}"; exit 0 ;;
  *BLPOP*) if [ -e "$SHIM_STATE" ]; then exit 1; fi; : > "$SHIM_STATE"; printf 'instance:update:queue\\n%s\\n' "$SHIM_JOB"; exit 0 ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  // curl: maps https://example.test/tugra/host/<rest> to $SHIM_REL/<rest>; records the URL; fails like curl --fail (22).
  writeFileSync(
    join(bin, "curl"),
    `#!/bin/bash
out=""; url=""; prev=""
for a in "$@"; do
  if [ "$prev" = "--output" ]; then out="$a"; fi
  prev="$a"; url="$a"
done
echo "curl $url" >> "$SHIM_LOG"
case "$url" in
  ${BASE_URL}/host/*) src="$SHIM_REL/\${url#${BASE_URL}/host/}" ;;
  *) exit 22 ;;
esac
[ -f "$src" ] || exit 22
cp "$src" "$out"
`,
    { mode: 0o755 },
  );
  return { dir, repo, rel, envFile, log, pub: publicKeyB64, priv, envText };
}

/** Publish release `version` into the fake server: HOSTFILES (+sig) built by the real TS module, files at their paths. */
function publish(rig: Rig, version: string, files: Record<string, string>, opts: { signWith?: Rig["priv"]; manifestText?: string } = {}): string {
  const text = opts.manifestText ?? buildHostFilesManifest(version, files);
  const sig = signDetached(opts.signWith ?? rig.priv, text);
  const base = join(rig.rel, version);
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "HOSTFILES"), text);
  writeFileSync(join(base, "HOSTFILES.sig"), sig + "\n");
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(base, p)), { recursive: true });
    writeFileSync(join(base, p), c);
  }
  return hostFilesDigest(text);
}

/** What a normal release publishes: same snapshot/hostfiles libs, a NEW compose, a NEW installer, a marked update.sh. */
function changedFiles(): Record<string, string> {
  return {
    "deploy/docker-compose.yml": NEW_COMPOSE,
    "scripts/install.sh": NEW_INSTALL,
    "scripts/update.sh": REAL_UPDATE + "\n# release marker\n",
    "scripts/lib/snapshot.sh": REAL_SNAPSHOT,
    "scripts/lib/hostfiles.sh": REAL_HOSTFILES,
    "scripts/lib/images.sh": REAL_IMAGES,
  };
}
function unchangedFiles(rig: Rig): Record<string, string> {
  const read = (p: string) => readFileSync(join(rig.repo, p), "utf8");
  return Object.fromEntries(["deploy/docker-compose.yml", "scripts/install.sh", "scripts/update.sh", "scripts/lib/snapshot.sh", "scripts/lib/hostfiles.sh", "scripts/lib/images.sh"].map((p) => [p, read(p)]));
}

function run(rig: Rig, job: Record<string, string>, env: Record<string, string> = {}, extraArgs: string[] = ["--watch"]) {
  writeFileSync(rig.log, "");
  const r = spawnSync(BASH, [join(rig.repo, "scripts", "update.sh"), ...extraArgs], {
    encoding: "utf8",
    env: {
      PATH: `${join(rig.dir, "bin")}:${process.env.PATH}`,
      ENV_FILE: rig.envFile,
      TUGRA_BACKUP_DIR: join(rig.repo, "backups"),
      SHIM_LOG: rig.log,
      SHIM_REL: rig.rel,
      SHIM_STATE: join(rig.dir, "state"),
      SHIM_JOB: JSON.stringify(job),
      UPDATE_HEALTH_TIMEOUT: "1",
      UPDATER_REFRESH_WAIT: "0",
      ...env,
    } as NodeJS.ProcessEnv,
  });
  return { r, log: readFileSync(rig.log, "utf8"), out: `${r.stdout}${r.stderr}` };
}

const read = (rig: Rig, p: string) => readFileSync(join(rig.repo, p), "utf8");
const leftovers = (rig: Rig) => readdirSync(rig.repo, { recursive: true } as never).map(String).filter((f) => /update-staging|tugra-new/.test(f) && !/staging\.(stale|fresh)/.test(f));
const statusLines = (log: string) => log.split("\n").filter((l) => l.includes("SET instance:update:status"));
const finalStatus = (log: string) => statusLines(log).pop() ?? "";
const fileCurls = (log: string) => log.split("\n").filter((l) => l.startsWith("curl ") && !/HOSTFILES/.test(l));

suite("update.sh applying a release's compose + scripts (end to end)", () => {
  it("happy path: verified files replace the checkout atomically, .env keeps every line, rollback copies are saved, status done", () => {
    const rig = makeRig();
    const digest = publish(rig, "0.2.0", changedFiles());
    const { log } = run(rig, { targetVersion: "0.2.0", hostFilesDigest: digest });

    expect(read(rig, "deploy/docker-compose.yml")).toBe(NEW_COMPOSE);
    expect(read(rig, "scripts/install.sh")).toBe(NEW_INSTALL);
    expect(read(rig, "scripts/update.sh")).toContain("# release marker");
    expect(finalStatus(log)).toContain('"phase":"done"');
    expect(log).toContain("DEL instance:update:lock");

    // ONLY the files that differ were downloaded (plus the signed manifest + signature)
    expect(fileCurls(log).map((l) => l.replace(`curl ${BASE_URL}/host/0.2.0/`, "")).sort()).toEqual(["deploy/docker-compose.yml", "scripts/install.sh", "scripts/update.sh"]);

    // .env: every operator line intact; the updater only moved TUGRA_VERSION
    const after = readFileSync(rig.envFile, "utf8").split("\n").filter(Boolean);
    const before = rig.envText.split("\n").filter(Boolean);
    expect(after.filter((l) => !l.startsWith("TUGRA_VERSION="))).toEqual(before.filter((l) => !l.startsWith("TUGRA_VERSION=")));
    expect(after).toContain("TUGRA_VERSION=0.2.0");

    // the previous copies are in a 0700 backup dir and the applied record exists
    const bk = readdirSync(join(rig.repo, "backups")).find((d) => d.startsWith("host-files-0.1.0-to-0.2.0-")) as string;
    expect(bk).toBeDefined();
    expect(statSync(join(rig.repo, "backups", bk)).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(rig.repo, "backups", bk, "files", "deploy", "docker-compose.yml"), "utf8")).toBe(OLD_COMPOSE);
    expect(readFileSync(join(rig.repo, ".tugra-host-applied"), "utf8")).toContain(`${sha256Hex(NEW_COMPOSE)}  deploy/docker-compose.yml`);
    expect(leftovers(rig)).toEqual([]); // staging dir + temp files cleaned up
    // scripts keep their executable bit
    expect(statSync(join(rig.repo, "scripts", "install.sh")).mode & 0o111).not.toBe(0);
  });

  it("order: files are applied AFTER the pre-update snapshot and BEFORE the image pull; scripts changed -> the loop reloads; compose changed -> the updater refresh helper is started", () => {
    const rig = makeRig();
    const digest = publish(rig, "0.2.0", changedFiles());
    const { log, out } = run(rig, { targetVersion: "0.2.0", hostFilesDigest: digest });
    const dump = log.indexOf("pg_dump");
    const validate = log.indexOf(" config -q");
    const pull = log.indexOf(" pull hub-api web");
    expect(dump).toBeGreaterThan(-1);
    expect(validate).toBeGreaterThan(-1);
    expect(validate).toBeLessThan(dump); // validated before anything (incl. the snapshot) happens
    expect(dump).toBeLessThan(pull);
    expect(out).toContain("scripts were updated — reloading the updater");
    // the refresh helper: one-shot container, host path of the checkout, only ever `up -d --no-deps tugra-updater`
    const runLine = log.split("\n").find((l) => l.startsWith("docker run "));
    expect(runLine).toBeDefined();
    expect(runLine).toContain("-v /host/checkout:/host/checkout");
    expect(runLine).toContain("ghcr.io/simeraycom/tugra-updater:0.2.0");
    expect(runLine).toContain("up -d --no-deps tugra-updater");
    expect(runLine).toContain("--project-directory");
    expect(log.indexOf('"phase":"done"')).toBeLessThan(log.indexOf("docker run "));
  });

  describe("updater image follows the release (image-only releases change no compose text but move the tag)", () => {
    const helperRuns = (log: string) => log.split("\n").filter((l) => l.startsWith("docker run "));
    const imageOnly = (rig: Rig) => publish(rig, "0.2.0", unchangedFiles(rig));

    it("an image-only release whose compose now names a newer updater image recreates the updater, detached and last", () => {
      const rig = makeRig();
      const digest = imageOnly(rig);
      const { log, out } = run(rig, { targetVersion: "0.2.0", hostFilesDigest: digest }, {
        SHIM_UPDATER_HAVE: "ghcr.io/simeraycom/tugra-updater:0.1.0",
        SHIM_UPDATER_WANT: "ghcr.io/simeraycom/tugra-updater:0.2.0",
        SHIM_REFRESHED: "ghcr.io/simeraycom/tugra-updater:0.2.0", // the start-up catch-up already tried; this is the post-update path
      });
      expect(finalStatus(log)).toContain('"phase":"done"');
      const runs = helperRuns(log);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toContain("-v /host/checkout:/host/checkout");
      expect(runs[0]).toContain("ghcr.io/simeraycom/tugra-updater:0.1.0"); // the helper runs on the image that is running now
      expect(runs[0]).toContain("up -d --no-deps tugra-updater");
      expect(runs[0]).not.toMatch(/hub-api|postgres|redis/);
      expect(log.indexOf('"phase":"done"')).toBeLessThan(log.indexOf("docker run ")); // after the status is final
      expect(out).toContain("updater refresh scheduled");
    });

    it("the same tag whose local image id moved (a re-pulled latest) is refreshed too", () => {
      const rig = makeRig();
      const digest = imageOnly(rig);
      const { log } = run(rig, { targetVersion: "0.2.0", hostFilesDigest: digest }, {
        SHIM_UPDATER_HAVE: "ghcr.io/simeraycom/tugra-updater:latest",
        SHIM_UPDATER_WANT: "ghcr.io/simeraycom/tugra-updater:latest",
        SHIM_UPDATER_RUNNING_ID: "sha256:old",
        SHIM_UPDATER_WANT_ID: "sha256:new",
        SHIM_REFRESHED: "ghcr.io/simeraycom/tugra-updater:latest",
      });
      expect(helperRuns(log)).toHaveLength(1);
    });

    it("an updater already on the release's image is left alone", () => {
      const rig = makeRig();
      const digest = imageOnly(rig);
      const { log } = run(rig, { targetVersion: "0.2.0", hostFilesDigest: digest }, {
        SHIM_UPDATER_HAVE: "ghcr.io/simeraycom/tugra-updater:0.2.0",
        SHIM_UPDATER_WANT: "ghcr.io/simeraycom/tugra-updater:0.2.0",
        SHIM_UPDATER_RUNNING_ID: "sha256:same",
        SHIM_UPDATER_WANT_ID: "sha256:same",
      });
      expect(finalStatus(log)).toContain('"phase":"done"');
      expect(helperRuns(log)).toEqual([]);
    });

    it("when the expected image cannot be determined nothing is restarted (and the update still completes)", () => {
      const rig = makeRig();
      const digest = imageOnly(rig);
      const { log } = run(rig, { targetVersion: "0.2.0", hostFilesDigest: digest }, { SHIM_UPDATER_HAVE: "ghcr.io/simeraycom/tugra-updater:0.1.0" });
      expect(finalStatus(log)).toContain('"phase":"done"');
      expect(helperRuns(log)).toEqual([]);
    });

    it("a failing refresh helper never fails an otherwise good update", () => {
      const rig = makeRig();
      const digest = imageOnly(rig);
      const { log, out } = run(rig, { targetVersion: "0.2.0", hostFilesDigest: digest }, {
        SHIM_UPDATER_HAVE: "ghcr.io/simeraycom/tugra-updater:0.1.0",
        SHIM_UPDATER_WANT: "ghcr.io/simeraycom/tugra-updater:0.2.0",
        SHIM_RUN_FAIL: "1",
        SHIM_REFRESHED: "ghcr.io/simeraycom/tugra-updater:0.2.0",
      });
      expect(finalStatus(log)).toContain('"phase":"done"');
      expect(out).toContain("could not start the updater refresh helper");
    });
  });

  describe("start-up catch-up (an updater left on an older image converges without an installer run)", () => {
    const stale = { SHIM_UPDATER_HAVE: "ghcr.io/simeraycom/tugra-updater:0.1.0", SHIM_UPDATER_WANT: "ghcr.io/simeraycom/tugra-updater:0.2.0" };
    const runs = (log: string) => log.split("\n").filter((l) => l.startsWith("docker run "));

    it("a stale updater is refreshed BEFORE it takes any job, and the attempt is recorded", () => {
      const rig = makeRig();
      const { log } = run(rig, {}, stale); // a job without a target is ignored: only the start-up path is exercised
      expect(runs(log)).toHaveLength(1);
      expect(runs(log)[0]).toContain("up -d --no-deps tugra-updater");
      expect(log).toContain("SET instance:update:updater-refreshed ghcr.io/simeraycom/tugra-updater:0.2.0");
      expect(log.indexOf("docker run ")).toBeLessThan(log.indexOf("BLPOP"));
    });

    it("the new image is pulled BEFORE the helper is scheduled, so the recreate is a quick local swap", () => {
      const rig = makeRig();
      const { log } = run(rig, {}, stale);
      expect(log).toMatch(/docker compose .* pull tugra-updater/);
      expect(log.indexOf("pull tugra-updater")).toBeLessThan(log.indexOf("docker run "));
      expect(log.indexOf("docker run ")).toBeLessThan(log.indexOf("BLPOP"));
    });

    it("an image that is not in the local cache (pull failed) is never recreated onto: the old updater carries on and the next start retries", () => {
      const rig = makeRig();
      const { log, out } = run(rig, {}, { ...stale, SHIM_UPDATER_PULL_FAIL: "1", SHIM_IMAGE_MISSING: "1" });
      expect(runs(log)).toEqual([]);
      expect(log).not.toContain("SET instance:update:updater-refreshed"); // no marker: a later start tries again
      expect(out).toContain("could not pull the updater image");
      expect(out).toContain("is not pulled yet");
      expect(log).toContain("BLPOP"); // and it still serves the queue
    });

    it("a post-update refresh is skipped the same way when the updater image never got pulled", () => {
      const rig = makeRig();
      const digest = publish(rig, "0.2.0", unchangedFiles(rig));
      const { log, finalLog } = (() => {
        const r = run(rig, { targetVersion: "0.2.0", hostFilesDigest: digest }, { ...stale, SHIM_IMAGE_MISSING: "1", SHIM_REFRESHED: "ghcr.io/simeraycom/tugra-updater:0.2.0" });
        return { log: r.log, finalLog: finalStatus(r.log) };
      })();
      expect(finalLog).toContain('"phase":"done"');
      expect(runs(log)).toEqual([]);
    });

    it("an update that reloads the scripts schedules ONE refresh: the re-exec'd start-up catch-up sees it as already pending", () => {
      const rig = makeRig();
      const digest = publish(rig, "0.2.0", changedFiles());
      // the updater is current when it starts (compose names the .env version) and only becomes stale once the update moves TUGRA_VERSION
      const { log } = run(rig, { targetVersion: "0.2.0", hostFilesDigest: digest }, { SHIM_UPDATER_HAVE: "ghcr.io/simeraycom/tugra-updater:0.1.0", SHIM_UPDATER_WANT_FROM_ENV: "1" });
      expect(finalStatus(log)).toContain('"phase":"done"');
      expect(log).toContain("SET instance:update:updater-refreshed ghcr.io/simeraycom/tugra-updater:0.2.0"); // the post-update schedule records itself
      expect(runs(log)).toHaveLength(1);
      expect(log.split("\n").filter((l) => l.startsWith("docker rm -f tugra-updater-refresh"))).toHaveLength(1); // the pending helper is not killed and redone
    });

    it("is attempted once per expected image: a marker for it means no second restart", () => {
      const rig = makeRig();
      const { log } = run(rig, {}, { ...stale, SHIM_REFRESHED: "ghcr.io/simeraycom/tugra-updater:0.2.0" });
      expect(runs(log)).toEqual([]);
    });

    it("an up-to-date updater is not touched at start", () => {
      const rig = makeRig();
      const { log } = run(rig, {}, { SHIM_UPDATER_HAVE: "ghcr.io/simeraycom/tugra-updater:0.2.0", SHIM_UPDATER_WANT: "ghcr.io/simeraycom/tugra-updater:0.2.0", SHIM_UPDATER_RUNNING_ID: "a", SHIM_UPDATER_WANT_ID: "a" });
      expect(runs(log)).toEqual([]);
      expect(log).not.toContain("updater-refreshed");
    });
  });

  it("FAST PATH: a checkout that already matches the release downloads no file, applies nothing, starts no helper", () => {
    const rig = makeRig();
    const digest = publish(rig, "0.2.0", unchangedFiles(rig));
    const before = { compose: read(rig, "deploy/docker-compose.yml"), install: read(rig, "scripts/install.sh") };
    const { log, out } = run(rig, { targetVersion: "0.2.0", hostFilesDigest: digest });
    expect(finalStatus(log)).toContain('"phase":"done"');
    expect(fileCurls(log)).toEqual([]);
    expect(log.split("\n").filter((l) => l.startsWith("curl ")).length).toBe(2); // HOSTFILES + HOSTFILES.sig only
    expect(read(rig, "deploy/docker-compose.yml")).toBe(before.compose);
    expect(read(rig, "scripts/install.sh")).toBe(before.install);
    expect(existsSync(join(rig.repo, ".tugra-host-applied"))).toBe(false);
    expect(readdirSync(join(rig.repo, "backups")).some((d) => d.startsWith("host-files-"))).toBe(false);
    expect(log).not.toContain("docker run ");
    expect(out).not.toContain("scripts were updated");
    expect(log).not.toContain(" config -q"); // nothing changed, nothing to validate
    expect(leftovers(rig)).toEqual([]);
  });

  it("a job with no hostFilesDigest (older release) is the legacy images-only update: no network, no file touched", () => {
    const rig = makeRig();
    const { log } = run(rig, { targetVersion: "0.2.0" });
    expect(finalStatus(log)).toContain('"phase":"done"');
    expect(log).not.toContain("curl ");
    expect(read(rig, "deploy/docker-compose.yml")).toBe(OLD_COMPOSE);
  });

  describe("verification failures abort with NOTHING changed (no snapshot, no pull, lock released)", () => {
    const expectRefused = (rig: Rig, log: string, why: RegExp) => {
      expect(finalStatus(log)).toMatch(/"phase":"failed"/);
      expect(finalStatus(log)).toMatch(why);
      expect(finalStatus(log)).toContain("nothing was changed");
      expect(log).toContain("DEL instance:update:lock");
      expect(log).not.toContain("pg_dump");
      expect(log).not.toMatch(/ pull hub-api web/);
      expect(read(rig, "deploy/docker-compose.yml")).toBe(OLD_COMPOSE);
      expect(read(rig, "scripts/install.sh")).toBe(OLD_INSTALL);
      expect(readFileSync(rig.envFile, "utf8")).toBe(rig.envText); // .env byte-for-byte
      expect(existsSync(join(rig.repo, ".tugra-host-applied"))).toBe(false);
      expect(leftovers(rig)).toEqual([]);
    };

    it("a manifest signed by a DIFFERENT key", () => {
      const rig = makeRig();
      const digest = publish(rig, "0.2.0", changedFiles(), { signWith: keypair().priv });
      const { log } = run(rig, { targetVersion: "0.2.0", hostFilesDigest: digest });
      expectRefused(rig, log, /signature verification failed/);
    });

    it("a tampered manifest (bytes changed after signing)", () => {
      const rig = makeRig();
      const digest = publish(rig, "0.2.0", changedFiles());
      const p = join(rig.rel, "0.2.0", "HOSTFILES");
      writeFileSync(p, readFileSync(p, "utf8").replace(sha256Hex(NEW_INSTALL), "0".repeat(64)));
      const { log } = run(rig, { targetVersion: "0.2.0", hostFilesDigest: digest });
      expectRefused(rig, log, /signature verification failed/);
    });

    it("a garbage / missing signature", () => {
      const rig = makeRig();
      const digest = publish(rig, "0.2.0", changedFiles());
      writeFileSync(join(rig.rel, "0.2.0", "HOSTFILES.sig"), "not-a-signature\n");
      expectRefused(rig, run(rig, { targetVersion: "0.2.0", hostFilesDigest: digest }).log, /signature verification failed/);
      rmSync(join(rig.rel, "0.2.0", "HOSTFILES.sig"));
      expectRefused(rig, run(rig, { targetVersion: "0.2.0", hostFilesDigest: digest }, { SHIM_STATE: join(rig.dir, "state2") }).log, /could not download/);
    });

    it("a file whose bytes do not match its signed hash", () => {
      const rig = makeRig();
      const digest = publish(rig, "0.2.0", changedFiles());
      writeFileSync(join(rig.rel, "0.2.0", "deploy", "docker-compose.yml"), NEW_COMPOSE + "  evil:\n    privileged: true\n");
      const { log } = run(rig, { targetVersion: "0.2.0", hostFilesDigest: digest });
      expectRefused(rig, log, /deploy\/docker-compose\.yml does not match its signed hash/);
    });

    it("a validly signed manifest that is NOT the one the signed versions.json committed to (digest mismatch)", () => {
      const rig = makeRig();
      publish(rig, "0.2.0", changedFiles());
      const { log } = run(rig, { targetVersion: "0.2.0", hostFilesDigest: "d".repeat(64) });
      expectRefused(rig, log, /does not match the digest in the signed release manifest/);
    });

    it("replay: a validly signed manifest of ANOTHER version served for this one", () => {
      const rig = makeRig();
      const files = changedFiles();
      const oldText = buildHostFilesManifest("0.1.5", files);
      const digest = publish(rig, "0.2.0", files, { manifestText: oldText }); // signed, digest-consistent, wrong version line
      const { log } = run(rig, { targetVersion: "0.2.0", hostFilesDigest: digest });
      expectRefused(rig, log, /manifest is malformed/);
    });

    it("a signed manifest listing a path outside compose/scripts (traversal, .env, absolute) is refused", () => {
      for (const evil of ["scripts/../.env", ".env", "/etc/cron.d/x", "deploy/Dockerfile.hub", "scripts/sub/x.sh"]) {
        const rig = makeRig();
        const text = `${HOST_FILES_HEADER}\nversion 0.2.0\n${sha256Hex("x")}  ${evil}\n`;
        const digest = publish(rig, "0.2.0", changedFiles(), { manifestText: text });
        const { log } = run(rig, { targetVersion: "0.2.0", hostFilesDigest: digest });
        expectRefused(rig, log, /manifest is malformed/);
      }
    });

    it("unsorted / duplicate / uppercase-hex / missing-newline manifests are refused", () => {
      const h = sha256Hex("x");
      const bad = [
        `${HOST_FILES_HEADER}\nversion 0.2.0\n${h}  scripts/b.sh\n${h}  scripts/a.sh\n`,
        `${HOST_FILES_HEADER}\nversion 0.2.0\n${h}  scripts/a.sh\n${h}  scripts/a.sh\n`,
        `${HOST_FILES_HEADER}\nversion 0.2.0\n${h.toUpperCase()}  scripts/a.sh\n`,
        `${HOST_FILES_HEADER}\nversion 0.2.0\n${h}  scripts/a.sh`,
      ];
      for (const text of bad) {
        const rig = makeRig();
        const digest = publish(rig, "0.2.0", changedFiles(), { manifestText: text });
        expectRefused(rig, run(rig, { targetVersion: "0.2.0", hostFilesDigest: digest }).log, /manifest is malformed/);
      }
    });

    it("a release script that is not valid shell never reaches the checkout", () => {
      const rig = makeRig();
      const files = { ...changedFiles(), "scripts/install.sh": "#!/usr/bin/env bash\nif then fi (\n" };
      const digest = publish(rig, "0.2.0", files);
      const { log } = run(rig, { targetVersion: "0.2.0", hostFilesDigest: digest });
      expectRefused(rig, log, /scripts\/install\.sh from the release is not valid shell/);
    });

    it("a compose file docker rejects, or one needing a setting .env cannot satisfy, is refused (and says to run the installer)", () => {
      const rig = makeRig();
      let files = { ...changedFiles(), "deploy/docker-compose.yml": NEW_COMPOSE + "# INVALID_COMPOSE\n" };
      let digest = publish(rig, "0.2.0", files);
      expectRefused(rig, run(rig, { targetVersion: "0.2.0", hostFilesDigest: digest }).log, /compose file is not valid for this installation/);

      files = { ...changedFiles(), "deploy/docker-compose.yml": NEW_COMPOSE + "# uses ${NEEDS_NEW_VAR}\n" };
      digest = publish(rig, "0.2.0", files);
      // compose prints the warning in two shapes (plain text, or logfmt with escaped quotes): both must be caught
      ["", "1"].forEach((plain, i) => {
        const { log } = run(rig, { targetVersion: "0.2.0", hostFilesDigest: digest }, { SHIM_STATE: join(rig.dir, `state-v${i}`), SHIM_PLAIN_WARN: plain });
        expectRefused(rig, log, /needs new settings that \.env does not define \(NEEDS_NEW_VAR\).*git pull && \.\/scripts\/install\.sh/);
      });
    });

    it("a compose change to a service the updater does not recreate (or a new service) is refused with nothing changed", () => {
      const rig = makeRig();
      const cases: [string, RegExp][] = [
        [NEW_COMPOSE + "  redis:\n    image: redis:7\n", /changes services the in-app updater does not recreate \(redis\).*install\.sh/],
        [NEW_COMPOSE.replace("services:\n", "services:\n  postgres:\n    image: postgres:17\n"), /does not recreate \(postgres\)/],
      ];
      cases.forEach(([compose, why], i) => {
        const digest = publish(rig, "0.2.0", { ...changedFiles(), "deploy/docker-compose.yml": compose });
        const { log } = run(rig, { targetVersion: "0.2.0", hostFilesDigest: digest }, { SHIM_STATE: join(rig.dir, `state-svc${i}`) });
        expectRefused(rig, log, why);
      });
    });

    it("a compose change confined to hub-api, web, agent and the updater is applied", () => {
      const rig = makeRig();
      const compose = NEW_COMPOSE.replace("tugra-web:", "tugra-web-x:") + "  agent:\n    image: a\n  tugra-updater:\n    image: u\n";
      const digest = publish(rig, "0.2.0", { ...changedFiles(), "deploy/docker-compose.yml": compose });
      const { log } = run(rig, { targetVersion: "0.2.0", hostFilesDigest: digest });
      expect(finalStatus(log)).toContain('"phase":"done"');
      expect(read(rig, "deploy/docker-compose.yml")).toBe(compose);
    });

    it("TUGRA_UPDATE_CHECKS=0 is a HARD OFF: nothing is fetched, the update is refused", () => {
      const rig = makeRig(["TUGRA_UPDATE_CHECKS=0"]);
      const digest = publish(rig, "0.2.0", changedFiles());
      const { log } = run(rig, { targetVersion: "0.2.0", hostFilesDigest: digest });
      expect(log).not.toContain("curl ");
      expectRefused(rig, log, /update checks are disabled \(TUGRA_UPDATE_CHECKS=0\)/);
    });

    it("TUGRA_UPDATE_CHECKS=\"0\" (quoted, as docker compose reads it) is a hard off too", () => {
      const rig = makeRig(['TUGRA_UPDATE_CHECKS="0"']);
      const digest = publish(rig, "0.2.0", changedFiles());
      const { log } = run(rig, { targetVersion: "0.2.0", hostFilesDigest: digest });
      expect(log).not.toContain("curl ");
      expectRefused(rig, log, /update checks are disabled/);
    });

    it("the shipped .env.example blanks (UPDATE_MANIFEST_URL=\"\" and UPDATE_PUBLISHER_KEY=\"\") mean unset: the official source is used, not a refusal", () => {
      const rig = makeRig();
      const text = readFileSync(rig.envFile, "utf8").split("\n").filter((l) => !/^UPDATE_(MANIFEST_URL|PUBLISHER_KEY)=/.test(l));
      writeFileSync(rig.envFile, [...text, 'UPDATE_MANIFEST_URL=""', "UPDATE_PUBLISHER_KEY=''"].join("\n") + "\n");
      rig.envText = readFileSync(rig.envFile, "utf8");
      const digest = publish(rig, "0.2.0", changedFiles());
      const { log } = run(rig, { targetVersion: "0.2.0", hostFilesDigest: digest });
      expect(log).toContain("curl https://simeraycom.github.io/tugra/host/0.2.0/HOSTFILES"); // the official source was tried
      expect(finalStatus(log)).not.toMatch(/set UPDATE_MANIFEST_URL/);
    });

    it("a quoted URL and key (\"...\") in .env work exactly like unquoted ones", () => {
      const rig = makeRig();
      const text = readFileSync(rig.envFile, "utf8").split("\n").filter((l) => !/^UPDATE_(MANIFEST_URL|PUBLISHER_KEY)=/.test(l));
      writeFileSync(rig.envFile, [...text, `UPDATE_MANIFEST_URL="${BASE_URL}/versions.json"`, `UPDATE_PUBLISHER_KEY='${rig.pub}'`].join("\r\n") + "\r\n");
      const digest = publish(rig, "0.2.0", changedFiles());
      const { log } = run(rig, { targetVersion: "0.2.0", hostFilesDigest: digest });
      expect(finalStatus(log)).toContain('"phase":"done"');
      expect(read(rig, "deploy/docker-compose.yml")).toBe(NEW_COMPOSE);
    });

    it("a half-configured source (URL without key) or a non-https URL never fetches", () => {
      for (const env of [["UPDATE_MANIFEST_URL=http://example.test/tugra/versions.json"], ["UPDATE_PUBLISHER_KEY="]]) {
        const rig = makeRig();
        const text = readFileSync(rig.envFile, "utf8").split("\n").filter((l) => !/^UPDATE_(MANIFEST_URL|PUBLISHER_KEY)=/.test(l));
        if (env[0].startsWith("UPDATE_MANIFEST_URL")) text.push(env[0], `UPDATE_PUBLISHER_KEY=${rig.pub}`);
        else text.push(`UPDATE_MANIFEST_URL=${BASE_URL}/versions.json`);
        writeFileSync(rig.envFile, text.join("\n") + "\n");
        rig.envText = readFileSync(rig.envFile, "utf8");
        const digest = publish(rig, "0.2.0", changedFiles());
        const { log } = run(rig, { targetVersion: "0.2.0", hostFilesDigest: digest });
        expect(log).not.toContain("curl ");
        expectRefused(rig, log, /cannot fetch the release's compose\/scripts/);
      }
    });

    it("a malformed hostFilesDigest in the job is refused without any network access", () => {
      const rig = makeRig();
      publish(rig, "0.2.0", changedFiles());
      const { log } = run(rig, { targetVersion: "0.2.0", hostFilesDigest: "not-hex" });
      expect(log).not.toContain("curl ");
      expectRefused(rig, log, /invalid host files digest/);
    });
  });

  describe("rollback restores the previous compose + scripts when a LATER step fails", () => {
    const expectRestored = (rig: Rig) => {
      expect(read(rig, "deploy/docker-compose.yml")).toBe(OLD_COMPOSE);
      expect(read(rig, "scripts/install.sh")).toBe(OLD_INSTALL);
      expect(read(rig, "scripts/update.sh")).toBe(REAL_UPDATE);
      expect(existsSync(join(rig.repo, ".tugra-host-applied"))).toBe(false); // the apply record is rolled back too
      expect(leftovers(rig)).toEqual([]);
      expect(statSync(join(rig.repo, "scripts", "install.sh")).mode & 0o111).not.toBe(0);
    };
    const go = (env: Record<string, string>) => {
      const rig = makeRig();
      const digest = publish(rig, "0.2.0", changedFiles());
      const res = run(rig, { targetVersion: "0.2.0", hostFilesDigest: digest }, env);
      return { rig, ...res };
    };

    it("image pull fails -> .env AND compose/scripts restored, status failed, no helper, no reload", () => {
      const { rig, log, out } = go({ SHIM_PULL_FAIL: "1" });
      expect(finalStatus(log)).toMatch(/"phase":"failed".*image pull failed/);
      expectRestored(rig);
      // the version is put back and every line is identical (set_env re-appends the key, so compare ignoring order)
      expect(readFileSync(rig.envFile, "utf8").split("\n").sort()).toEqual(rig.envText.split("\n").sort());
      expect(log).not.toContain("docker run ");
      expect(out).not.toContain("scripts were updated");
      expect(out).toContain("host files: restored the previous compose/scripts");
      expect(log).toContain("DEL instance:update:lock");
    });

    it("recreate fails -> previous compose is put back BEFORE the previous version is recreated from it, and verified", () => {
      const { rig, log, out } = go({ SHIM_UP_FAIL_FIRST: "1" });
      expect(finalStatus(log)).toMatch(/"phase":"failed".*recreate failed; restored 0\.1\.0/);
      expectRestored(rig);
      const ups = log.split("\n").filter((l) => l.includes("up -d --no-deps hub-api web"));
      expect(ups.length).toBe(2); // the failed update, then the recovery
      expect(out).toContain("host files: restored the previous compose/scripts");
      // the previous compose is back on disk BEFORE the recovery recreate starts
      expect(out.indexOf("host files: restored")).toBeGreaterThan(-1);
      expect(out.indexOf("host files: restored")).toBeLessThan(out.indexOf("restoring previous version 0.1.0"));
      expect(log).not.toContain("docker run ");
    });

    it("health check fails -> restored + verified healthy on the old compose; failed (not recovery_required)", () => {
      const { rig, log } = go({ SHIM_UNHEALTHY_FIRST: "1" });
      expect(finalStatus(log)).toMatch(/"phase":"failed".*failed health check; restored 0\.1\.0 and verified healthy/);
      expectRestored(rig);
      expect(finalStatus(log)).toContain("replaced compose/scripts saved in:");
    });

    it("PRE_UPDATE_KEEP=0 never prunes the backup of the update in flight: a failed pull still restores the files", () => {
      const rig = makeRig(["PRE_UPDATE_KEEP=0"]);
      const digest = publish(rig, "0.2.0", changedFiles());
      const { log } = run(rig, { targetVersion: "0.2.0", hostFilesDigest: digest }, { SHIM_PULL_FAIL: "1" });
      expect(finalStatus(log)).toMatch(/"phase":"failed".*image pull failed/);
      expect(finalStatus(log)).not.toContain("could NOT be restored");
      expectRestored(rig);
    });

    it("a missing backup (cleaned while the update ran) is a FAILED restore, never a silent success", () => {
      const rig = makeRig();
      const digest = publish(rig, "0.2.0", changedFiles());
      const { log, out } = run(rig, { targetVersion: "0.2.0", hostFilesDigest: digest }, { SHIM_PULL_FAIL: "1", SHIM_WIPE_BACKUPS: join(rig.repo, "backups") });
      expect(out).not.toContain("host files: restored the previous compose/scripts");
      expect(out).toContain("is missing or unreadable");
      expect(finalStatus(log)).toContain("compose/scripts could NOT be restored");
    });

    it("a missing backup during the health-check recovery makes the status recovery_required, not 'verified healthy'", () => {
      const rig = makeRig();
      const digest = publish(rig, "0.2.0", changedFiles());
      const { log } = run(rig, { targetVersion: "0.2.0", hostFilesDigest: digest }, { SHIM_UNHEALTHY_FIRST: "1", SHIM_WIPE_BACKUPS: join(rig.repo, "backups") });
      // the wipe happens at the pull, i.e. before the failing health check
      expect(finalStatus(log)).toContain('"phase":"recovery_required"');
      expect(finalStatus(log)).not.toContain("verified healthy");
    });

    it("recovery itself fails -> recovery_required, and the status says where the previous compose/scripts are", () => {
      const { rig, log } = go({ SHIM_UP_FAIL_ALWAYS: "1" });
      expect(finalStatus(log)).toContain('"phase":"recovery_required"');
      expectRestored(rig); // the files are back even though the containers could not be recreated
      expect(finalStatus(log)).toContain("host-files-0.1.0-to-0.2.0-");
    });
  });

  describe("--dry-run", () => {
    it("fetches + verifies but changes nothing in the checkout, printing what it would replace", () => {
      const rig = makeRig();
      const digest = publish(rig, "0.2.0", changedFiles());
      const { out, log } = run(rig, { targetVersion: "0.2.0", hostFilesDigest: digest }, {}, ["--dry-run", "--job", JSON.stringify({ targetVersion: "0.2.0", hostFilesDigest: digest })]);
      expect(out).toContain("HOSTFILES: would replace deploy/docker-compose.yml scripts/install.sh scripts/update.sh");
      expect(read(rig, "deploy/docker-compose.yml")).toBe(OLD_COMPOSE);
      expect(read(rig, "scripts/install.sh")).toBe(OLD_INSTALL);
      expect(readFileSync(rig.envFile, "utf8")).toBe(rig.envText);
      expect(log).toContain("curl ");
      expect(leftovers(rig)).toEqual([]);
      expect(out).toContain("refresh tugra-updater via a one-shot helper container");
    });

    it("a bad signature is refused in a dry run too", () => {
      const rig = makeRig();
      const digest = publish(rig, "0.2.0", changedFiles(), { signWith: keypair().priv });
      const { out } = run(rig, {}, {}, ["--dry-run", "--job", JSON.stringify({ targetVersion: "0.2.0", hostFilesDigest: digest })]);
      expect(out).toContain("signature verification failed");
      expect(out).toContain('"phase":"failed"');
    });
  });

  it("hf_verify_sig accepts only a genuine ed25519 key + a 64-byte signature (wrong key kind, short sig, junk all fail)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hf-sig-"));
    dirs.push(dir);
    const { priv, publicKeyB64 } = keypair();
    writeFileSync(join(dir, "m"), "payload\n");
    writeFileSync(join(dir, "good.sig"), signDetached(priv, "payload\n") + "\n");
    writeFileSync(join(dir, "short.sig"), Buffer.alloc(32, 1).toString("base64"));
    writeFileSync(join(dir, "junk.sig"), "%%%not base64%%%");
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const verify = (sig: string, key: string) =>
      spawnSync(BASH, ["-c", `. "${join(SCRIPTS, "lib", "hostfiles.sh")}"; hf_verify_sig "${join(dir, "m")}" "${join(dir, sig)}" "${key}"`], { encoding: "utf8" }).status;
    expect(verify("good.sig", publicKeyB64)).toBe(0);
    expect(verify("good.sig", rsa)).not.toBe(0); // not an ed25519 SubjectPublicKeyInfo
    expect(verify("good.sig", publicKeyB64.slice(0, -4))).not.toBe(0); // truncated key
    expect(verify("good.sig", keypair().publicKeyB64)).not.toBe(0); // someone else's key
    expect(verify("short.sig", publicKeyB64)).not.toBe(0);
    expect(verify("junk.sig", publicKeyB64)).not.toBe(0);
  });

  it("a stale staging dir from a killed job is swept at the next job; a fresh one is left alone", () => {
    const rig = makeRig();
    const digest = publish(rig, "0.2.0", unchangedFiles(rig));
    mkdirSync(join(rig.repo, ".update-staging.stale1"));
    mkdirSync(join(rig.repo, ".update-staging.fresh1"));
    const old = new Date(Date.now() - 2 * 3600_000);
    utimesSync(join(rig.repo, ".update-staging.stale1"), old, old);
    run(rig, { targetVersion: "0.2.0", hostFilesDigest: digest });
    expect(existsSync(join(rig.repo, ".update-staging.stale1"))).toBe(false);
    expect(existsSync(join(rig.repo, ".update-staging.fresh1"))).toBe(true);
  });

  it("the sidecar never lets the hub or Redis supply file CONTENT: the job only carries a digest, and every byte is fetched + verified here", () => {
    const sh = REAL_UPDATE + REAL_HOSTFILES;
    expect(REAL_UPDATE).toContain('host="$(job_field "$job" hostFilesDigest)"');
    expect(REAL_HOSTFILES).toContain("hf_verify_sig");
    expect(sh).not.toMatch(/redis-cli[^\n]*(GET|LRANGE|HGET)/); // no content is ever read back from Redis
  });

  it("the only way the updater container is (re)created is the one-shot refresh helper; hub-api/web/agent behaviour is unchanged", () => {
    const upLines = REAL_UPDATE.split("\n").filter((l) => /up -d/.test(l) && !l.trim().startsWith("#"));
    for (const l of upLines) expect(l).toMatch(/--no-deps (hub-api web|agent|tugra-updater)\b/);
    expect(upLines.filter((l) => /tugra-updater/.test(l)).length).toBe(1); // inside the helper's `docker run -c '…'`
    expect(REAL_UPDATE).toContain("docker run -d --rm --name tugra-updater-refresh");
  });
});

describe("hostfiles.sh syntax", () => {
  it("is valid bash and update.sh still parses with it", () => {
    expect(() => execFileSync(BASH, ["-n", join(SCRIPTS, "lib", "hostfiles.sh")], { stdio: "pipe" })).not.toThrow();
    expect(() => execFileSync(BASH, ["-n", join(SCRIPTS, "update.sh")], { stdio: "pipe" })).not.toThrow();
  });
});

suite("update.sh --apply-host-files (the hub's bootstrap for a checkout that predates in-app host files)", () => {
  // The bootstrap runs the updater IMAGE's baked copy of the scripts (/opt/tugra/scripts) against the operator's checkout
  // (TUGRA_REPO_DIR), with the stack already on the release: no pull, no recreate, only the signed files change.
  function applyRun(rig: Rig, version: string, digest: string, env: Record<string, string> = {}) {
    const image = join(rig.dir, "image", "scripts");
    mkdirSync(join(image, "lib"), { recursive: true });
    writeFileSync(join(image, "update.sh"), REAL_UPDATE, { mode: 0o755 });
    for (const [n, c] of [["snapshot.sh", REAL_SNAPSHOT], ["hostfiles.sh", REAL_HOSTFILES], ["images.sh", REAL_IMAGES]] as const) writeFileSync(join(image, "lib", n), c, { mode: 0o755 });
    writeFileSync(rig.log, "");
    const r = spawnSync(BASH, [join(image, "update.sh"), "--apply-host-files", version, digest], {
      encoding: "utf8",
      env: { PATH: `${join(rig.dir, "bin")}:${process.env.PATH}`, ENV_FILE: rig.envFile, TUGRA_REPO_DIR: rig.repo, SHIM_LOG: rig.log, SHIM_REL: rig.rel, ...env } as NodeJS.ProcessEnv,
    });
    return { r, log: readFileSync(rig.log, "utf8"), out: `${r.stdout}${r.stderr}`, image };
  }
  const onRelease = (rig: Rig, v: string) => writeFileSync(rig.envFile, rig.envText.replace("TUGRA_VERSION=0.1.0", `TUGRA_VERSION=${v}`));

  it("brings the checkout (not the image copy) to the release: signed files replaced with a backup, .env untouched, nothing pulled or recreated", () => {
    const rig = makeRig();
    onRelease(rig, "0.2.0");
    const envBefore = readFileSync(rig.envFile, "utf8");
    const digest = publish(rig, "0.2.0", changedFiles());
    const { r, log, out, image } = applyRun(rig, "0.2.0", digest);
    expect(r.status).toBe(0);
    expect(out).toContain("3 file(s) brought to release 0.2.0");
    expect(read(rig, "deploy/docker-compose.yml")).toBe(NEW_COMPOSE);
    expect(read(rig, "scripts/install.sh")).toBe(NEW_INSTALL);
    expect(read(rig, "scripts/update.sh")).toContain("# release marker");
    expect(readFileSync(join(image, "update.sh"), "utf8")).toBe(REAL_UPDATE); // the image's own copy is never rewritten
    expect(readFileSync(rig.envFile, "utf8")).toBe(envBefore);
    expect(readdirSync(join(rig.repo, "backups")).some((d) => d.startsWith("host-files-0.2.0-to-0.2.0-"))).toBe(true);
    expect(log).not.toMatch(/docker pull|compose pull|up -d|docker (stop|restart|rm)/);
    expect(log).not.toContain("redis-cli"); // no queue, no status, no lock: it is not an update job
    expect(leftovers(rig)).toEqual([]);
  });

  it("already current: exits 0 and changes nothing", () => {
    const rig = makeRig();
    onRelease(rig, "0.2.0");
    const digest = publish(rig, "0.2.0", unchangedFiles(rig));
    const { r, out } = applyRun(rig, "0.2.0", digest);
    expect(r.status).toBe(0);
    expect(out).toContain("already match release 0.2.0");
    expect(read(rig, "deploy/docker-compose.yml")).toBe(OLD_COMPOSE);
  });

  it("refuses when the stack does not run that release (it only syncs files to the RUNNING release)", () => {
    const rig = makeRig(); // TUGRA_VERSION=0.1.0
    const digest = publish(rig, "0.2.0", changedFiles());
    const { r, out } = applyRun(rig, "0.2.0", digest);
    expect(r.status).toBe(1);
    expect(out).toContain("not 0.2.0");
    expect(read(rig, "deploy/docker-compose.yml")).toBe(OLD_COMPOSE);
  });

  it("a manifest signed by another key, or a digest that does not match, is refused with the checkout untouched", () => {
    const rig = makeRig();
    onRelease(rig, "0.2.0");
    const digest = publish(rig, "0.2.0", changedFiles(), { signWith: keypair().priv });
    const bad = applyRun(rig, "0.2.0", digest);
    expect(bad.r.status).toBe(1);
    expect(bad.out).toContain("signature verification failed");
    const rig2 = makeRig();
    onRelease(rig2, "0.2.0");
    publish(rig2, "0.2.0", changedFiles());
    const wrong = applyRun(rig2, "0.2.0", "0".repeat(64));
    expect(wrong.r.status).toBe(1);
    expect(wrong.out).toContain("does not match the digest");
    for (const g of [rig, rig2]) expect(read(g, "deploy/docker-compose.yml")).toBe(OLD_COMPOSE);
  });

  it("bad arguments exit non-zero before touching anything", () => {
    const rig = makeRig();
    onRelease(rig, "0.2.0");
    expect(applyRun(rig, "0.2.0", "nothex").r.status).toBe(2);
    expect(applyRun(rig, "bad version", "a".repeat(64)).r.status).toBe(2);
  });
});
