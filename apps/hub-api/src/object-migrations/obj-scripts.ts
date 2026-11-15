import { endpointUrlStrict, mcHostEnvFor, shq } from "../backups/destination";
import { BUCKET_RE } from "./dto";

/**
 * Hub-built bash for the object (S3 -> S3) migration. Pure string builders: the agent runs them (capability `backup`)
 * and the runner parses the marker lines they print. Every interpolated value goes through {@link shq} AND is
 * charset-validated first (bucket, glob, id, idx, tag), so a hostile value fails before it reaches a script.
 *
 * Credentials: they exist ONLY in the two `export MC_HOST_*` lines of the prelude and in the helper container's
 * environment (`-e NAME`, never argv, no env-file on disk). The helper is a container of the agent's OWN image
 * (`$TUGRA_AGENT_IMAGE`, the trusted env the agent learned at install/update), run with every capability dropped,
 * a read-only root, a noexec tmpfs, pids/memory limits and NO docker socket / host mount / host network. mc runs via
 * argv; there is no shell inside the helper. mc text never travels raw: it leaves the host base64-wrapped.
 */

export const OBJ_ID_RE = /^[a-z0-9]{20,32}$/; // a cuid
const IDX_MAX = 100_000;
const TAG_RE = /^[A-Za-z0-9._:/@+ -]{1,128}$/;
const GLOB_RE = /^[A-Za-z0-9._*?/ -]{1,200}$/;

export interface ObjS3Side {
  endpoint: string;
  accessKey: string;
  secretKey: string;
}
export interface ObjSides {
  src: ObjS3Side;
  dst: ObjS3Side;
}
export interface ObjStartBucket {
  idx: number;
  src: string;
  dst: string;
  exclude: string[];
}

function assertBucket(b: string): string {
  if (!BUCKET_RE.test(b)) throw new Error("invalid bucket name");
  return b;
}
function assertId(id: string): string {
  if (!OBJ_ID_RE.test(id)) throw new Error("invalid migration id");
  return id;
}
function assertIdx(i: number): number {
  if (!Number.isInteger(i) || i < 0 || i > IDX_MAX) throw new Error("invalid bucket index");
  return i;
}

/** `export MC_HOST_<alias>='<url>'` with the credentials URL-encoded into the userinfo and the whole value shq()-quoted. */
function exportHost(alias: "src" | "dst", s: ObjS3Side): string {
  const raw = mcHostEnvFor(alias, { endpoint: endpointUrlStrict(s.endpoint), accessKey: s.accessKey, secretKey: s.secretKey });
  const eq = raw.indexOf("=");
  return `export ${raw.slice(0, eq)}=${shq(raw.slice(eq + 1))}`;
}

/** Flags of EVERY helper container (foreground and detached). Exported for the hardening assertions in the tests. */
export const HELPER_FLAGS =
  "--pull never --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m --pids-limit 256 --memory 1g --add-host host.docker.internal:host-gateway -e HOME=/tmp -e MC_HOST_src -e MC_HOST_dst";

/** base64-wrap up to 64 KiB of mc text so it can never be interpreted by the transport or the parser. */
const OUT_FN = `out() { printf 'TUGRA_OBJ_OUT %s %s\\n' "$1" "$(head -c 65536 | base64 | tr -d '\\n')"; }`;

/** The shared prelude: strict-ish shell, the trusted agent image, the two credential exports, `mcr` (foreground mc in a
 *  helper) and `out` (base64-wrap up to 64 KiB of mc text so it can never be interpreted by the transport or the parser). */
export function objPrelude(sides: ObjSides): string {
  return [
    "set -u; umask 077",
    'IMG="${TUGRA_AGENT_IMAGE:-}"; [ -n "$IMG" ] || { echo "TUGRA_OBJ_ERR no-agent-image"; exit 3; }',
    exportHost("src", sides.src),
    exportHost("dst", sides.dst),
    `HELPER_FLAGS='${HELPER_FLAGS}'`,
    'mcr() { timeout "${MCT:-120}" docker run --rm -i $HELPER_FLAGS --entrypoint mc "$IMG" "$@"; }',
    OUT_FN,
  ].join("\n");
}

