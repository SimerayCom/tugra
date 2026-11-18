import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The atomic in-app update (scripts/update.sh + lib/images.sh): a disk preflight BEFORE anything is written, images
 * pulled and verified BEFORE .env is touched, a half-finished update (.env ahead of what runs) resumed or repaired, and a
 * .env write that cannot leave a half-written file. Runner-independent: update.sh runs under bash against a throwaway
 * checkout; docker / redis-cli / df / mktemp are POSIX-sh PATH shims (they also run under dash), no global git config, no
 * host files are read.
 */
const SCRIPTS = join(__dirname, "..", "..", "..", "..", "scripts");
const BASH = execFileSync("sh", ["-c", "command -v bash"]).toString().trim();
const REAL_DF = execFileSync("sh", ["-c", "command -v df"]).toString().trim();
const REAL_MKTEMP = execFileSync("sh", ["-c", "command -v mktemp"]).toString().trim();

const HUB = "ghcr.io/simeraycom/tugra-hub";
const WEB = "ghcr.io/simeraycom/tugra-web";
const AGENT = "ghcr.io/simeraycom/tugra-agent";
const UPDATER = "ghcr.io/simeraycom/tugra-updater";
const SRC = "https://github.com/SimerayCom/tugra";
const GiB = 1024 ** 3;
const kb = (bytes: number): number => Math.floor(bytes / 1024);

// ID|REPO|TAG|DIGEST|VERSION|SOURCE|TITLE|SIZE|INUSE
const img = (id: string, repo: string, tag: string, ver: string, size: number, title: string, inuse = 0): string =>
  [id, repo, tag, "<none>", ver, SRC, title, String(size), String(inuse)].join("|");
/** The four release images of one version (hub 4 GiB, web 4 GiB, agent + updater 0.5 GiB: 9 GiB in all). */
const release = (ver: string, inuse = 0): string[] => [
  img(`sha256:hub${ver}`, HUB, ver, ver, 4 * GiB, "Tugra Hub API", inuse),
  img(`sha256:web${ver}`, WEB, ver, ver, 4 * GiB, "Tugra Web", inuse),
  img(`sha256:agent${ver}`, AGENT, ver, ver, GiB / 2, "Tugra Agent", inuse),
  img(`sha256:upd${ver}`, UPDATER, ver, ver, GiB / 2, "Tugra Updater", inuse),
];

