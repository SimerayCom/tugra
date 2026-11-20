import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * scripts/lib/images.sh (image pruning + the agent pull) and its use by scripts/update.sh. Runner-independent: a PATH
 * shim stands in for docker, the script is exercised through bash only (no host files are read).
 */
const SCRIPTS = join(__dirname, "..", "..", "..", "..", "scripts");
const IMAGES_SH = join(SCRIPTS, "lib", "images.sh");
const UPDATE_SH = join(SCRIPTS, "update.sh");
const BASH = execFileSync("sh", ["-c", "command -v bash"]).toString().trim();

const SRC = "https://github.com/SimerayCom/tugra";
const HUB = "ghcr.io/simeraycom/tugra-hub";
const WEB = "ghcr.io/simeraycom/tugra-web";
const AGENT = "ghcr.io/simeraycom/tugra-agent";

/** One row of `prune_select` input: ID|REPO|TAG|DIGEST|VERSION|SOURCE|TITLE. */
const row = (id: string, repo: string, tag: string, digest: string, ver: string, src = "", title = "") => [id, repo, tag, digest, ver, src, title].join("|");

function select(rows: string[], current: string, previous: string): string[] {
  const r = spawnSync(BASH, ["-c", `. "${IMAGES_SH}"; prune_select "$1" "$2"`, "x", current, previous], { input: rows.join("\n") + "\n", encoding: "utf8" });
  expect(r.status).toBe(0);
  return r.stdout.split("\n").filter(Boolean);
}
const removedIds = (lines: string[]) => lines.map((l) => l.split("|")[0]).sort();

