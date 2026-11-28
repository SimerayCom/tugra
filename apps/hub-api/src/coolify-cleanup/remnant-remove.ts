import type { CleanupRemnant, CleanupResult, CleanupResultCode } from "@tugra/shared";
import { CLEANUP_RESULT_CODES } from "@tugra/shared";
import { COOLIFY_IMAGE_RE, COOLIFY_NETWORKS, COOLIFY_ROOT, CONTROL_PLANE_CONTAINERS, DATA_DIRECTORIES, OWN_DIRECTORIES, UUID_RE } from "./remnant-scan";

/**
 * Removal of the Coolify leftovers the owner confirmed (Coolify hub takeover, lane G). The script is generated from a validated list,
 * checks every object AGAIN on the host before touching it, and can only do five things: `docker rm` a Coolify container, `docker
 * network rm` an empty Coolify network, `docker rmi` a Coolify image, `rm -rf` a validated directory under /data/coolify, and `rmdir`
 * the empty parents. It never passes -v to docker rm, never removes a volume, never prunes, never uses -f on an image, and never
 * touches a directory a container still mounts.
 */

export const REMOVE_DONE = "TUGRA_CU_DONE";
const RESULT_TAG = "TUGRA_CU_R";
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const DIR_RE = new RegExp(
  `^${COOLIFY_ROOT}/(?:(?:${OWN_DIRECTORIES.map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})|(?:applications|services)/[A-Za-z0-9_-]{1,64})$`,
);

export class UnsafeRemnantError extends Error {
  constructor(readonly kind: string) {
    super(`unsafe remnant: ${kind}`);
  }
}

/** Single-quote for sh. Inputs are validated first; this is a second line. */
const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** Throws UnsafeRemnantError for anything outside the allow-list: a hub bug must never reach a host. */
export function assertRemovable(r: CleanupRemnant): void {
  if (r.keep) throw new UnsafeRemnantError(r.kind);
  if (r.kind === "container" && NAME_RE.test(r.name) && !CONTROL_PLANE_CONTAINERS.includes(r.name)) return;
  if (r.kind === "network" && NAME_RE.test(r.name) && (COOLIFY_NETWORKS.includes(r.name) || UUID_RE.test(r.name))) return;
  if (r.kind === "image" && COOLIFY_IMAGE_RE.test(r.name)) return;
  if (r.kind === "directory" && DIR_RE.test(r.name) && !DATA_DIRECTORIES.some((d) => r.name.startsWith(`${COOLIFY_ROOT}/${d}`))) return;
  throw new UnsafeRemnantError(r.kind);
}

// Each kind of object is handled by ONE shell function (defined once), and every item is a single call line: the script stays a few
// dozen bytes per item, so a large fleet's list never nears the kernel's per-argument limit the wrapper has to fit under.
const CONTAINER_FN = [
  "rm_container() {",
  '  n="$1"',
  '  if ! docker inspect "$n" >/dev/null 2>&1; then r container "$n" absent; return; fi',
  `  img=$(docker inspect -f '{{.Config.Image}}' "$n" 2>/dev/null); lbl=$(docker inspect -f '{{index .Config.Labels "coolify.managed"}}' "$n" 2>/dev/null); run=$(docker inspect -f '{{.State.Running}}' "$n" 2>/dev/null)`,
  "  own=0",
  `  [ "$n" = 'coolify-proxy' ] && own=1`,
  `  sent=0; if [ "$n" = 'coolify-sentinel' ]; then sent=1; fi; case "$img" in *coollabsio/sentinel*) sent=1;; esac`,
  '  [ "$sent" = 1 ] && own=1',
  "  case \"$img\" in *coollabsio/coolify-helper*) own=1;; esac",
  '  [ "$lbl" = "true" ] && own=1',
  '  if [ "$own" != 1 ]; then r container "$n" refused',
  '  elif [ "$run" = "true" ] && [ "$sent" != 1 ]; then r container "$n" running',
  '  elif [ "$sent" = 1 ] && [ "$run" = "true" ]; then if docker rm -f "$n" >/dev/null 2>&1; then r container "$n" ok; else r container "$n" failed; fi',
  '  elif docker rm "$n" >/dev/null 2>&1; then r container "$n" ok; else r container "$n" failed; fi',
  "}",
].join("\n");

const NETWORK_FN = [
  "rm_network() {",
  '  n="$1"',
  '  if ! docker network inspect "$n" >/dev/null 2>&1; then r network "$n" absent; return; fi',
  `  c=$(docker network inspect -f '{{len .Containers}}' "$n" 2>/dev/null)`,
  '  if [ "${c:-1}" != "0" ]; then r network "$n" in_use',
  '  elif docker network rm "$n" >/dev/null 2>&1; then r network "$n" ok; else r network "$n" failed; fi',
  "}",
].join("\n");

