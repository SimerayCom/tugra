/**
 * Hub-built scripts for the `agent` source controller (same-host takeover: the Tugra agent on the target IS on the
 * source host, under the opt-in `migrate` capability). Pure string builders + parsers; golden-tested and executed for
 * real (against a fake docker) in `source-scripts.spec.ts`.
 *
 * Rules (design section 10, source safety):
 *  - the engine only ever stops RECORDED container ids and starts them again; there is NO `docker rm` / `kill` / `prune`
 *    anywhere in this file (a spec asserts it),
 *  - container identity (id + name + image) is verified before every stop or start; a recreated container with the same
 *    name is a `mismatch`, never touched,
 *  - every value that reaches the shell goes through {@link shq} and was validated before ({@link isHex64}, name/image
 *    charsets), so a hostile source cannot smuggle code into a script the hub runs as root.
 */
import { coolifyRefOf, type CoolifyResourceKind } from "../../../../importer/sources/coolify-control";
import type { RecordedContainer } from "../data-contract";

/** POSIX single-quote a value. */
export const shq = (v: string): string => `'${v.replaceAll("'", "'\\''")}'`;

export const isHex64 = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;
const PORTS_RE = /^[\x20-\x7e]{0,500}$/;

export const SRC_MARK = { ctr: "TUGRA_CTR", stop: "TUGRA_STOP", start: "TUGRA_START", state: "TUGRA_STATE" } as const;

/** Does a container name belong to the Coolify resource `uuid` (exact, `<uuid>-<digits>` deploy suffix, or a service component `<x>-<uuid>`)? */
export function containerNameMatches(name: string, uuid: string, kind: CoolifyResourceKind): boolean {
  if (name === uuid) return true;
  if (name.startsWith(`${uuid}-`) && /^[0-9]{6,}$/.test(name.slice(uuid.length + 1))) return true;
  if (kind === "service" && name.endsWith(`-${uuid}`) && name.length > uuid.length + 1) return true;
  return false;
}

export interface InspectTarget {
  itemRef: string;
}

/** The read-only discovery: every container (any state) whose name belongs to one of the items. */
export function buildSourceInspectScript(items: readonly InspectTarget[]): string {
  const cases: string[] = [];
  for (const it of items) {
    const ref = coolifyRefOf(it.itemRef);
    if (!ref) throw new Error("not a coolify item ref");
    const u = shq(ref.uuid);
    const pats = [u, `${u}-[0-9]*`, ...(ref.kind === "service" ? [`*-${u}`] : [])];
    cases.push(`    ${pats.join("|")}) emit ${shq(it.itemRef)} ;;`);
  }
  return [
    "set -u",
    "emit() { printf 'TUGRA_CTR\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' \"$1\" \"$id\" \"$name\" \"$image\" \"$ports\" \"$state\"; }",
    // `|` (not a tab): read(1) collapses runs of IFS WHITESPACE, which would shift every field after an empty Ports column.
    "docker ps -a --no-trunc --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.Ports}}|{{.State}}' | while IFS='|' read -r id name image ports state; do",
    '  case "$name" in',
    ...cases,
    "  esac",
    "done",
    "",
  ].join("\n");
}

export interface DiscoveredContainer extends RecordedContainer {
  state: string;
}

