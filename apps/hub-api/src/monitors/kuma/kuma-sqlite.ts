import { assertValidContainerRef } from "../../migrator/discover-script";
import { dumpFromRows, KumaParseError, type KumaDump } from "./kuma-model";

/**
 * Reading Uptime Kuma's database from a host the agent manages.
 *
 * Nothing is installed and nothing is written: the hub sends the agent a read-only shell script that (1) finds the
 * Kuma container and its data mount, then (2) runs ONE throw-away container from a SQLite CLI image with no network,
 * a read-only root, all capabilities dropped and the Kuma data mounted read-only. Inside it, kuma.db (+ its WAL) is
 * copied to a small tmpfs and queried there, so the live database is never opened for writing and recent writes that
 * only exist in the WAL are still seen. The three tables come back as JSON between marker lines; the rest of the
 * output (image pull progress and the like) is ignored.
 */

export const DEFAULT_SQLITE_IMAGE = "keinos/sqlite3@sha256:9064091a943982e2a90f095219d0d6adec03472f9042529563e3e66c9632af66"; // sqlite 3.54.1, pinned by digest

/** Image reference: repo[:tag][@sha256:digest], shell-safe (the value is interpolated into a script). */
const IMAGE_RE = /^[a-z0-9][a-z0-9._/-]{0,127}(:[A-Za-z0-9._-]{1,128})?(@sha256:[a-f0-9]{64})?$/;

export function assertSafeImage(image: string): string {
  if (!IMAGE_RE.test(image)) throw new Error("invalid sqlite image reference");
  return image;
}

export const NO_DOCKER = "TUGRA_NO_DOCKER";
export const MARK_DETECT = "TUGRA_KUMA|";
const MARK = {
  gone: "TUGRA_KUMA_GONE",
  notKuma: "TUGRA_KUMA_NOT_KUMA",
  noData: "TUGRA_KUMA_NO_DATA",
  noDb: "TUGRA_KUMA_NO_DB",
  copyFailed: "TUGRA_KUMA_COPY_FAILED",
  sqlError: "TUGRA_KUMA_SQL_ERROR",
  skippedWal: "TUGRA_KUMA_WAL_SKIPPED",
  begin: "TUGRA_KUMA_BEGIN ",
  end: "TUGRA_KUMA_END ",
} as const;

/** List containers whose image is Uptime Kuma, with the host side of their /app/data mount. */
export function buildDetectScript(): string {
  return [
    `if ! command -v docker >/dev/null 2>&1; then echo ${NO_DOCKER}; exit 0; fi`,
    "for id in $(docker ps -aq 2>/dev/null); do",
    "  img=$(docker inspect --format '{{.Config.Image}}' \"$id\" 2>/dev/null)",
    '  case "$img" in',
    "    *uptime-kuma*)",
    `      docker inspect --format '${MARK_DETECT}{{.Name}}|{{.Config.Image}}|{{.State.Status}}|{{range .Mounts}}{{if eq .Destination "/app/data"}}yes{{end}}{{end}}' "$id" 2>/dev/null ;;`,
    "  esac",
    "done",
  ].join("\n");
}

export interface DetectedKuma {
  /** Container name without the leading slash (usable as a container reference). */
  container: string;
  image: string;
  state: string;
  /** The container has a /app/data mount we can read. */
  hasData: boolean;
}