/** docker as a POSIX-sh shim over a state dir ($SHIM_DIR): an image table, the running hub/web versions, free space. */
const DOCKER_SHIM = `#!/bin/sh
printf '%s\\n' "docker $*" >> "$SHIM_LOG"
D="$SHIM_DIR"
T="$D/images"
env_val() { grep "^$2=" "$1" 2>/dev/null | head -n1 | cut -d= -f2-; }
resolve() {
  awk -F'|' -v r="$1" '$1==r || ($2!="<none>" && $3!="<none>" && $2":"$3==r) || ($2!="<none>" && $4!="<none>" && $2"@"$4==r) {print $1; exit}' "$T"
}
case "$1" in
  info) case "$*" in
          *DriverStatus*) if [ -n "$SHIM_CONTAINERD" ]; then echo "[[driver-type io.containerd.snapshotter.v1]]"; else echo "[[Backing Filesystem extfs]]"; fi ;;
          *) echo "$SHIM_ROOT" ;;
        esac
        exit 0 ;;
  image)
    case "$2" in
      ls) case "$*" in *" -q"*) awk -F'|' '{print $1}' "$T" ;; *) awk -F'|' '{print $1"|"$2"|"$3"|"$4}' "$T" ;; esac; exit 0 ;;
      inspect)
        shift 2; fmt=""; if [ "$1" = "-f" ]; then fmt="$2"; shift 2; fi
        id="$(resolve "$1")"; [ -n "$id" ] || exit 1
        case "$fmt" in
          *"{{.Size}}"*) awk -F'|' -v i="$id" '$1==i{print $8; exit}' "$T" ;;
          *"{{.Id}}"*) echo "$id" ;;
          *"image.source"*) awk -F'|' -v i="$id" '$1==i{print $5"|"$6"|"$7; exit}' "$T" ;;
          *"image.version"*) if [ -n "$SHIM_LABEL" ]; then echo "$SHIM_LABEL"; else awk -F'|' -v i="$id" '$1==i{print $5; exit}' "$T"; fi ;;
        esac
        exit 0 ;;
    esac ;;
  inspect)
    shift; fmt=""; if [ "$1" = "-f" ]; then fmt="$2"; shift 2; fi
    case "$fmt" in
      *Labels*) case "$1" in cid-hub-api) cat "$D/run_hub" ;; cid-web) cat "$D/run_web" ;; esac ;;
      *Config.Image*) # a container created from a digest pin carries repo:tag@sha256:<hex> (files run_hub_pin / run_web_pin)
        case "$1" in
          cid-hub-api) echo "ghcr.io/simeraycom/tugra-hub:$(cat "$D/run_hub")$([ -s "$D/run_hub_pin" ] && echo "@sha256:$(cat "$D/run_hub_pin")")" ;;
          cid-web) echo "ghcr.io/simeraycom/tugra-web:$(cat "$D/run_web")$([ -s "$D/run_web_pin" ] && echo "@sha256:$(cat "$D/run_web_pin")")" ;;
        esac ;;
      *"{{.Image}}"*) echo "sha256:updater-image" ;;
      *) echo healthy ;;
    esac
    exit 0 ;;
  rmi)
    id="$(resolve "$2")"; [ -n "$id" ] || { echo "No such image: $2" >&2; exit 1; }
    inuse="$(awk -F'|' -v i="$id" '$1==i{print $9; exit}' "$T")"
    [ "$inuse" = "1" ] && { echo "conflict: image is being used by a container" >&2; exit 1; }
    size="$(awk -F'|' -v i="$id" '$1==i{print $8; exit}' "$T")"
    awk -F'|' -v i="$id" '$1!=i' "$T" > "$T.n" && mv "$T.n" "$T"
    echo $(( $(cat "$D/avail_kb") + size / 1024 )) > "$D/avail_kb"
    exit 0 ;;
  run)
    printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\nfs 0 0 %s 0%% /tugra-df-probe\\n' "$(cat "$D/avail_kb")"
    exit 0 ;;
  pull|tag) exit 0 ;;
  compose)
    shift; envf=""
    while [ $# -gt 0 ]; do case "$1" in --env-file) envf="$2"; shift 2 ;; -f|--profile) shift 2 ;; *) break ;; esac; done
    sub="$1"; shift
    case "$sub" in
      pull)
        ver="$(env_val "$envf" TUGRA_VERSION)"
        printf '%s\\n' "pull-env TUGRA_VERSION=$ver HUB_DIGEST=$(env_val "$envf" TUGRA_HUB_DIGEST) file=$envf" >> "$D/pulls"
        if [ -n "$SHIM_PULL_FAIL" ]; then echo "$SHIM_PULL_FAIL" >&2; exit 1; fi
        hd="$(env_val "$envf" TUGRA_HUB_DIGEST)"; wd="$(env_val "$envf" TUGRA_WEB_DIGEST)"
        if [ -n "$hd" ]; then
          printf 'sha256:hubd%s|%s|<none>|sha256:%s|%s|%s|Tugra Hub API|1000|0\\n' "$ver" "ghcr.io/simeraycom/tugra-hub" "$hd" "$ver" "https://github.com/SimerayCom/tugra" >> "$T"
          printf 'sha256:webd%s|%s|<none>|sha256:%s|%s|%s|Tugra Web|1000|0\\n' "$ver" "ghcr.io/simeraycom/tugra-web" "$wd" "$ver" "https://github.com/SimerayCom/tugra" >> "$T"
        else
          printf 'sha256:hub%s|%s|%s|<none>|%s|%s|Tugra Hub API|1000|0\\n' "$ver" "ghcr.io/simeraycom/tugra-hub" "$ver" "$ver" "https://github.com/SimerayCom/tugra" >> "$T"
          printf 'sha256:web%s|%s|%s|<none>|%s|%s|Tugra Web|1000|0\\n' "$ver" "ghcr.io/simeraycom/tugra-web" "$ver" "$ver" "https://github.com/SimerayCom/tugra" >> "$T"
        fi
        exit 0 ;;
      up)
        [ -n "$SHIM_UP_FAIL" ] && exit 1
        case "$*" in *hub-api*) v="$(env_val "$envf" TUGRA_VERSION)"; echo "$v" > "$D/run_hub"; echo "$v" > "$D/run_web" ;; esac
        exit 0 ;;
      ps)
        last=""; for a in "$@"; do last="$a"; done
        case "$last" in hub-api) echo cid-hub-api ;; web) echo cid-web ;; tugra-updater) echo cid-updater ;; esac
        exit 0 ;;
      exec) case "$*" in *pg_dump*) printf 'PGDMP-fake-dump' ;; *psql*) [ -n "$SHIM_DB_SIZE" ] && echo "$SHIM_DB_SIZE" ;; esac; exit 0 ;;
    esac
    exit 0 ;;
esac
exit 0
`;

const REDIS_SHIM = `#!/bin/sh
printf '%s\\n' "redis-cli $*" >> "$SHIM_LOG"
case "$*" in
  # SHIM_BLPOP_EMPTY=N: the first N BLPOPs time out (empty answer, exit 0); SHIM_BLPOP_FLIP=<v> then plays the stack coming up on <v>.
  *BLPOP*) n="$(cat "$SHIM_DIR/blpop_n" 2>/dev/null || echo 0)"
    if [ "$n" -lt "\${SHIM_BLPOP_EMPTY:-0}" ]; then echo $((n + 1)) > "$SHIM_DIR/blpop_n"; [ -z "$SHIM_BLPOP_FLIP" ] || { echo "$SHIM_BLPOP_FLIP" > "$SHIM_DIR/run_hub"; echo "$SHIM_BLPOP_FLIP" > "$SHIM_DIR/run_web"; }; exit 0; fi
    if [ -e "$SHIM_DIR/popped" ] || [ -z "$SHIM_JOB" ]; then exit 1; fi; : > "$SHIM_DIR/popped"; printf 'instance:update:queue\\n%s\\n' "$SHIM_JOB"; exit 0 ;;
esac
exit 0
`;

// df: the Docker data root reads the state file (prune raises it); any other path is the real filesystem, or SHIM_INSTALL_AVAIL_KB.
const DF_SHIM = `#!/bin/sh
last=""; for a in "$@"; do last="$a"; done
if [ "$last" = "$SHIM_ROOT" ]; then printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\nfs 0 0 %s 0%% /\\n' "$(cat "$SHIM_DIR/avail_kb")"; exit 0; fi
if [ -n "$TUGRA_CONTAINERD_ROOT" ] && [ "$last" = "$TUGRA_CONTAINERD_ROOT" ]; then printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\nfs 0 0 %s 0%% /\\n' "$SHIM_CONTAINERD_AVAIL_KB"; exit 0; fi
if [ -n "$SHIM_INSTALL_AVAIL_KB" ]; then printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\nfs 0 0 %s 0%% /\\n' "$SHIM_INSTALL_AVAIL_KB"; exit 0; fi
exec ${REAL_DF} "$@"
`;