/** Parse + VALIDATE the discovery output: a line that fails any check is dropped (never trusted). */
export function parseSourceInspect(output: string, items: readonly InspectTarget[]): DiscoveredContainer[] {
  const refs = new Map(items.map((i) => [i.itemRef, coolifyRefOf(i.itemRef)]));
  const out: DiscoveredContainer[] = [];
  const seen = new Set<string>();
  for (const line of output.split("\n")) {
    const f = line.replace(/\r$/, "").split("\t");
    if (f[0] !== SRC_MARK.ctr || f.length !== 7) continue;
    const [, itemRef, id, name, image, ports, state] = f;
    const ref = refs.get(itemRef);
    if (!ref || !isHex64(id) || !NAME_RE.test(name) || !IMAGE_RE.test(image) || !PORTS_RE.test(ports) || !/^[a-z]{3,12}$/.test(state)) continue;
    if (!containerNameMatches(name, ref.uuid, ref.kind) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name, image, ports, itemRef, state });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

function assertRecorded(cs: readonly RecordedContainer[]): void {
  for (const c of cs) if (!isHex64(c.id) || !NAME_RE.test(c.name) || !IMAGE_RE.test(c.image)) throw new Error("invalid recorded container");
}

const IDENT = [
  'ident() { # $1 id $2 name $3 image -> 0 when the container with this id still has this name and image',
  '  cur="$(docker inspect -f \'{{.Name}}\t{{.Config.Image}}\' "$1" 2>/dev/null)" || return 2',
  '  [ "$cur" = "/$2$(printf \'\\t\')$3" ] || return 1',
  "  return 0",
  "}",
];

/** `docker stop` of exactly the recorded containers (never rm / kill). Output: one `TUGRA_STOP\t<id>\t<outcome>` per container. */
export function buildSourceStopScript(containers: readonly RecordedContainer[], graceSec = 120): string {
  assertRecorded(containers);
  if (!Number.isInteger(graceSec) || graceSec < 1 || graceSec > 3600) throw new Error("invalid grace");
  return [
    "set -u",
    ...IDENT,
    "stop_one() {",
    '  ident "$1" "$2" "$3"; r=$?',
    '  [ "$r" = 2 ] && { printf \'TUGRA_STOP\\t%s\\tgone\\n\' "$1"; return; }',
    '  [ "$r" = 1 ] && { printf \'TUGRA_STOP\\t%s\\tmismatch\\n\' "$1"; return; }',
    `  if docker stop -t ${graceSec} "$1" >/dev/null 2>&1; then printf 'TUGRA_STOP\\t%s\\tstopped\\n' "$1"; else printf 'TUGRA_STOP\\t%s\\tfailed\\n' "$1"; fi`,
    "}",
    ...containers.map((c) => `stop_one ${shq(c.id)} ${shq(c.name)} ${shq(c.image)}`),
    "",
  ].join("\n");
}

/** `docker start` of exactly the recorded containers (the abort path). Output: `TUGRA_START\t<id>\t<outcome>`. */
export function buildSourceStartScript(containers: readonly RecordedContainer[]): string {
  assertRecorded(containers);
  return [
    "set -u",
    ...IDENT,
    "start_one() {",
    '  ident "$1" "$2" "$3"; r=$?',
    '  [ "$r" = 2 ] && { printf \'TUGRA_START\\t%s\\tgone\\n\' "$1"; return; }',
    '  [ "$r" = 1 ] && { printf \'TUGRA_START\\t%s\\tmismatch\\n\' "$1"; return; }',
    "  if docker start \"$1\" >/dev/null 2>&1; then printf 'TUGRA_START\\t%s\\tstarted\\n' \"$1\"; else printf 'TUGRA_START\\t%s\\tfailed\\n' \"$1\"; fi",
    "}",
    ...containers.map((c) => `start_one ${shq(c.id)} ${shq(c.name)} ${shq(c.image)}`),
    "",
  ].join("\n");
}

/** Read-only: is each recorded container still running? Output: `TUGRA_STATE\t<id>\ttrue|false|gone|mismatch`. */
export function buildSourceStateScript(containers: readonly RecordedContainer[]): string {
  assertRecorded(containers);
  return [
    "set -u",
    ...IDENT,
    "state_one() {",
    '  ident "$1" "$2" "$3"; r=$?',
    '  [ "$r" = 2 ] && { printf \'TUGRA_STATE\\t%s\\tgone\\n\' "$1"; return; }',
    '  [ "$r" = 1 ] && { printf \'TUGRA_STATE\\t%s\\tmismatch\\n\' "$1"; return; }',
    "  printf 'TUGRA_STATE\\t%s\\t%s\\n' \"$1\" \"$(docker inspect -f '{{.State.Running}}' \"$1\" 2>/dev/null || echo gone)\"",
    "}",
    ...containers.map((c) => `state_one ${shq(c.id)} ${shq(c.name)} ${shq(c.image)}`),
    "",
  ].join("\n");
}

export type StopOutcome = "stopped" | "gone" | "mismatch" | "failed";
export type StartOutcome = "started" | "gone" | "mismatch" | "failed";
export type StateOutcome = "true" | "false" | "gone" | "mismatch";

function parseMarks<T extends string>(output: string, mark: string, allowed: readonly T[], ids: readonly string[]): Map<string, T> {
  const want = new Set(ids);
  const res = new Map<string, T>();
  for (const line of output.split("\n")) {
    const f = line.replace(/\r$/, "").split("\t");
    if (f[0] !== mark || f.length !== 3 || !want.has(f[1]) || !(allowed as readonly string[]).includes(f[2])) continue;
    res.set(f[1], f[2] as T);
  }
  return res;
}

export const parseStopOutput = (o: string, ids: readonly string[]) => parseMarks<StopOutcome>(o, SRC_MARK.stop, ["stopped", "gone", "mismatch", "failed"], ids);
export const parseStartOutput = (o: string, ids: readonly string[]) => parseMarks<StartOutcome>(o, SRC_MARK.start, ["started", "gone", "mismatch", "failed"], ids);
export const parseStateOutput = (o: string, ids: readonly string[]) => parseMarks<StateOutcome>(o, SRC_MARK.state, ["true", "false", "gone", "mismatch"], ids);