describe("prune_select (which images go)", () => {
  // the demo's shape: tagged old releases, digest-pinned (tag-less) recent ones, a dangling leftover, foreign images
  const rows = [
    row("sha256:hub11", HUB, "0.1.0-beta.11", "<none>", "0.1.0-beta.11", SRC, "Tugra Hub API"),
    row("sha256:hub17", HUB, "0.1.0-beta.17", "<none>", "0.1.0-beta.17", SRC, "Tugra Hub API"),
    row("sha256:hub18", HUB, "<none>", "sha256:aa18", "0.1.0-beta.18", SRC, "Tugra Hub API"), // digest pull: no tag
    row("sha256:hub19", HUB, "<none>", "sha256:aa19", "0.1.0-beta.19", SRC, "Tugra Hub API"),
    row("sha256:web2", WEB, "0.1.0-beta.2", "<none>", "", "", ""), // predates the version label: the tag is the version
    row("sha256:dangling12", "<none>", "<none>", "<none>", "0.1.0-beta.12", SRC, "Tugra Web"),
    row("sha256:agentLatest", AGENT, "latest", "<none>", "0.1.0-beta.3", SRC, "Tugra Agent"),
    row("sha256:immich", "ghcr.io/immich-app/immich-server", "release", "<none>", "v1.0.0"),
    row("sha256:traefik", "traefik", "v3.7.16", "<none>", "3.7.16"),
    row("sha256:app", "tugra_cmwgxy1zm0j4nnm1a0cfjrm4j", "cmwgxy20e0j4tnm1a54gzty93", "<none>", ""),
    row("sha256:selfbuilt", "tugra-hub-api", "latest", "<none>", ""),
    row("sha256:foreignDangling", "<none>", "<none>", "<none>", "0.0.1", "https://example.com/app", "My App"),
    row("sha256:foreignDanglingNoLabels", "<none>", "<none>", "<none>", ""),
  ];

  it("keeps the new release and the previous one, removes every older Tugra image (tagged or digest-pulled) and dangling leftovers", () => {
    const out = select(rows, "0.1.0-beta.19", "0.1.0-beta.18");
    expect(removedIds(out)).toEqual(["sha256:dangling12", "sha256:hub11", "sha256:hub17", "sha256:web2"]);
  });

  it("never touches a foreign image, a locally built tugra-hub-api, an app image, `latest`, or an unnamed image that is not Tugra's", () => {
    for (const prev of ["0.1.0-beta.18", "0.1.0-beta.17", "0.1.0-beta.30"]) {
      const ids = removedIds(select(rows, "0.1.0-beta.19", prev));
      for (const keep of ["immich", "traefik", "app", "selfbuilt", "agentLatest", "foreignDangling", "foreignDanglingNoLabels", "hub19"]) {
        expect(ids).not.toContain(`sha256:${keep}`);
      }
    }
  });

  it("the floor is the previous release: with previous=beta.17 the beta.17 image stays and only older ones go", () => {
    const out = select(rows, "0.1.0-beta.19", "0.1.0-beta.17");
    expect(removedIds(out)).toEqual(["sha256:dangling12", "sha256:hub11", "sha256:web2"]);
    expect(out.find((l) => l.startsWith("sha256:hub11"))).toBe(`sha256:hub11|${HUB}:0.1.0-beta.11|0.1.0-beta.11`);
  });

  it("a re-run on the SAME release (installer repair/--pull) keeps the real rollback anchor: the newest older release on disk, not the current one", () => {
    // current == previous == beta.19: the installer cannot know the real previous release, so beta.18 (on disk) stays
    const out = select(rows, "0.1.0-beta.19", "0.1.0-beta.19");
    expect(removedIds(out)).toEqual(["sha256:dangling12", "sha256:hub11", "sha256:hub17", "sha256:web2"]);
    expect(removedIds(out)).not.toContain("sha256:hub18");
    // without anything older than current on disk there is nothing to anchor on and nothing to remove
    expect(removedIds(select([rows[3]], "0.1.0-beta.19", "0.1.0-beta.19"))).toEqual([]);
    // the anchor only looks at Tugra's images: a foreign image with a newer-looking version never becomes it
    const withForeign = [...rows.filter((r) => !r.startsWith("sha256:hub18")), row("sha256:fx", "traefik", "v0.1.0-beta.18", "<none>", "0.1.0-beta.18")];
    // (the foreign beta.18 is ignored, so the anchor is Tugra's own beta.17, which stays)
    expect(removedIds(select(withForeign, "0.1.0-beta.19", "0.1.0-beta.19"))).toEqual(["sha256:dangling12", "sha256:hub11", "sha256:web2"]);
  });

  it("references: a tagged image is removed as repo:tag, a digest-only one as repo@digest, an unnamed one by id", () => {
    const out = select(
      [
        row("sha256:t", HUB, "0.1.0-beta.1", "<none>", "0.1.0-beta.1", SRC, "Tugra Hub API"),
        row("sha256:d", HUB, "<none>", "sha256:abc", "0.1.0-beta.2", SRC, "Tugra Hub API"),
        row("sha256:u", "<none>", "<none>", "<none>", "0.1.0-beta.3", SRC, "Tugra Agent"),
      ],
      "0.1.0-beta.19",
      "0.1.0-beta.18",
    );
    expect(out).toEqual([`sha256:t|${HUB}:0.1.0-beta.1|0.1.0-beta.1`, `sha256:d|${HUB}@sha256:abc|0.1.0-beta.2`, "sha256:u|sha256:u|0.1.0-beta.3"]);
  });

  it("one image id with several tags: if any of them is a kept release the whole image stays", () => {
    const out = select(
      [row("sha256:m", AGENT, "0.1.0-beta.4", "<none>", "0.1.0-beta.19", SRC, "Tugra Agent"), row("sha256:m", AGENT, "0.1.0-beta.19", "<none>", "0.1.0-beta.19", SRC, "Tugra Agent")],
      "0.1.0-beta.19",
      "0.1.0-beta.18",
    );
    expect(out).toEqual([]);
  });

  it("with a previous version that cannot be ordered (latest / empty / not semver) NO versioned image is removed", () => {
    for (const prev of ["latest", "", "weekly-2026-11"]) {
      expect(removedIds(select(rows, "0.1.0-beta.19", prev))).toEqual([]);
    }
  });

  it("a custom tag without a version (a mirror's own naming, edge/dev) is the operator's and stays; images newer than the release stay", () => {
    const out = select(
      [row("sha256:edge", HUB, "edge", "<none>", "", "", ""), row("sha256:future", HUB, "0.2.0", "<none>", "0.2.0", SRC, "Tugra Hub API"), row("sha256:old", HUB, "0.1.0-beta.1", "<none>", "0.1.0-beta.1", SRC, "Tugra Hub API")],
      "0.1.0-beta.19",
      "0.1.0-beta.18",
    );
    expect(removedIds(out)).toEqual(["sha256:old"]);
  });

  it("honours a mirror via the *_IMAGE_REPO overrides (and then no longer treats the official repo as Tugra's)", () => {
    const r = spawnSync(BASH, ["-c", `. "${IMAGES_SH}"; prune_select 0.1.0-beta.19 0.1.0-beta.18`], {
      input: [row("sha256:m1", "registry.example/tugra-hub", "0.1.0-beta.1", "<none>", "0.1.0-beta.1"), row("sha256:o1", HUB, "0.1.0-beta.1", "<none>", "0.1.0-beta.1")].join("\n") + "\n",
      encoding: "utf8",
      env: { ...process.env, HUB_IMAGE_REPO: "registry.example/tugra-hub" } as NodeJS.ProcessEnv,
    });
    expect(r.stdout.trim()).toBe("sha256:m1|registry.example/tugra-hub:0.1.0-beta.1|0.1.0-beta.1");
  });

  it("recognises a release repository by an exact line match, in any position, under pipefail (never as a prefix, substring or glob)", () => {
    const t = (repo: string) => spawnSync(BASH, ["-c", `set -euo pipefail; log() { :; }; . "${IMAGES_SH}"; _prune_is_tugra "$1" "" ""`, "x", repo]).status;
    for (const repo of [HUB, WEB, AGENT, "ghcr.io/simeraycom/tugra-updater"]) expect(t(repo)).toBe(0);
    for (const repo of ["ghcr.io/simeraycom/tugra-hu", "ghcr.io/simeraycom/tugra-hub2", "simeraycom/tugra-hub", "ghcr.io/simeraycom/tugra-*", "", "<none>"]) expect(t(repo)).toBe(1);
  });

  it("no script pipes printf into `grep -q` (under pipefail grep exits at the first match, printf dies of SIGPIPE and the match reads as a miss)", () => {
    const files = [join(SCRIPTS, "update.sh"), join(SCRIPTS, "install.sh"), ...readdirSync(join(SCRIPTS, "lib")).filter((f) => f.endsWith(".sh")).map((f) => join(SCRIPTS, "lib", f))];
    const offenders = files.flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .filter((l) => !l.trim().startsWith("#") && /\b(printf|echo)\b[^|\n]*\|\s*grep\s+-[A-Za-z]*q/.test(l))
        .map((l) => `${f}: ${l.trim()}`),
    );
    expect(offenders).toEqual([]);
  });

  it("is_newer orders prereleases the semver way (beta.10 > beta.9, release > its betas)", () => {
    const t = (a: string, b: string) => spawnSync(BASH, ["-c", `. "${IMAGES_SH}"; is_newer "$1" "$2"`, "x", a, b]).status;
    expect(t("0.1.0-beta.10", "0.1.0-beta.9")).toBe(0);
    expect(t("0.1.0", "0.1.0-beta.9")).toBe(0);
    expect(t("0.1.0-beta.9", "0.1.0")).toBe(1);
    expect(t("0.1.0-beta.9", "0.1.0-beta.9")).toBe(1);
  });
});