/** 1. Reachability + tool probe. An old agent image without mc prints `TUGRA_OBJ_TOOL mc 0 -` and stops (fail closed). */
export function buildObjProbeScript(sides: ObjSides): string {
  return [
    objPrelude(sides),
    'echo "TUGRA_OBJ_PROBE v1"',
    `VER="$(MCT=30 mcr --version 2>/dev/null | grep -o 'RELEASE\\.[0-9A-Za-z-]*Z' | head -n1)"`,
    '[ -n "$VER" ] || { echo "TUGRA_OBJ_TOOL mc 0 -"; echo "TUGRA_OBJ_PROBE_END"; exit 0; }',
    'echo "TUGRA_OBJ_TOOL mc 1 $VER"',
    "for SIDE in src dst; do",
    "  T0=$(date +%s%3N 2>/dev/null || echo 0)",
    '  LS="$(MCT=60 mcr ls --json "$SIDE" 2>/dev/null)"; RC=$?',
    "  T1=$(date +%s%3N 2>/dev/null || echo 0)",
    '  if [ "$RC" -eq 0 ]; then echo "TUGRA_OBJ_REACH $SIDE ok $((T1-T0))"; else echo "TUGRA_OBJ_REACH $SIDE fail $((T1-T0))"; fi',
    '  printf \'%s\' "$LS" | out "ls_$SIDE"',
    "done",
    // Informational only: mc streams source -> destination through the helper's memory, so the target host's disk is
    // not used by the copy itself. A same-host destination MinIO keeps its data under the docker root.
    'echo "TUGRA_OBJ_DF $(df -k /var/lib/docker 2>/dev/null | awk \'NR==2{print $4}\' || echo -)"',
    'echo "TUGRA_OBJ_PROBE_END"',
  ].join("\n");
}

export interface ObjDuBucket {
  src: string;
  dst: string;
  dstExists: boolean;
}

/** 2. Sizes (du) + read-only config export, per bucket (the hub calls it with <= 3 buckets, 600 s timeout). */
export function buildObjDuScript(sides: ObjSides, buckets: ObjDuBucket[]): string {
  const lines = [objPrelude(sides)];
  for (const b of buckets) {
    const s = assertBucket(b.src);
    const d = assertBucket(b.dst);
    lines.push(
      `MCT=240 mcr du --json ${shq(`src/${s}`)} 2>/dev/null | out ${shq(`du_src_${s}`)}`,
      b.dstExists ? `MCT=240 mcr du --json ${shq(`dst/${d}`)} 2>/dev/null | out ${shq(`du_dst_${s}`)}` : `printf '' | out ${shq(`du_dst_${s}`)}`,
      `MCT=60 mcr version info ${shq(`src/${s}`)} 2>/dev/null | out ${shq(`ver_${s}`)}`,
      `MCT=60 mcr anonymous get-json ${shq(`src/${s}`)} 2>/dev/null | out ${shq(`cfg_policy_${s}`)}`,
      `MCT=60 mcr ilm rule export ${shq(`src/${s}`)} 2>/dev/null | out ${shq(`cfg_ilm_${s}`)}`,
      `MCT=60 mcr tag list --json ${shq(`src/${s}`)} 2>/dev/null | out ${shq(`cfg_tags_${s}`)}`,
      `echo ${shq(`TUGRA_OBJ_DU_BUCKET ${s}`)}`,
    );
  }
  lines.push("echo TUGRA_OBJ_DU_END");
  return lines.join("\n");
}

/** 3. Start (detached) one helper per bucket. `--overwrite` and `--remove` appear ONLY in phase `final` (`--remove` only
 *  when `remove`): a seed copies missing keys only and never clobbers a newer destination object. Excludes only (no
 *  `--include`: not verified to exist for mirror). */