// mktemp: a write that runs out of space. For the real .env's temp (not the staged copy) SHIM_ENV_FULL makes the "temp file" a
// symlink to /dev/full (every write fails with ENOSPC where it exists), else to a directory (the open fails): either way
// the script's own write check has to catch it.
const MKTEMP_SHIM = `#!/bin/sh
case "$1" in
  *.stage.*) exec ${REAL_MKTEMP} "$@" ;;
esac
if [ -n "$SHIM_ENV_FULL" ]; then
  name="\${1%XXXXXX}full$$"
  if [ -e /dev/full ]; then ln -s /dev/full "$name"; else ln -s "$SHIM_DIR" "$name"; fi
  echo "$name"; exit 0
fi
exec ${REAL_MKTEMP} "$@"
`;

const COMPOSE_YML = `services:
  hub-api:
    image: "ghcr.io/simeraycom/tugra-hub:\${TUGRA_VERSION:-latest}\${TUGRA_HUB_DIGEST:+@sha256:}\${TUGRA_HUB_DIGEST:-}"
  web:
    image: "ghcr.io/simeraycom/tugra-web:\${TUGRA_VERSION:-latest}\${TUGRA_WEB_DIGEST:+@sha256:}\${TUGRA_WEB_DIGEST:-}"
`;

interface RigOpts {
  env: string;
  images?: string[];
  availBytes?: number;
  runHub?: string;
  runWeb?: string;
  runHubPin?: string; // the running hub container was created from this digest pin (bare hex)
  runWebPin?: string;
  root?: string; // the Docker data root path as `docker info` reports it (default: a real directory)
}
interface RunOpts {
  job?: Record<string, string> | null;
  extra?: Record<string, string>;
}

const rigs: string[] = [];
afterAll(() => {
  for (const d of rigs) rmSync(d, { recursive: true, force: true });
});

function makeRig(o: RigOpts) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "update-atomic-")));
  rigs.push(dir);
  const repo = join(dir, "repo");
  const state = join(dir, "state");
  const bin = join(dir, "bin");
  mkdirSync(join(repo, "scripts", "lib"), { recursive: true });
  mkdirSync(join(repo, "deploy"));
  mkdirSync(state);
  mkdirSync(bin);
  for (const f of ["update.sh"]) writeFileSync(join(repo, "scripts", f), readFileSync(join(SCRIPTS, f)), { mode: 0o755 });
  for (const f of ["snapshot.sh", "hostfiles.sh", "images.sh"]) writeFileSync(join(repo, "scripts", "lib", f), readFileSync(join(SCRIPTS, "lib", f)));
  writeFileSync(join(repo, "deploy", "docker-compose.yml"), COMPOSE_YML);
  const envFile = join(repo, ".env");
  writeFileSync(envFile, o.env);
  const root = o.root ?? join(dir, "dockerroot");
  if (!o.root) mkdirSync(root);
  writeFileSync(join(state, "images"), (o.images ?? release("0.1.0")).join("\n") + "\n");
  writeFileSync(join(state, "avail_kb"), String(kb(o.availBytes ?? 100 * GiB)));
  writeFileSync(join(state, "run_hub"), o.runHub ?? "0.1.0");
  writeFileSync(join(state, "run_web"), o.runWeb ?? o.runHub ?? "0.1.0");
  writeFileSync(join(state, "run_hub_pin"), o.runHubPin ?? "");
  writeFileSync(join(state, "run_web_pin"), o.runWebPin ?? "");
  writeFileSync(join(state, "pulls"), "");
  for (const [name, text] of [
    ["docker", DOCKER_SHIM],
    ["redis-cli", REDIS_SHIM],
    ["df", DF_SHIM],
    ["mktemp", MKTEMP_SHIM],
  ] as const) {
    writeFileSync(join(bin, name), text, { mode: 0o755 });
    chmodSync(join(bin, name), 0o755);
  }
  const log = join(dir, "calls.log");
  writeFileSync(log, "");

  const run = (r: RunOpts = {}) => {
    rmSync(join(state, "popped"), { force: true });
    rmSync(join(state, "blpop_n"), { force: true });
    writeFileSync(log, "");
    const job = r.job === null ? "" : JSON.stringify(r.job ?? { targetVersion: "0.2.0" });
    const res = spawnSync(BASH, [join(repo, "scripts", "update.sh"), "--watch"], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        SHIM_LOG: log,
        SHIM_DIR: state,
        SHIM_ROOT: root,
        SHIM_JOB: job,
        UPDATE_HEALTH_TIMEOUT: "3",
        UPDATER_REFRESH_WAIT: "0",
        TUGRA_BACKUP_DIR: join(repo, "backups"),
        ...(r.extra ?? {}),
      } as NodeJS.ProcessEnv,
    });
    return { res, calls: readFileSync(log, "utf8"), out: `${res.stdout}${res.stderr}` };
  };
  const status = (calls: string): Record<string, unknown> => {
    const lines = calls.split("\n").filter((l) => l.includes(" SET instance:update:status "));
    const last = lines[lines.length - 1] ?? "";
    const json = last.slice(last.indexOf("status ") + "status ".length).replace(/ EX \d+$/, "");
    return JSON.parse(json) as Record<string, unknown>;
  };
  const strays = (): string[] => readdirSync(repo).filter((f) => f.startsWith(".env.")); // temp / staged env files
  return { dir, repo, state, envFile, run, status, strays, readEnv: () => readFileSync(envFile, "utf8"), running: () => readFileSync(join(state, "run_hub"), "utf8").trim() };
}