/**
 * A stateful docker shim. State file rows: ID|REPO|TAG|DIGEST|VERSION|SOURCE|TITLE|SIZE|INUSE.
 * Implements exactly what images.sh and update.sh call; everything is logged to SHIM_LOG.
 */
const DOCKER_SHIM = `#!/bin/bash
echo "docker $*" >> "$SHIM_LOG"
T="$SHIM_IMAGES"
resolve() {
  awk -F'|' -v r="$1" '$1==r || ($2!="<none>" && $3!="<none>" && $2":"$3==r) || ($2!="<none>" && $4!="<none>" && $2"@"$4==r) {print $1; exit}' "$T"
}
case "$1 $2" in
  "image ls") awk -F'|' '{print $1"|"$2"|"$3"|"$4}' "$T"; exit 0 ;;
  "image inspect")
    shift 2; fmt=""; if [ "$1" = "-f" ]; then fmt="$2"; shift 2; fi
    id="$(resolve "$1")"; [ -n "$id" ] || exit 1
    case "$fmt" in
      *"{{.Size}}"*) awk -F'|' -v i="$id" '$1==i{print $8; exit}' "$T" ;;
      *"{{.Id}}"*) echo "$id" ;;
      *"image.source"*) awk -F'|' -v i="$id" '$1==i{print $5"|"$6"|"$7; exit}' "$T" ;;
      *"image.version"*) awk -F'|' -v i="$id" '$1==i{print $5; exit}' "$T" ;;
    esac
    exit 0 ;;
esac
case "$1" in
  rmi)
    id="$(resolve "$2")"; [ -n "$id" ] || { echo "No such image: $2" >&2; exit 1; }
    inuse="$(awk -F'|' -v i="$id" '$1==i{print $9; exit}' "$T")"
    [ "$inuse" = "1" ] && { echo "conflict: image is being used by a container" >&2; exit 1; }
    if [ "$2" = "$id" ]; then awk -F'|' -v i="$id" '$1!=i' "$T" > "$T.n"
    else awk -F'|' -v r="$2" '!($1==r || ($2!="<none>" && $3!="<none>" && $2":"$3==r) || ($2!="<none>" && $4!="<none>" && $2"@"$4==r))' "$T" > "$T.n"; fi
    mv "$T.n" "$T"; exit 0 ;;
  pull)
    if [ -n "$SHIM_PULL_FAIL" ] && [[ "$2" == *"$SHIM_PULL_FAIL"* ]]; then echo "failed to copy: httpReadSeeker: failed open: could not fetch content descriptor (application/vnd.in-toto+json) from remote: not found" >&2; exit 1; fi
    ref="$2"
    if [[ "$ref" == *@sha256:* ]]; then repo="\${ref%@*}"; d="sha256:\${ref##*@sha256:}"; printf 'sha256:img%s|%s|<none>|%s|%s|%s|Tugra Agent|1000|0\\n' "\${d:7:8}" "$repo" "$d" "$SHIM_PULL_VER" "https://github.com/SimerayCom/tugra" >> "$T"
    else repo="\${ref%:*}"; tag="\${ref##*:}"; printf 'sha256:img%s|%s|%s|<none>|%s|%s|Tugra Agent|1000|0\\n' "$tag" "$repo" "$tag" "$SHIM_PULL_VER" "https://github.com/SimerayCom/tugra" >> "$T"; fi
    exit 0 ;;
  tag)
    id="$(resolve "$2")"; [ -n "$id" ] || exit 1
    repo="\${3%:*}"; tag="\${3##*:}"
    awk -F'|' -v i="$id" -v r="$repo" -v t="$tag" 'BEGIN{OFS="|"} $1==i && !d {$2=r; $3=t; $4="<none>"; print; d=1}' "$T" > "$T.t"
    cat "$T.t" >> "$T"; rm -f "$T.t"; exit 0 ;;
  version) printf '%s\\n' "\${SHIM_ARCH:-amd64}"; exit 0 ;;
  compose)
    case "$*" in *" ps -q "*) echo "cid-\${@: -1}"; exit 0 ;; esac
    exit 0 ;;
  inspect) echo healthy; exit 0 ;;
esac
exit 0
`;