export function buildObjStartScript(
  sides: ObjSides,
  opts: { id: string; phase: "seed" | "final"; remove: boolean; preserve: boolean; buckets: ObjStartBucket[] },
): string {
  const id = assertId(opts.id);
  if (opts.phase !== "seed" && opts.phase !== "final") throw new Error("invalid phase");
  const lines = [objPrelude(sides)];
  for (const b of opts.buckets) {
    const idx = assertIdx(b.idx);
    const src = assertBucket(b.src);
    const dst = assertBucket(b.dst);
    const flags = ["mirror", "--json"];
    if (opts.preserve) flags.push("--preserve");
    if (opts.phase === "final") {
      flags.push("--overwrite");
      if (opts.remove) flags.push("--remove");
    }
    for (const g of b.exclude) {
      if (!GLOB_RE.test(g) || g.includes("..")) throw new Error("invalid exclude glob");
      flags.push("--exclude", shq(g));
    }
    const name = `tugra-objmig-${id}-${idx}`;
    lines.push(
      `docker rm -f ${name} >/dev/null 2>&1 || true`,
      `CID=$(docker run -d --name ${name} --label tugra.role=objmig --label tugra.objmig=${id} --label tugra.objmig.idx=${idx} \\`,
      `  $HELPER_FLAGS --log-driver json-file --log-opt max-size=10m --log-opt max-file=2 --entrypoint mc "$IMG" \\`,
      `  ${flags.join(" ")} ${shq(`src/${src}`)} ${shq(`dst/${dst}`)}) \\`,
      `  && printf 'TUGRA_OBJ_STARTED %s %.12s\\n' ${idx} "$CID" || echo "TUGRA_OBJ_ERR ${idx} run-failed"`,
    );
  }
  lines.push("echo TUGRA_OBJ_START_END");
  return lines.join("\n");
}

/** 4. Poll the helpers. The status script needs no credentials (docker inspect/logs only), so it carries no prelude. */
export function buildObjStatusScript(opts: { id: string; idxs: number[] }): string {
  const id = assertId(opts.id);
  const lines = ["set -u", OUT_FN];
  for (const raw of opts.idxs) {
    const idx = assertIdx(raw);
    const name = `tugra-objmig-${id}-${idx}`;
    lines.push(
      `ST="$(docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' ${name} 2>/dev/null)" || ST="absent 0"`,
      `echo "TUGRA_OBJ_STATE ${idx} $ST"`,
      // progress = the highest cumulative totals among the last lines (mc reports them out of order across workers)
      `docker logs --tail 200 ${name} 2>&1 | awk 'match($0,/"totalCount":[0-9]+/){c=substr($0,RSTART+13,RLENGTH-13)+0; if(c>mc)mc=c} match($0,/"totalSize":[0-9]+/){s=substr($0,RSTART+12,RLENGTH-12)+0; if(s>ms)ms=s} match($0,/"transferred":[0-9]+/){t=substr($0,RSTART+14,RLENGTH-14)+0; if(t>ms)ms=t} END{printf "TUGRA_OBJ_PROG ${idx} %d %d\\n", mc+0, ms+0}'`,
      `docker logs --tail 1 ${name} 2>&1 | out ${shq(`last_${idx}`)}`,
      `E=$(docker logs ${name} 2>&1 | grep -c '"status":"error"' || true); echo "TUGRA_OBJ_ERRS ${idx} \${E:-0}"`,
    );
  }
  lines.push("echo TUGRA_OBJ_STATUS_END");
  return lines.join("\n");
}

/** 5. Verify (`mc diff`): counts are tallied IN the script, so no object key ever leaves the host and a huge diff can
 *  never be truncated into a false "ok". Non-JSON lines and `"status":"error"` lines count as errors; the exit code of mc
 *  itself is reported too. */