const pulled = (calls: string): boolean => /docker compose .* pull /.test(calls);
const noWrite = (calls: string): void => {
  expect(pulled(calls)).toBe(false);
  expect(calls).not.toMatch(/up -d/);
  expect(calls).toContain("DEL instance:update:lock");
};

describe("update.sh: disk preflight (before anything is written or pulled)", () => {
  it("too little room even after the safe cleanup: fails with the numbers + remedy, touches nothing", () => {
    const rig = makeRig({ env: "TUGRA_VERSION=0.1.0\nPRE_UPDATE_BACKUP=0\nKEEP=1\n", availBytes: 5 * GiB });
    const before = rig.readEnv();
    const { calls } = rig.run();
    const st = rig.status(calls);
    expect(st.phase).toBe("failed");
    expect(st.code).toBe("disk_space");
    expect(st.needBytes).toBe(20 * GiB); // 2 x the 9 GiB of the release on disk + 2 GiB
    expect(st.haveBytes).toBe(5 * GiB);
    expect(st.path).toBe(join(rig.dir, "dockerroot"));
    expect(String(st.error)).toMatch(/needs about 20\.0 GB free on .*dockerroot, has 5\.0 GB.*retry/);
    noWrite(calls);
    expect(calls).not.toContain("docker rmi"); // nothing old to remove: the running release is never a candidate
    expect(rig.readEnv()).toBe(before);
    expect(rig.strays()).toEqual([]);
  });

  it("short, but old releases can go: the safe prune runs first, the space is measured again, then the update proceeds", () => {
    const rig = makeRig({
      env: "TUGRA_VERSION=0.1.0\nPRE_UPDATE_BACKUP=0\n",
      images: [...release("0.0.8"), ...release("0.0.9"), ...release("0.1.0")],
      availBytes: 15 * GiB, // needs 20; 0.0.8 and 0.0.9 are both below the running release (the update itself deletes them afterwards)
    });
    const { calls, out } = rig.run();
    const beforePull = calls.slice(0, calls.search(/docker compose .* pull /)); // the preflight cleanup; the post-update cleanup comes later
    const rmi = beforePull.split("\n").filter((l) => l.startsWith("docker rmi "));
    expect(rmi.join("\n")).toContain("sha256:hub0.0.8");
    expect(rmi.join("\n")).toContain("sha256:web0.0.8");
    expect(rmi.join("\n")).not.toMatch(/0\.1\.0/); // the running release (the rollback anchor) stays
    expect(out).toContain("removing old Tugra release images first");
    expect(out).toContain("enough space after the cleanup");
    expect(rig.status(calls).phase).toBe("done");
    expect(rig.readEnv()).toContain("TUGRA_VERSION=0.2.0");
  });

  it("TUGRA_PRUNE_IMAGES=0: short means short (nothing is removed), TUGRA_DISK_CHECK=0 skips the check", () => {
    const base = { env: "TUGRA_VERSION=0.1.0\nPRE_UPDATE_BACKUP=0\n", images: [...release("0.0.8"), ...release("0.0.9"), ...release("0.1.0")], availBytes: 15 * GiB };
    const offRig = makeRig(base);
    const off = offRig.run({ extra: { TUGRA_PRUNE_IMAGES: "0" } });
    expect(off.calls).not.toContain("docker rmi");
    expect(offRig.status(off.calls).code).toBe("disk_space");
    expect(off.out).toContain("image cleanup is disabled");
    noWrite(off.calls);
    const skip = makeRig({ ...base, availBytes: GiB });
    const r = skip.run({ extra: { TUGRA_DISK_CHECK: "0" } });
    expect(r.out).toContain("disk check disabled");
    expect(skip.status(r.calls).phase).toBe("done");
  });

  it("a Docker data root the updater cannot see is measured through a throwaway container (df in a bind mount of that path)", () => {
    const root = "/var/lib/tugra-fake-docker-root";
    const rig = makeRig({ env: "TUGRA_VERSION=0.1.0\nPRE_UPDATE_BACKUP=0\n", root, availBytes: 3 * GiB });
    const { calls } = rig.run();
    expect(calls).toMatch(new RegExp(`docker run --rm --network none --entrypoint df -v ${root}:/tugra-df-probe:ro \\S+ -Pk /tugra-df-probe`));
    const st = rig.status(calls);
    expect(st.code).toBe("disk_space");
    expect(st.path).toBe(root);
    expect(st.haveBytes).toBe(3 * GiB);
    noWrite(calls);
  });

  it("the install dir is checked too (.env rewrite, staged env, restore point): 256 MiB, reported with that path", () => {
    const rig = makeRig({ env: "TUGRA_VERSION=0.1.0\nPRE_UPDATE_BACKUP=0\n" });
    const { calls } = rig.run({ extra: { SHIM_INSTALL_AVAIL_KB: "1024" } });
    const st = rig.status(calls);
    expect(st.code).toBe("disk_space");
    expect(st.path).toBe(rig.repo);
    expect(st.needBytes).toBe(256 * 1024 * 1024);
    expect(st.haveBytes).toBe(1024 * 1024);
    noWrite(calls);
  });

  it("a measurement it cannot take never blocks the update", () => {
    const rig = makeRig({ env: "TUGRA_VERSION=0.1.0\nPRE_UPDATE_BACKUP=0\n", availBytes: 0 });
    writeFileSync(join(rig.state, "avail_kb"), "not-a-number");
    const { out, calls } = rig.run();
    expect(out).toContain("could not measure the free space of the Docker data root");
    expect(rig.status(calls).phase).toBe("done");
  });
});