const IMAGE_FN = [
  "rm_image() {",
  '  n="$1"',
  '  if ! docker image inspect "$n" >/dev/null 2>&1; then r image "$n" absent',
  '  elif docker rmi "$n" >/dev/null 2>&1; then r image "$n" ok',
  '  else r image "$n" in_use; fi', // docker refuses to remove an image a container uses: that is the guard, no -f
  "}",
].join("\n");

const DIRECTORY_FN = [
  "rm_directory() {",
  '  p="$1"',
  '  if [ -L "$p" ]; then r directory "$p" refused; return; fi',
  '  if [ ! -e "$p" ]; then r directory "$p" absent; return; fi',
  '  real=$(cd -P "$p" 2>/dev/null && pwd -P)',
  '  if [ "$real" != "$p" ]; then r directory "$p" refused',
  '  elif mounted "$p"; then r directory "$p" mounted',
  '  elif hasdata "$p"; then r directory "$p" refused',
  '  elif rm -rf -- "$p" 2>/dev/null && [ ! -e "$p" ]; then r directory "$p" ok',
  '  else r directory "$p" failed; fi',
  "}",
].join("\n");

/** The removal script for a validated list (containers first, then networks, images, directories). */
export function buildRemoveScript(items: readonly CleanupRemnant[]): string {
  for (const i of items) assertRemovable(i);
  const by = (k: CleanupRemnant["kind"]) => items.filter((i) => i.kind === k).map((i) => i.name);
  return [
    "#!/bin/sh",
    "# Tugra: remove the Coolify leftovers the owner confirmed. Every object is checked again here first.",
    `command -v docker >/dev/null 2>&1 || { echo "${RESULT_TAG}|all|-|failed"; echo ${REMOVE_DONE}; exit 0; }`,
    `r() { echo "${RESULT_TAG}|$1|$2|$3"; }`,
    // The bind sources of every container (running or stopped) as they are BEFORE anything is removed: a stopped container removed by this
    // very script must still protect the directory it mounted.
    `SNAP=$(for id in $(docker ps -aq 2>/dev/null); do docker inspect -f '{{range .Mounts}}{{.Source}} {{end}}' "$id" 2>/dev/null; done)`,
    // Is any container still mounting this directory, or a parent or a child of it (now, or at the start of this run)?
    `mounted() {`,
    `  d="$1"`,
    `  for s in $SNAP $(for id in $(docker ps -aq 2>/dev/null); do docker inspect -f '{{range .Mounts}}{{.Source}} {{end}}' "$id" 2>/dev/null; done); do`,
    `    case "$s" in "$d"|"$d"/*) return 0;; esac`,
    `    case "$d" in "$s"/*) return 0;; esac`,
    `  done`,
    `  return 1`,
    `}`,
    // A resource directory holding anything besides compose files and .env is the owner's data (an unreadable one counts as data).
    `hasdata() {`,
    `  case "$1" in ${COOLIFY_ROOT}/applications/*|${COOLIFY_ROOT}/services/*)`,
    `    { [ -r "$1" ] && [ -x "$1" ]; } || return 0`,
    `    [ -n "$(find "$1" -mindepth 1 ! -type d ! -name docker-compose.yaml ! -name docker-compose.yml ! -name .env 2>/dev/null | head -n 1)" ];;`,
    `  *) return 1;;`,
    `  esac`,
    `}`,
    CONTAINER_FN,
    NETWORK_FN,
    IMAGE_FN,
    DIRECTORY_FN,
    ...by("container").map((n) => `rm_container ${q(n)}`),
    ...by("network").map((n) => `rm_network ${q(n)}`),
    ...by("image").map((n) => `rm_image ${q(n)}`),
    ...by("directory").map((n) => `rm_directory ${q(n)}`),
    // Empty parents only: rmdir refuses a directory that still holds anything.
    `rmdir ${COOLIFY_ROOT}/applications ${COOLIFY_ROOT}/services ${COOLIFY_ROOT} 2>/dev/null || true`,
    `echo ${REMOVE_DONE}`,
    "",
  ].join("\n");
}

/** Parse the result lines. A listed item with no result line (cut output) is `failed`: unknown is never "ok". */
export function parseRemoveOutput(output: string, items: readonly CleanupRemnant[]): CleanupResult[] {
  const done = output.includes(REMOVE_DONE);
  const seen = new Map<string, CleanupResultCode>();
  for (const line of output.split("\n")) {
    if (!line.startsWith(`${RESULT_TAG}|`)) continue;
    const [, kind, nameRaw, code] = line.replace(/\r$/, "").split("|");
    if (!kind || !nameRaw || !code) continue;
    const name = nameRaw.replace(/^'(.*)'$/, "$1");
    if ((CLEANUP_RESULT_CODES as readonly string[]).includes(code.trim())) seen.set(`${kind}:${name}`, code.trim() as CleanupResultCode);
  }
  return items.map((i) => ({ kind: i.kind, name: i.name, code: done ? (seen.get(`${i.kind}:${i.name}`) ?? "failed") : "failed" }));
}