export function buildObjDiffScript(sides: ObjSides, buckets: Array<{ src: string; dst: string }>): string {
  const lines = [objPrelude(sides)];
  for (const b of buckets) {
    const s = assertBucket(b.src);
    const d = assertBucket(b.dst);
    lines.push(
      `RES=$(MCT=540 mcr diff --json ${shq(`src/${s}`)} ${shq(`dst/${d}`)} 2>&1 | awk '` +
        `/"status":"error"/{x++; next} /^\\{/ {` +
        `if ($0 ~ /"diff":(5|"only-in-first")/) m++; ` +
        `else if ($0 ~ /"diff":(6|"only-in-second")/) e++; ` +
        `else if ($0 ~ /"diff":(2|3|4|"size"|"type"|"metadata"|"different")/) f++; ` +
        `next} NF {x++} ` +
        `END{printf "%d %d %d %d", m+0, f+0, e+0, x+0}'; echo " \${PIPESTATUS[0]}")`,
      `echo ${shq(`TUGRA_OBJ_DIFF ${s}`)} "$RES"`,
      `MCT=240 mcr du --json ${shq(`src/${s}`)} 2>/dev/null | out ${shq(`du_src_${s}`)}`,
      `MCT=240 mcr du --json ${shq(`dst/${d}`)} 2>/dev/null | out ${shq(`du_dst_${s}`)}`,
    );
  }
  lines.push("echo TUGRA_OBJ_DIFF_END");
  return lines.join("\n");
}

export interface ObjConfigApply {
  /** destination bucket */
  dst: string;
  /** validated JSON document text, already ARN-rewritten for a renamed bucket (<= 64 KiB) */
  policy?: string;
  /** validated lifecycle JSON text (<= 64 KiB) */
  ilm?: string;
  /** validated tag pairs */
  tags?: Array<[string, string]>;
}

/** 6. Apply the exported anonymous policy / lifecycle / tags to the DESTINATION bucket (after the data). Payloads travel
 *  base64-encoded on stdin, never argv. */
export function buildObjConfigApplyScript(sides: ObjSides, items: ObjConfigApply[]): string {
  const lines = [objPrelude(sides)];
  for (const it of items) {
    const d = assertBucket(it.dst);
    if (it.policy !== undefined) {
      lines.push(
        `printf %s ${shq(Buffer.from(it.policy, "utf8").toString("base64"))} | base64 -d | MCT=60 mcr anonymous set-json /dev/stdin ${shq(`dst/${d}`)} >/dev/null 2>&1 && echo ${shq(`TUGRA_OBJ_CFG ${d} policy ok`)} || echo ${shq(`TUGRA_OBJ_CFG ${d} policy fail`)}`,
      );
    }
    if (it.ilm !== undefined) {
      lines.push(
        `printf %s ${shq(Buffer.from(it.ilm, "utf8").toString("base64"))} | base64 -d | MCT=60 mcr ilm rule import ${shq(`dst/${d}`)} >/dev/null 2>&1 && echo ${shq(`TUGRA_OBJ_CFG ${d} ilm ok`)} || echo ${shq(`TUGRA_OBJ_CFG ${d} ilm fail`)}`,
      );
    }
    if (it.tags && it.tags.length) {
      for (const [k, v] of it.tags) if (!TAG_RE.test(k) || !TAG_RE.test(v)) throw new Error("invalid tag");
      const tagArg = it.tags.map(([k, v]) => `${k}=${v}`).join("&");
      lines.push(`MCT=60 mcr tag set ${shq(`dst/${d}`)} ${shq(tagArg)} >/dev/null 2>&1 && echo ${shq(`TUGRA_OBJ_CFG ${d} tag ok`)} || echo ${shq(`TUGRA_OBJ_CFG ${d} tag fail`)}`);
    }
  }
  lines.push("echo TUGRA_OBJ_CFG_END");
  return lines.join("\n");
}

/** 7. Remove the helper container(s) of a migration (all of them, or one bucket's). No credentials needed. */
export function buildObjCleanupScript(id: string, idx?: number): string {
  assertId(id);
  const idxFilter = idx === undefined ? "" : ` --filter label=tugra.objmig.idx=${assertIdx(idx)}`;
  return [`set -u`, `docker ps -aq --filter label=tugra.objmig=${id}${idxFilter} | xargs -r docker rm -f >/dev/null 2>&1 || true`, "echo TUGRA_OBJ_CLEAN_END"].join("\n");
}