describe("update.sh: disk preflight, review follow-ups", () => {
  it("the preflight cleanup keeps only what the post-update cleanup keeps (target + running): the release BELOW the running one is freed too", () => {
    const rig = makeRig({
      env: "TUGRA_VERSION=0.1.0\nPRE_UPDATE_BACKUP=0\n",
      images: [...release("0.0.8"), ...release("0.0.9"), ...release("0.1.0")],
      availBytes: 5 * GiB, // needs 20; freeing 0.0.8 alone gives 14, freeing 0.0.8 and 0.0.9 gives 23
    });
    const { calls } = rig.run();
    expect(rig.status(calls).phase).toBe("done");
    const beforePull = calls.slice(0, calls.search(/docker compose .* pull /));
    const rmi = beforePull.split("\n").filter((l) => l.startsWith("docker rmi ")).join("\n");
    expect(rmi).toContain("sha256:hub0.0.9");
    expect(rmi).not.toContain("0.1.0");
  });

  it("the refusal names the TUGRA_DISK_CHECK=0 escape hatch", () => {
    const rig = makeRig({ env: "TUGRA_VERSION=0.1.0\nPRE_UPDATE_BACKUP=0\n", availBytes: 5 * GiB });
    const { calls } = rig.run();
    expect(String(rig.status(calls).error)).toContain("TUGRA_DISK_CHECK=0");
  });

  it("the containerd image store keeps its content under /var/lib/containerd: that filesystem is measured too, and named when it is the short one", () => {
    const rig = makeRig({ env: "TUGRA_VERSION=0.1.0\nPRE_UPDATE_BACKUP=0\n" });
    const croot = join(rig.dir, "containerd");
    mkdirSync(croot);
    const { calls } = rig.run({ extra: { SHIM_CONTAINERD: "1", TUGRA_CONTAINERD_ROOT: croot, SHIM_CONTAINERD_AVAIL_KB: String(kb(GiB)) } });
    const st = rig.status(calls);
    expect(st.code).toBe("disk_space");
    expect(st.path).toBe(croot);
    expect(st.haveBytes).toBe(GiB);
    noWrite(calls);
    const plain = makeRig({ env: "TUGRA_VERSION=0.1.0\nPRE_UPDATE_BACKUP=0\n" }); // an engine without that store: the path is never looked at
    const p = plain.run({ extra: { TUGRA_CONTAINERD_ROOT: croot, SHIM_CONTAINERD_AVAIL_KB: String(kb(GiB)) } });
    expect(plain.status(p.calls).phase).toBe("done");
  });

  it("the restore point's dump is part of the budget: a big database makes a tight disk short BEFORE the dump eats the pull's room", () => {
    const tight = makeRig({ env: "TUGRA_VERSION=0.1.0\n", availBytes: 25 * GiB }); // 20 GiB for the images fits...
    const { calls } = tight.run({ extra: { SHIM_DB_SIZE: String(6 * GiB) } }); // ...but not with a ~6.6 GiB dump on the same filesystem
    const st = tight.status(calls);
    expect(st.code).toBe("disk_space");
    expect(st.path).toBe(join(tight.dir, "dockerroot"));
    expect(Number(st.needBytes)).toBeGreaterThan(26 * GiB);
    expect(calls).not.toContain("pg_dump");
    noWrite(calls);
    const small = makeRig({ env: "TUGRA_VERSION=0.1.0\n", availBytes: 25 * GiB });
    expect(small.status(small.run({ extra: { SHIM_DB_SIZE: String(50 * 1024 * 1024) } }).calls).phase).toBe("done");
  });

  it("a run that fails before .env is written deletes the restore point it took (retries must not pile dumps onto a full disk); a good run keeps it", () => {
    const dumps = (repo: string): string[] => {
      const d = join(repo, "backups");
      return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".dump")) : [];
    };
    const bad = makeRig({ env: "TUGRA_VERSION=0.1.0\n" });
    const r = bad.run({ extra: { SHIM_PULL_FAIL: "failed to register layer: no space left on device" } });
    expect(bad.status(r.calls).phase).toBe("failed");
    expect(String(bad.status(r.calls).error)).not.toContain("pre-update backup:");
    expect(dumps(bad.repo)).toEqual([]);
    const good = makeRig({ env: "TUGRA_VERSION=0.1.0\n" });
    expect(good.status(good.run().calls).phase).toBe("done");
    expect(dumps(good.repo)).toHaveLength(1);
  });
});

describe("update.sh: the status is always valid JSON", () => {
  it("control characters in a failing pull's output (ESC colours, backspace, BEL) cannot corrupt the status the hub parses", () => {
    const rig = makeRig({ env: "TUGRA_VERSION=0.1.0\nPRE_UPDATE_BACKUP=0\n" });
    const { calls } = rig.run({ extra: { SHIM_PULL_FAIL: "\u001b[31mError\u001b[0m response: \u0008denied\u0007 \u007f\"quoted\"\\" } });
    const st = rig.status(calls); // JSON.parse inside: it threw before json_str dropped every control character
    expect(st.phase).toBe("failed");
    expect(String(st.error)).toMatch(/^image pull failed: Error response: denied/);
    // eslint-disable-next-line no-control-regex
    expect(String(st.error)).not.toMatch(/[\u0000-\u001f\u007f]/);
  });
});