export function parseDetect(output: string): { noDocker: boolean; found: DetectedKuma[] } {
  if (output.includes(NO_DOCKER)) return { noDocker: true, found: [] };
  const found: DetectedKuma[] = [];
  for (const line of output.split("\n")) {
    const at = line.indexOf(MARK_DETECT);
    if (at === -1) continue;
    const [name, image, state, data] = line.slice(at + MARK_DETECT.length).trim().split("|");
    const container = (name ?? "").replace(/^\//, "");
    if (!container || !image) continue;
    try {
      assertValidContainerRef(container);
    } catch {
      continue; // a name we could not pass safely back into a script is not offered
    }
    found.push({ container, image, state: state ?? "", hasData: data === "yes" });
  }
  return { noDocker: false, found };
}

/**
 * The read-only dump script for ONE container. The container reference is validated, and the script re-derives the
 * data mount itself from `docker inspect` (never from caller input) and re-checks that the container really runs a
 * Kuma image before mounting anything.
 */
export function buildDumpScript(container: string, image: string): string {
  assertValidContainerRef(container);
  assertSafeImage(image);
  const tables: Array<[string, string]> = [
    ["monitor", "SELECT * FROM monitor"],
    ["notification", "SELECT * FROM notification"],
    ["link", "SELECT * FROM monitor_notification"],
  ];
  const inner = [
    `if [ ! -f /data/kuma.db ]; then echo ${MARK.noDb}; exit 0; fi`,
    `cp /data/kuma.db /work/kuma.db 2>/dev/null || { echo ${MARK.copyFailed}; exit 0; }`,
    `[ -f /data/kuma.db-wal ] && { cp /data/kuma.db-wal /work/kuma.db-wal 2>/dev/null || echo ${MARK.skippedWal}; }`,
    ...tables.flatMap(([name, sql]) => [
      `echo "${MARK.begin}${name}"`,
      `sqlite3 -json /work/kuma.db "${sql}" 2>/dev/null || echo ${MARK.sqlError}`,
      `echo "${MARK.end}${name}"`,
    ]),
  ].join("\n");
  return [
    `if ! command -v docker >/dev/null 2>&1; then echo ${NO_DOCKER}; exit 0; fi`,
    `ref=${container}`,
    `img=$(docker inspect --format '{{.Config.Image}}' "$ref" 2>/dev/null) || { echo ${MARK.gone}; exit 0; }`,
    `case "$img" in *uptime-kuma*) ;; *) echo ${MARK.notKuma}; exit 0 ;; esac`,
    `src=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{if eq .Type "volume"}}{{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}' "$ref" 2>/dev/null)`,
    `[ -n "$src" ] || { echo ${MARK.noData}; exit 0; }`,
    "inner=$(cat <<'TUGRA_KUMA_EOF'",
    inner,
    "TUGRA_KUMA_EOF",
    ")",
    // read-only data, no network, no extra privileges: the helper can neither change Kuma nor reach anything.
    `docker run --rm --network none --read-only --user 0:0 --cap-drop ALL --cap-add DAC_READ_SEARCH --security-opt no-new-privileges --pids-limit 64 --memory 512m --tmpfs /work:rw,size=1g -v "$src:/data:ro" --entrypoint sh ${image} -c "$inner" 2>&1`,
  ].join("\n");
}

export type DumpFailure = "no_docker" | "gone" | "not_kuma" | "no_data" | "no_sqlite" | "copy_failed" | "sql_error" | "empty" | "unreadable";

export class KumaDumpError extends Error {
  constructor(readonly failure: DumpFailure) {
    super(failure);
  }
}

function section(output: string, name: string): string | null {
  const begin = output.indexOf(`${MARK.begin}${name}`);
  if (begin === -1) return null;
  const from = output.indexOf("\n", begin);
  const end = output.indexOf(`${MARK.end}${name}`, from === -1 ? begin : from);
  if (from === -1 || end === -1) return null;
  return output.slice(from + 1, end);
}

function rows(text: string | null): unknown {
  const t = (text ?? "").trim();
  if (!t) return [];
  const first = t.indexOf("[");
  const last = t.lastIndexOf("]");
  if (first === -1 || last < first) throw new KumaDumpError("unreadable");
  try {
    return JSON.parse(t.slice(first, last + 1));
  } catch {
    throw new KumaDumpError("unreadable");
  }
}

/** Turn the dump script's output into the normalised dump, or throw {@link KumaDumpError} with the reason. */
export function parseDump(output: string): KumaDump {
  if (output.includes(NO_DOCKER)) throw new KumaDumpError("no_docker");
  if (output.includes(MARK.gone)) throw new KumaDumpError("gone");
  if (output.includes(MARK.notKuma)) throw new KumaDumpError("not_kuma");
  if (output.includes(MARK.noData)) throw new KumaDumpError("no_data");
  if (output.includes(MARK.noDb)) throw new KumaDumpError("no_sqlite");
  if (output.includes(MARK.copyFailed)) throw new KumaDumpError("copy_failed");
  const monitorSection = section(output, "monitor");
  if (monitorSection === null) throw new KumaDumpError("sql_error");
  if (/^\s*TUGRA_KUMA_SQL_ERROR/m.test(monitorSection)) throw new KumaDumpError("sql_error");
  try {
    return dumpFromRows(rows(monitorSection), rows(section(output, "notification")), rows(section(output, "link")));
  } catch (e) {
    if (e instanceof KumaParseError) throw new KumaDumpError("empty");
    throw e;
  }
}