function makeShimDir(images: string[]): { dir: string; bin: string; table: string; log: string; env: NodeJS.ProcessEnv; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "img-hk-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), DOCKER_SHIM, { mode: 0o755 });
  chmodSync(join(bin, "docker"), 0o755);
  const table = join(dir, "images");
  writeFileSync(table, images.join("\n") + (images.length ? "\n" : ""));
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  const env = { PATH: `${bin}:${process.env.PATH}`, SHIM_IMAGES: table, SHIM_LOG: log } as NodeJS.ProcessEnv;
  return { dir, bin, table, log, env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
// ID|REPO|TAG|DIGEST|VERSION|SOURCE|TITLE|SIZE|INUSE
const img = (id: string, repo: string, tag: string, digest: string, ver: string, size: number, inuse = 0, src = SRC, title = "Tugra Hub API") =>
  [id, repo, tag, digest, ver, ver ? src : "", ver ? title : "", String(size), String(inuse)].join("|");
const GB = 1024 ** 3;

describe("prune_release_images (the removal itself)", () => {
  it("removes only old Tugra release images, logs each removal and the total freed, keeps in-use ones, and touches nothing foreign", () => {
    const shim = makeShimDir([
      img("sha256:hub11", HUB, "0.1.0-beta.11", "<none>", "0.1.0-beta.11", 3 * GB),
      img("sha256:hub17", HUB, "0.1.0-beta.17", "<none>", "0.1.0-beta.17", 2 * GB, 1), // still used by a container (e.g. the updater) -> refused
      img("sha256:hub18", HUB, "<none>", "sha256:aa18", "0.1.0-beta.18", 3 * GB),
      img("sha256:hub19", HUB, "<none>", "sha256:aa19", "0.1.0-beta.19", 3 * GB),
      img("sha256:web5", WEB, "0.1.0-beta.5", "<none>", "0.1.0-beta.5", 4 * GB),
      img("sha256:dang", "<none>", "<none>", "<none>", "0.1.0-beta.6", 1 * GB, 0, SRC, "Tugra Web"),
      img("sha256:immich", "ghcr.io/immich-app/immich-server", "release", "<none>", "", 9 * GB),
      img("sha256:pg", "postgres", "16-alpine", "<none>", "", 1 * GB),
    ]);
    try {
      const r = spawnSync(BASH, ["-c", `log() { echo "$*"; }; . "${IMAGES_SH}"; prune_release_images 0.1.0-beta.19 0.1.0-beta.18`], { encoding: "utf8", env: shim.env });
      expect(r.status).toBe(0);
      const rmis = readFileSync(shim.log, "utf8").split("\n").filter((l) => l.startsWith("docker rmi "));
      // exactly the old Tugra images (by ref, then the id), nothing else
      expect(rmis.sort()).toEqual(
        ["docker rmi sha256:dang", "docker rmi sha256:hub11", "docker rmi sha256:hub17", "docker rmi sha256:web5", `docker rmi ${HUB}:0.1.0-beta.11`, `docker rmi ${HUB}:0.1.0-beta.17`, `docker rmi ${WEB}:0.1.0-beta.5`, "docker rmi sha256:dang"].sort(),
      );
      expect(rmis.join("\n")).not.toMatch(/immich|postgres|hub18|hub19/);
      const left = readFileSync(shim.table, "utf8").split("\n").filter(Boolean).map((l) => l.split("|")[0]).sort();
      expect(left).toEqual(["sha256:hub17", "sha256:hub18", "sha256:hub19", "sha256:immich", "sha256:pg"]);
      // logged: what was freed (3 + 4 + 1 GB = 8.0 GB), what was kept because it is in use
      expect(r.stdout).toContain(`removed ${HUB}:0.1.0-beta.11`);
      expect(r.stdout).toContain("kept " + HUB + ":0.1.0-beta.17");
      expect(r.stdout).toMatch(/removed 3 old Tugra release image\(s\), freed about 8\.0 GB \(kept 0\.1\.0-beta\.19 and 0\.1\.0-beta\.18; 1 in use\)/);
    } finally {
      shim.cleanup();
    }
  });

  it("with nothing old on the host it says so and removes nothing", () => {
    const shim = makeShimDir([img("sha256:hub19", HUB, "0.1.0-beta.19", "<none>", "0.1.0-beta.19", GB), img("sha256:hub18", HUB, "0.1.0-beta.18", "<none>", "0.1.0-beta.18", GB)]);
    try {
      const r = spawnSync(BASH, ["-c", `log() { echo "$*"; }; . "${IMAGES_SH}"; prune_release_images 0.1.0-beta.19 0.1.0-beta.18`], { encoding: "utf8", env: shim.env });
      expect(r.stdout).toContain("no old Tugra release images to remove");
      expect(readFileSync(shim.log, "utf8")).not.toContain("docker rmi");
    } finally {
      shim.cleanup();
    }
  });
});

describe("pull_agent_image (the local agent refresh reference)", () => {
  const D = "a".repeat(64);
  const call = (shim: ReturnType<typeof makeShimDir>, args: string, env: Record<string, string> = {}) =>
    spawnSync(BASH, ["-c", `log() { echo "$*"; }; . "${IMAGES_SH}"; pull_agent_image ${args}`], { encoding: "utf8", env: { ...shim.env, ...env } });
  const calls = (shim: ReturnType<typeof makeShimDir>) => readFileSync(shim.log, "utf8").split("\n").filter(Boolean);

  it("with the signed per-arch digest it pulls <repo>@sha256:<digest> (never the multi-manifest tag), checks the version label, then tags <repo>:<version>", () => {
    const shim = makeShimDir([]);
    try {
      const r = call(shim, `0.2.0 ${D}`, { SHIM_PULL_VER: "0.2.0" });
      expect(r.status).toBe(0);
      const c = calls(shim);
      expect(c).toContain(`docker pull ${AGENT}@sha256:${D}`);
      expect(c.some((l) => l === `docker pull ${AGENT}:0.2.0`)).toBe(false);
      expect(c.some((l) => /^docker compose/.test(l))).toBe(false); // compose pull is what failed on the containerd store
      expect(c.find((l) => l.startsWith("docker tag "))).toMatch(new RegExp(`^docker tag sha256:img\\w+ ${AGENT}:0.2.0$`));
      expect(readFileSync(shim.table, "utf8")).toContain(`|${AGENT}|0.2.0|`);
    } finally {
      shim.cleanup();
    }
  });

  it("an image whose version label is a different release is refused and never tagged", () => {
    const shim = makeShimDir([]);
    try {
      const r = call(shim, `0.2.0 ${D}`, { SHIM_PULL_VER: "0.1.9" });
      expect(r.status).not.toBe(0);
      expect(r.stdout).toContain("reports version '0.1.9', expected 0.2.0");
      expect(calls(shim).some((l) => l.startsWith("docker tag "))).toBe(false);
    } finally {
      shim.cleanup();
    }
  });

  it("without a digest it falls back to a plain `docker pull <repo>:<version>` (still not compose)", () => {
    const shim = makeShimDir([]);
    try {
      expect(call(shim, "0.2.0", { SHIM_PULL_VER: "0.2.0" }).status).toBe(0);
      expect(calls(shim)).toContain(`docker pull ${AGENT}:0.2.0`);
      expect(calls(shim).some((l) => /^docker compose/.test(l))).toBe(false);
      // a malformed digest is ignored the same way
      writeFileSync(shim.log, "");
      expect(call(shim, "0.2.0 nothex", { SHIM_PULL_VER: "0.2.0" }).status).toBe(0);
      expect(calls(shim)).toContain(`docker pull ${AGENT}:0.2.0`);
    } finally {
      shim.cleanup();
    }
  });

  it("a failed pull is a failure (the caller logs it; the update itself is unaffected)", () => {
    const shim = makeShimDir([]);
    try {
      expect(call(shim, `0.2.0 ${D}`, { SHIM_PULL_FAIL: "tugra-agent" }).status).not.toBe(0);
      expect(call(shim, "0.2.0", { SHIM_PULL_FAIL: "tugra-agent" }).status).not.toBe(0);
    } finally {
      shim.cleanup();
    }
  });
});

describe("pull_updater_image (the updater is not pulled through compose either)", () => {
  const UPD = "ghcr.io/simeraycom/tugra-updater";
  const call = (shim: ReturnType<typeof makeShimDir>, args: string, env: Record<string, string> = {}) =>
    spawnSync(BASH, ["-c", `log() { echo "$*"; }; . "${IMAGES_SH}"; pull_updater_image ${args}`], { encoding: "utf8", env: { ...shim.env, ...env } });
  const calls = (shim: ReturnType<typeof makeShimDir>) => readFileSync(shim.log, "utf8").split("\n").filter(Boolean);

  it("is a plain `docker pull <repo>:<version>` (or the exact ref compose resolves), never `docker compose pull`", () => {
    const shim = makeShimDir([]);
    try {
      expect(call(shim, "0.2.0", { SHIM_PULL_VER: "0.2.0" }).status).toBe(0);
      expect(calls(shim)).toEqual([`docker pull ${UPD}:0.2.0`]);
      writeFileSync(shim.log, "");
      expect(call(shim, `0.2.0 mirror.example/tugra-updater:0.2.0`, { SHIM_PULL_VER: "0.2.0" }).status).toBe(0);
      expect(calls(shim)).toEqual(["docker pull mirror.example/tugra-updater:0.2.0"]);
      writeFileSync(shim.log, "");
      expect(call(shim, "0.2.0", { SHIM_PULL_VER: "0.2.0", UPDATER_IMAGE_REPO: "mirror.example/u" }).status).toBe(0);
      expect(calls(shim)).toEqual(["docker pull mirror.example/u:0.2.0"]);
    } finally {
      shim.cleanup();
    }
  });

  it("a failed pull is a failure", () => {
    const shim = makeShimDir([]);
    try {
      expect(call(shim, "0.2.0", { SHIM_PULL_FAIL: "tugra-updater" }).status).not.toBe(0);
    } finally {
      shim.cleanup();
    }
  });

  it("update.sh and install.sh never run `compose pull` for the updater (or the agent)", () => {
    for (const f of ["update.sh", "install.sh"]) {
      const code = readFileSync(join(SCRIPTS, f), "utf8").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
      expect(code).not.toMatch(/compose pull[^\n]*(tugra-updater|agent)/);
    }
    const out = execFileSync(BASH, [UPDATE_SH, "--dry-run", "--job", JSON.stringify({ targetVersion: "0.2.0" })], {
      stdio: "pipe",
      env: { PATH: process.env.PATH, ENV_FILE: join(tmpdir(), "no-such-env-file") } as NodeJS.ProcessEnv,
    }).toString();
    expect(out).toContain(`RUN: docker pull ${UPD}:0.2.0`);
    expect(out).not.toMatch(/pull[^\n]*tugra-updater[^:]/);
  });
});

describe("update.sh --prune-images <version> (the hub bootstrap's cleanup)", () => {
  const dir = mkdtempSync(join(tmpdir(), "update-sh-prune-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const run = (shim: ReturnType<typeof makeShimDir>, envText: string, version: string, extra: Record<string, string> = {}) => {
    const envFile = join(dir, ".env");
    writeFileSync(envFile, envText);
    return spawnSync(BASH, [UPDATE_SH, "--prune-images", version], { encoding: "utf8", env: { ...shim.env, ENV_FILE: envFile, ...extra } as NodeJS.ProcessEnv });
  };

  it("on a stack running <version> it keeps that release and the newest older one on disk, removes the rest and never a foreign image", () => {
    const shim = makeShimDir([
      img("sha256:hub10", HUB, "0.1.0-beta.10", "<none>", "0.1.0-beta.10", GB),
      img("sha256:hub18", HUB, "<none>", "sha256:aa18", "0.1.0-beta.18", GB),
      img("sha256:hub19", HUB, "<none>", "sha256:aa19", "0.1.0-beta.19", GB),
      img("sha256:other", "nginx", "latest", "<none>", "", GB),
    ]);
    try {
      const r = run(shim, "TUGRA_VERSION=0.1.0-beta.19\n", "0.1.0-beta.19");
      expect(r.status).toBe(0);
      const left = readFileSync(shim.table, "utf8");
      expect(left).not.toContain("sha256:hub10");
      for (const keep of ["hub18", "hub19", "nginx"]) expect(left).toContain(keep);
      expect(r.stdout).toMatch(/image cleanup: removed 1 old Tugra release image\(s\), freed about 1\.0 GB/);
    } finally {
      shim.cleanup();
    }
  });

  it("does nothing for a stack on another version, with TUGRA_PRUNE_IMAGES=0, or for a bad version", () => {
    const shim = makeShimDir([img("sha256:hub10", HUB, "0.1.0-beta.10", "<none>", "0.1.0-beta.10", GB)]);
    try {
      expect(run(shim, "TUGRA_VERSION=0.1.0-beta.18\n", "0.1.0-beta.19").status).toBe(1);
      expect(run(shim, "TUGRA_VERSION=0.1.0-beta.19\nTUGRA_PRUNE_IMAGES=0\n", "0.1.0-beta.19").stdout).toContain("image cleanup disabled");
      expect(run(shim, "TUGRA_VERSION=0.1.0-beta.19\n", "1.0; reboot").status).toBe(2);
      expect(readFileSync(shim.table, "utf8")).toContain("sha256:hub10");
      expect(readFileSync(shim.log, "utf8")).not.toContain("docker rmi");
    } finally {
      shim.cleanup();
    }
  });
});

describe("update.sh: agent refresh + image cleanup wiring", () => {
  const dir = mkdtempSync(join(tmpdir(), "update-sh-hk-"));
  const envFile = join(dir, ".env");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const AMD = "1".repeat(64);
  const ARM = "2".repeat(64);
  const dry = (job: Record<string, string>, extra: Record<string, string> = {}, envText = "TUGRA_VERSION=0.1.0\n"): string => {
    writeFileSync(envFile, envText);
    return execFileSync(BASH, [UPDATE_SH, "--dry-run", "--job", JSON.stringify(job)], {
      stdio: "pipe",
      env: { PATH: process.env.PATH, ENV_FILE: envFile, ...extra } as NodeJS.ProcessEnv,
    }).toString();
  };

  it("the job's per-arch agent digest for THIS engine's architecture is what gets pulled; the tag is then pointed at it", () => {
    const job = { targetVersion: "0.2.0", agentAmd64Digest: AMD, agentArm64Digest: ARM };
    const a = dry(job, { DRY_ARCH: "amd64" });
    expect(a).toContain(`docker pull ${AGENT}@sha256:${AMD}`);
    expect(a).not.toContain(ARM);
    const b = dry(job, { DRY_ARCH: "arm64" });
    expect(b).toContain(`docker pull ${AGENT}@sha256:${ARM}`);
    expect(b).not.toContain(AMD);
    expect(b).toContain(`docker tag <that image> ${AGENT}:0.2.0`);
    expect(b.indexOf(`docker pull ${AGENT}@sha256:${ARM}`)).toBeLessThan(b.indexOf("up -d --no-deps agent"));
    expect(b.indexOf("wait up to")).toBeLessThan(b.indexOf(`docker pull ${AGENT}@sha256:${ARM}`)); // only after hub + web are healthy
  });

  it("a job without agent digests (older hub) or with an unusable one pulls the tag with a plain docker pull", () => {
    expect(dry({ targetVersion: "0.2.0" })).toContain(`docker pull ${AGENT}:0.2.0`);
    expect(dry({ targetVersion: "0.2.0", agentAmd64Digest: "xyz" })).toContain(`docker pull ${AGENT}:0.2.0`);
    expect(dry({ targetVersion: "0.2.0", agentArm64Digest: ARM }, { DRY_ARCH: "amd64" })).toContain(`docker pull ${AGENT}:0.2.0`); // wrong arch -> no digest
  });

  it("never runs `compose pull` for the agent, and the 'build agent' fallback has no way to appear", () => {
    const out = dry({ targetVersion: "0.2.0", agentAmd64Digest: AMD });
    expect(out).not.toMatch(/docker compose[^\n]* pull[^\n]*agent/);
    expect(out).not.toContain("build agent");
    const code = readFileSync(UPDATE_SH, "utf8").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(code).not.toMatch(/compose pull[^\n]*agent/);
  });

  it("the image cleanup runs after the status is final and before the updater refresh; TUGRA_PRUNE_IMAGES=0 turns it off", () => {
    const out = dry({ targetVersion: "0.2.0" }, {}, "TUGRA_VERSION=0.1.0\n");
    const done = out.indexOf('"phase":"done"');
    const prune = out.indexOf("remove Tugra release images older than 0.1.0 (keeping 0.2.0 and 0.1.0)");
    expect(done).toBeGreaterThan(-1);
    expect(prune).toBeGreaterThan(done);
    const off = dry({ targetVersion: "0.2.0" }, { TUGRA_PRUNE_IMAGES: "0" });
    expect(off).not.toContain("remove Tugra release images");
    expect(off).toContain("image cleanup disabled");
    expect(dry({ targetVersion: "0.2.0" }, {}, "TUGRA_VERSION=0.1.0\nTUGRA_PRUNE_IMAGES=0\n")).toContain("image cleanup disabled");
  });
});

describe("update.sh end to end with a docker shim: refresh by digest, then prune", () => {
  const dir = mkdtempSync(join(tmpdir(), "update-sh-e2e-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const D = "f".repeat(64);

  it("pulls the agent by platform digest, recreates only the agent, then removes the old releases and keeps current + previous", () => {
    const shim = makeShimDir([
      img("sha256:hub10", HUB, "0.1.0-beta.10", "<none>", "0.1.0-beta.10", 3 * GB),
      img("sha256:hub18", HUB, "<none>", "sha256:aa18", "0.1.0-beta.18", 3 * GB),
      img("sha256:hub19", HUB, "<none>", "sha256:aa19", "0.1.0-beta.19", 3 * GB),
      img("sha256:other", "nginx", "latest", "<none>", "", GB),
    ]);
    try {
      const repo = join(dir, "repo");
      mkdirSync(join(repo, "scripts", "lib"), { recursive: true });
      copyFileSync(UPDATE_SH, join(repo, "scripts", "update.sh"));
      for (const f of ["snapshot.sh", "hostfiles.sh", "images.sh"]) copyFileSync(join(SCRIPTS, "lib", f), join(repo, "scripts", "lib", f));
      const envFile = join(dir, ".env");
      writeFileSync(envFile, "TUGRA_VERSION=0.1.0-beta.18\nPRE_UPDATE_BACKUP=0\n");
      writeFileSync(
        join(shim.bin, "redis-cli"),
        `#!/bin/bash
echo "redis-cli $*" >> "$SHIM_LOG"
case "$*" in
  *BLPOP*) if [ -e "$SHIM_STATE" ]; then exit 1; fi; : > "$SHIM_STATE"; printf 'instance:update:queue\\n{"targetVersion":"0.1.0-beta.19","agentAmd64Digest":"${D}","agentArm64Digest":"${D}"}\\n'; exit 0 ;;
esac
exit 0
`,
        { mode: 0o755 },
      );
      const r = spawnSync(BASH, [join(repo, "scripts", "update.sh"), "--watch"], {
        encoding: "utf8",
        env: { ...shim.env, ENV_FILE: envFile, SHIM_STATE: join(dir, "state"), SHIM_PULL_VER: "0.1.0-beta.19", UPDATE_HEALTH_TIMEOUT: "1", UPDATER_REFRESH_WAIT: "0" } as NodeJS.ProcessEnv,
      });
      const log = readFileSync(shim.log, "utf8");
      expect(log).toContain('"phase":"done"');
      expect(log).toContain(`docker pull ${AGENT}@sha256:${D}`);
      expect(log).toContain("up -d --no-deps agent");
      expect(log).not.toMatch(/docker compose[^\n]* pull[^\n]*agent/);
      // cleanup came after done: only beta.10 (older than the previous release beta.18) went; beta.18/19, nginx, the new agent stay
      expect(log.indexOf('"phase":"done"')).toBeLessThan(log.indexOf("docker rmi "));
      const rmis = log.split("\n").filter((l) => l.startsWith("docker rmi "));
      expect(rmis.join("\n")).toContain("sha256:hub10");
      expect(rmis.join("\n")).not.toMatch(/hub18|hub19|nginx|agent/);
      const left = readFileSync(shim.table, "utf8");
      expect(left).toContain("sha256:hub18");
      expect(left).toContain("sha256:hub19");
      expect(left).toContain("nginx");
      expect(left).not.toContain("sha256:hub10");
      expect(r.stdout + r.stderr).toMatch(/image cleanup: removed 1 old Tugra release image\(s\), freed about 3\.0 GB/);
    } finally {
      shim.cleanup();
    }
  });
});