describe("update.sh: pull first, write .env last", () => {
  it("a failed pull leaves .env byte-identical and nothing recreated; the pull ran against a STAGED env (the target's refs), which is gone afterwards", () => {
    const rig = makeRig({ env: "A=1\nTUGRA_VERSION=0.1.0\nPRE_UPDATE_BACKUP=0\nZ=last\n" });
    const before = rig.readEnv();
    const { calls } = rig.run({ extra: { SHIM_PULL_FAIL: "Error response from daemon: unauthorized: authentication required" } });
    const st = rig.status(calls);
    expect(st.phase).toBe("failed");
    expect(String(st.error)).toBe("image pull failed: Error response from daemon: unauthorized: authentication required");
    expect(readFileSync(join(rig.state, "pulls"), "utf8")).toMatch(/pull-env TUGRA_VERSION=0\.2\.0 .*file=.*\.env\.stage\./);
    expect(calls).not.toMatch(/up -d/);
    expect(calls).toContain("DEL instance:update:lock");
    expect(rig.readEnv()).toBe(before);
    expect(rig.strays()).toEqual([]);
    expect(rig.running()).toBe("0.1.0");
  });

  it("a full disk during the pull is reported as that (code disk_space), .env untouched", () => {
    const rig = makeRig({ env: "TUGRA_VERSION=0.1.0\nPRE_UPDATE_BACKUP=0\n" });
    const before = rig.readEnv();
    const { calls } = rig.run({ extra: { SHIM_PULL_FAIL: "failed to register layer: write /var/lib/docker/x: no space left on device" } });
    const st = rig.status(calls);
    expect(st.code).toBe("disk_space");
    expect(String(st.error)).toContain("the disk filled up while pulling the images");
    expect(rig.readEnv()).toBe(before);
    expect(calls).not.toMatch(/up -d/);
  });

  it("an image whose version label names ANOTHER release is refused before .env is written (tag-only and digest-pinned)", () => {
    const H = "a".repeat(64);
    const W = "b".repeat(64);
    const jobs: Array<Record<string, string>> = [{ targetVersion: "0.2.0" }, { targetVersion: "0.2.0", hubDigest: H, webDigest: W }];
    for (const job of jobs) {
      const rig = makeRig({ env: "TUGRA_VERSION=0.1.0\nPRE_UPDATE_BACKUP=0\n" });
      const before = rig.readEnv();
      const { calls } = rig.run({ job, extra: { SHIM_LABEL: "0.1.5" } });
      const st = rig.status(calls);
      expect(st.phase).toBe("failed");
      expect(String(st.error)).toBe("image version label mismatch: hub reports 0.1.5, expected 0.2.0");
      expect(calls).not.toMatch(/up -d/);
      expect(rig.readEnv()).toBe(before);
      expect(rig.strays()).toEqual([]);
    }
  });

  it("the happy path: the pull sees the target in a staged env while .env still names the running release; .env is written only after the labels check out", () => {
    const rig = makeRig({ env: "TUGRA_VERSION=0.1.0\nPRE_UPDATE_BACKUP=0\n" });
    const { calls } = rig.run();
    expect(calls.search(/docker compose .* pull /)).toBeLessThan(calls.search(/docker image inspect .*tugra-hub:0\.2\.0/));
    expect(calls.search(/docker image inspect .*tugra-web:0\.2\.0/)).toBeGreaterThan(-1);
    expect(readFileSync(join(rig.state, "pulls"), "utf8")).toContain("pull-env TUGRA_VERSION=0.2.0");
    expect(rig.status(calls).phase).toBe("done");
    expect(rig.readEnv()).toContain("TUGRA_VERSION=0.2.0");
    expect(rig.running()).toBe("0.2.0");
    expect(rig.strays()).toEqual([]);
  });
});

describe("update.sh: an atomic, checked .env write", () => {
  it("a write that fails (disk full) is reported clearly and the original .env stays intact, nothing recreated", () => {
    const rig = makeRig({ env: "A=1\nTUGRA_VERSION=0.1.0\nPRE_UPDATE_BACKUP=0\nSECRET=keep-me\n" });
    const before = rig.readEnv();
    const { calls, out } = rig.run({ extra: { SHIM_ENV_FULL: "1" } });
    const st = rig.status(calls);
    expect(st.phase).toBe("failed");
    expect(String(st.error)).toMatch(/could not update \.env \(disk full or not writable\?\); .*\.env was not changed and the previous version keeps running/);
    expect(out).toMatch(/cannot write .*\(disk full\?\)|did not verify/);
    expect(rig.readEnv()).toBe(before);
    expect(readdirSync(rig.repo).filter((f) => f.startsWith(".env.") && !existsSync(join(rig.repo, f)))).toEqual([]); // no dangling temp
    expect(calls).not.toMatch(/up -d/);
    expect(rig.running()).toBe("0.1.0");
  });

  it("a normal write keeps the file's other lines, its order and mode", () => {
    const rig = makeRig({ env: "A=1\nTUGRA_VERSION=0.1.0\nPRE_UPDATE_BACKUP=0\nZ=last" }); // no trailing newline
    chmodSync(rig.envFile, 0o640);
    rig.run();
    expect(rig.readEnv()).toBe("A=1\nPRE_UPDATE_BACKUP=0\nZ=last\nTUGRA_VERSION=0.2.0\n");
    expect(execFileSync("stat", process.platform === "darwin" ? ["-f", "%Lp", rig.envFile] : ["-c", "%a", rig.envFile]).toString().trim()).toBe("640");
  });
});

describe("update.sh: a half-finished update (.env ahead of what runs)", () => {
  const HALF_ENV = "TUGRA_VERSION=0.2.0\nPRE_UPDATE_BACKUP=0\nKEEP=1\n";

  it("'Update now' RESUMES: pulls what is missing, recreates, ends done (it used to fail with 'target not newer than current')", () => {
    const rig = makeRig({ env: HALF_ENV, runHub: "0.1.0" });
    const { calls, out } = rig.run();
    expect(out).toContain("half-finished update found");
    expect(out).toContain("names 0.2.0 but the running stack is on 0.1.0");
    expect(out).not.toContain("refusing non-newer target");
    expect(calls).toMatch(/SET instance:update:half_state \{"envVersion":"0\.2\.0","runningVersion":"0\.1\.0"\}/);
    expect(readFileSync(join(rig.state, "pulls"), "utf8")).toContain("pull-env TUGRA_VERSION=0.2.0");
    expect(calls).toContain("up -d --no-deps hub-api web");
    expect(rig.status(calls).phase).toBe("done");
    expect(rig.readEnv()).toContain("TUGRA_VERSION=0.2.0");
    expect(rig.running()).toBe("0.2.0");
    expect(calls.lastIndexOf("DEL instance:update:half_state")).toBeGreaterThan(calls.indexOf("SET instance:update:half_state"));
  });

  it("a half state whose .env also carries the unreleased digest pins: the resume rewrites them (they must not override the tag)", () => {
    const rig = makeRig({ env: `${HALF_ENV}TUGRA_HUB_DIGEST=${"c".repeat(64)}\nTUGRA_WEB_DIGEST=${"d".repeat(64)}\n`, runHub: "0.1.0" });
    const { calls } = rig.run();
    expect(rig.status(calls).phase).toBe("done");
    expect(rig.readEnv()).toContain("TUGRA_VERSION=0.2.0");
    expect(rig.readEnv()).toMatch(/^TUGRA_HUB_DIGEST=$/m);
    expect(rig.readEnv()).toMatch(/^TUGRA_WEB_DIGEST=$/m);
  });

  it("the target cannot be pulled: .env is put back to the RUNNING version (pins cleared) and the status says so", () => {
    const rig = makeRig({ env: `${HALF_ENV}TUGRA_HUB_DIGEST=${"c".repeat(64)}\nTUGRA_WEB_DIGEST=${"d".repeat(64)}\n`, runHub: "0.1.0" });
    const { calls } = rig.run({ extra: { SHIM_PULL_FAIL: "manifest unknown" } });
    const st = rig.status(calls);
    expect(st.phase).toBe("failed");
    expect(String(st.error)).toContain("image pull failed: manifest unknown");
    expect(String(st.error)).toContain("was set back to the running version 0.1.0");
    expect(rig.readEnv()).toMatch(/^TUGRA_VERSION=0\.1\.0$/m);
    expect(rig.readEnv()).not.toContain("0.2.0");
    expect(rig.readEnv()).toMatch(/^TUGRA_HUB_DIGEST=$/m);
    expect(rig.readEnv()).toContain("KEEP=1"); // the rest of the file survives
    expect(calls).not.toMatch(/up -d/);
    expect(calls).toContain("DEL instance:update:half_state"); // repaired: no half state to offer any more
    expect(rig.running()).toBe("0.1.0");
  });

  it("a wrong image (label mismatch) in a half state is repaired the same way", () => {
    const rig = makeRig({ env: HALF_ENV, runHub: "0.1.0" });
    const { calls } = rig.run({ extra: { SHIM_LABEL: "0.1.5" } });
    expect(String(rig.status(calls).error)).toContain("image version label mismatch");
    expect(rig.readEnv()).toContain("TUGRA_VERSION=0.1.0");
    expect(calls).not.toMatch(/up -d/);
  });

  it("the target cannot be pulled and the RUNNING containers were created from digest pins: .env goes back to exactly those pins (a rollback by tag alone would need the registry)", () => {
    const hubPin = "e".repeat(64);
    const webPin = "f".repeat(64);
    const rig = makeRig({ env: `${HALF_ENV}TUGRA_HUB_DIGEST=${"c".repeat(64)}\nTUGRA_WEB_DIGEST=${"d".repeat(64)}\n`, runHub: "0.1.0", runHubPin: hubPin, runWebPin: webPin });
    const { calls } = rig.run({ extra: { SHIM_PULL_FAIL: "manifest unknown" } });
    expect(String(rig.status(calls).error)).toContain("was set back to the running version 0.1.0");
    expect(rig.readEnv()).toMatch(/^TUGRA_VERSION=0\.1\.0$/m);
    expect(rig.readEnv()).toContain(`TUGRA_HUB_DIGEST=${hubPin}`);
    expect(rig.readEnv()).toContain(`TUGRA_WEB_DIGEST=${webPin}`);
    expect(rig.readEnv()).not.toContain("c".repeat(64));
  });

  it("a disk preflight failure in a half state touches nothing (the 'Finish update' retry repairs it later)", () => {
    const rig = makeRig({ env: HALF_ENV, runHub: "0.1.0", availBytes: 2 * GiB });
    const before = rig.readEnv();
    const { calls } = rig.run();
    expect(rig.status(calls).code).toBe("disk_space");
    expect(rig.readEnv()).toBe(before);
    noWrite(calls);
  });

  it("a half state (hub on the old release, web already recreated on the new) counts the OLDER one as running", () => {
    const rig = makeRig({ env: HALF_ENV, runHub: "0.1.0" });
    writeFileSync(join(rig.state, "run_web"), "0.2.0");
    const { out, calls } = rig.run();
    expect(out).toContain("the running stack is on 0.1.0");
    expect(rig.status(calls).phase).toBe("done");
  });

  it("no half state when .env and the containers agree, or when the containers cannot be read", () => {
    const same = makeRig({ env: "TUGRA_VERSION=0.1.0\nPRE_UPDATE_BACKUP=0\n" });
    expect(same.run().calls).not.toContain("SET instance:update:half_state");
    const unknown = makeRig({ env: HALF_ENV, runHub: "not-a-version" });
    const r = unknown.run();
    expect(r.calls).not.toContain("SET instance:update:half_state");
    expect(r.out).toContain("refusing non-newer target"); // no evidence of a half state: the old, safe refusal stands
    expect(String(unknown.status(r.calls).error)).toContain("not newer than the running version 0.2.0");
  });

  it("the target must still be newer than what RUNS (never a downgrade), even from a half state", () => {
    const rig = makeRig({ env: "TUGRA_VERSION=0.3.0\nPRE_UPDATE_BACKUP=0\n", runHub: "0.2.5" });
    const { calls } = rig.run({ job: { targetVersion: "0.2.0" } });
    expect(rig.status(calls).phase).toBe("failed");
    expect(calls).not.toMatch(/docker compose .* pull /);
    expect(rig.readEnv()).toContain("TUGRA_VERSION=0.3.0");
  });

  it("while the stack is not up yet (running release unreadable) an earlier half-state report is KEPT, and it is re-checked while idle: the report appears once the stack is readable", () => {
    const rig = makeRig({ env: HALF_ENV, runHub: "not-a-version" });
    const r = rig.run({ job: null, extra: { SHIM_BLPOP_EMPTY: "1", SHIM_BLPOP_FLIP: "0.1.0" } });
    expect(r.calls).not.toContain("DEL instance:update:half_state"); // unknown is not "consistent"
    const firstBlpop = r.calls.indexOf("BLPOP");
    expect(firstBlpop).toBeGreaterThan(-1);
    expect(r.calls.indexOf("SET instance:update:half_state")).toBeGreaterThan(firstBlpop); // reported by the re-check, not at start-up
    expect(r.calls).toMatch(/SET instance:update:half_state \{"envVersion":"0\.2\.0","runningVersion":"0\.1\.0"\}/);
    expect(r.calls).toMatch(/BLPOP instance:update:queue 60/); // bounded, so the idle loop can re-check
  });

  it("at start-up it reports a half state to the hub (so the panel can offer 'Finish update'), and clears the report when there is none", () => {
    const half = makeRig({ env: HALF_ENV, runHub: "0.1.0" });
    const a = half.run({ job: null });
    expect(a.calls).toMatch(/SET instance:update:half_state \{"envVersion":"0\.2\.0","runningVersion":"0\.1\.0"\}/);
    expect(a.out).toContain("Finish update");
    const fine = makeRig({ env: "TUGRA_VERSION=0.1.0\nPRE_UPDATE_BACKUP=0\n" });
    const b = fine.run({ job: null });
    expect(b.calls).toContain("DEL instance:update:half_state");
    expect(b.calls).not.toContain("SET instance:update:half_state");
    expect(half.readEnv()).toBe(HALF_ENV); // reporting never writes
  });
});

describe("update.sh --dry-run: half state and the preflight are part of the plan", () => {
  const dir = mkdtempSync(join(tmpdir(), "update-atomic-dry-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const dry = (envText: string, extra: Record<string, string> = {}): string => {
    const envFile = join(dir, ".env");
    writeFileSync(envFile, envText);
    return execFileSync(BASH, [join(SCRIPTS, "update.sh"), "--dry-run", "--target", "0.2.0"], {
      stdio: "pipe",
      env: { PATH: process.env.PATH, ENV_FILE: envFile, ...extra } as NodeJS.ProcessEnv,
    }).toString();
  };

  it("plans the disk preflight before the pull and the pull before the .env write", () => {
    const out = dry("TUGRA_VERSION=0.1.0\n");
    const pre = out.indexOf("RUN: disk preflight");
    expect(pre).toBeGreaterThan(-1);
    expect(pre).toBeLessThan(out.indexOf("pg_dump"));
    expect(out.indexOf("pull hub-api web")).toBeLessThan(out.indexOf("SET_ENV: TUGRA_VERSION=0.2.0"));
  });

  it("DRY_RUNNING plays the running release: env ahead of it resumes instead of refusing", () => {
    const out = dry("TUGRA_VERSION=0.2.0\n", { DRY_RUNNING: "0.1.0" });
    expect(out).toContain("half-finished update found");
    expect(out).not.toContain("refusing non-newer target");
    expect(out).toContain("SET_ENV: TUGRA_VERSION=0.2.0");
    expect(out).toContain('"phase":"done"');
    expect(dry("TUGRA_VERSION=0.2.0\n")).toContain("refusing non-newer target"); // unknown running release: unchanged behaviour
  });
});
