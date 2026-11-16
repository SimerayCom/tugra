/**
 * The same-host migrator launcher (the `agent` source runner): hub-built scripts that start, observe and stop the
 * one-click migrator on the host the Tugra agent runs on (a same-host takeover: the target IS the source host).
 *
 * The launcher reuses the hub's own `GET /install/migrator.sh` (fetched from the hub that minted the token), so the hardened
 * `docker run` of the migrator (cap-drop ALL, read-only, tmpfs spool, the socket as the only mount, a memory cap) has a
 * single source of truth. What this file adds is only the unattended, detached, resumable wrapper:
 *
 *  - the migration token is written ONCE to a 0600 file in a 0700 run directory; the detached runner reads it into its
 *    own shell variable, deletes the file, and hands it to `migrator.sh` through the ENVIRONMENT of that one process.
 *    It is on NO docker / migrator / curl argv. (The agent executes a command as `bash -c <script>`, so the script text
 *    itself, which contains the token once, is visible in that shell's argv for the duration of the launch call: the same
 *    exposure class as every hub-built script that carries a database password. The run's token is short-lived, scoped
 *    to one op and revoked when DATA_FINAL ends.)
 *  - the run is idempotent: a second launch for the same (run, attempt) answers `already` and starts nothing,
 *  - the exit code and the single JSON result line land in the run directory, so a hub restart or an agent self-update
 *    never loses the outcome (the migrator CONTAINER keeps running across an agent restart; `status` also looks for it),
 *  - flags are charset-validated words (see `assertSafeFlags`), the hub base is validated like `buildMigrationCommand`.
 */
import { assertSafeBase } from "../../../../importer/migration-command";
import { isMigrationToken } from "../../../../importer/migration-token";
import { assertSafeFlags } from "../data-logic";
import { shq } from "../source-control/source-scripts";

export const MIGRATE_RUN_ROOT = "/etc/tugra/migrate";
/** The migrator.sh container name prefix (`tugra-migrator-$$`). */
export const MIGRATOR_CONTAINER_PREFIX = "tugra-migrator-";

const RUN_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function launcherDir(runId: string, attempt: number, root = MIGRATE_RUN_ROOT): string {
  if (!RUN_ID_RE.test(runId) || !Number.isInteger(attempt) || attempt < 0 || attempt > 9999) throw new Error("invalid launcher id");
  if (!/^\/[A-Za-z0-9._/-]+$/.test(root)) throw new Error("invalid launcher root");
  return `${root}/${runId}-${attempt}`;
}

export interface LaunchInput {
  runId: string;
  attempt: number;
  hubBase: string;
  token: string;
  flags: readonly string[];
  root?: string;
}

const RUN_SH = [
  "#!/bin/sh",
  "# detached runner written by the Tugra hub: reads the token once, drops the file, runs migrator.sh, records the result",
  'D=$1',
  'T=$(cat "$D/tok"); rm -f "$D/tok"',
  "set --",
  'while IFS= read -r f; do set -- "$@" "$f"; done < "$D/flags"',
  'H=$(cat "$D/hub")',
  'TUGRA_MIGRATION_TOKEN=$T sh "$D/migrator.sh" --hub "$H" "$@" >"$D/out" 2>"$D/err" </dev/null',
  'echo $? >"$D/rc"',
];

/** Output marker prefixes. */
export const LAUNCH_MARK = "TUGRA_LAUNCH";
export const MIG_MARK = "TUGRA_MIG";
export const MIG_OUT_MARK = "TUGRA_MIG_OUT";

export function buildLaunchScript(i: LaunchInput): string {
  const dir = launcherDir(i.runId, i.attempt, i.root);
  assertSafeBase(i.hubBase);
  if (!isMigrationToken(i.token)) throw new Error("invalid migration token");
  assertSafeFlags(i.flags);
  const d = shq(dir);
  return [
    "set -u",
    "umask 077",
    `D=${d}`,
    `if [ -e "$D/started" ]; then printf '${LAUNCH_MARK}\\talready\\n'; exit 0; fi`,
    'mkdir -p "$D" && chmod 700 "$D" || { printf \'' + LAUNCH_MARK + "\\tmkdir-failed\\n'; exit 0; }",
    // the ONLY place the token is written: a 0600 file (umask 077), consumed and deleted by the runner
    `printf '%s' ${shq(i.token)} > "$D/tok"`,
    i.flags.length ? `printf '%s\\n' ${i.flags.map(shq).join(" ")} > "$D/flags"` : ': > "$D/flags"',
    `printf '%s' ${shq(i.hubBase)} > "$D/hub"`,
    `if ! curl -fsSL ${shq(`${i.hubBase}/install/migrator.sh`)} -o "$D/migrator.sh"; then rm -f "$D/tok"; printf '${LAUNCH_MARK}\\tfetch-failed\\n'; exit 0; fi`,
    `cat > "$D/run.sh" <<'TUGRA_RUN_EOF'`,
    ...RUN_SH,
    "TUGRA_RUN_EOF",
    ': > "$D/started"',
    'if command -v setsid >/dev/null 2>&1; then setsid sh "$D/run.sh" "$D" >/dev/null 2>&1 </dev/null & else nohup sh "$D/run.sh" "$D" >/dev/null 2>&1 </dev/null & fi',
    'echo $! > "$D/pid"',
    `printf '${LAUNCH_MARK}\\tstarted\\n'`,
    "",
  ].join("\n");
}

/** Read-only: where is the run? `none` (never launched), `running`, `finished <rc>` (+ the result line) or `died`. */
export function buildLauncherStatusScript(runId: string, attempt: number, root?: string): string {
  const dir = launcherDir(runId, attempt, root);
  return [
    "set -u",
    `D=${shq(dir)}`,
    `if [ ! -e "$D/started" ]; then printf '${MIG_MARK}\\tnone\\n'; exit 0; fi`,
    `if [ -f "$D/rc" ]; then`,
    `  printf '${MIG_MARK}\\tfinished\\t%s\\n' "$(cat "$D/rc")"`,
    `  tail -n 1 "$D/out" 2>/dev/null | head -c 65536 | sed 's/^/${MIG_OUT_MARK}\\t/'`,
    "  exit 0",
    "fi",
    "alive=0",
    'if [ -f "$D/pid" ] && kill -0 "$(cat "$D/pid")" 2>/dev/null; then alive=1; fi',
    `if [ "$alive" = 0 ] && [ -n "$(docker ps -q --filter 'name=^${MIGRATOR_CONTAINER_PREFIX}' 2>/dev/null)" ]; then alive=1; fi`,
    `if [ "$alive" = 1 ]; then printf '${MIG_MARK}\\trunning\\n'; else printf '${MIG_MARK}\\tdied\\n'; fi`,
    "",
  ].join("\n");
}

/** Stop only the migrator's OWN containers (`tugra-migrator-*`): it then exits and restarts any source container it stopped. */
export function buildLauncherStopScript(): string {
  return [
    "set -u",
    `for c in $(docker ps -q --filter 'name=^${MIGRATOR_CONTAINER_PREFIX}' 2>/dev/null); do`,
    '  if docker stop -t 30 "$c" >/dev/null 2>&1; then printf \'' + MIG_MARK + "\\tstopped\\n'; else printf '" + MIG_MARK + "\\tfailed\\n'; fi",
    "done",
    `printf '${MIG_MARK}\\tdone\\n'`,
    "",
  ].join("\n");
}

// ───────────────────────────── parsing ─────────────────────────────

export interface MigratorResultItem {
  itemRef: string;
  state: string;
  reason: string | null;
}

export interface MigratorResult {
  /** The migrator's own exit code (0 ok, 1 partial, 3 auth, 4 unreachable, 5 skew, 6 precondition, 130 interrupted, 2 usage). */
  exit: number;
  code: string;
  counts: Record<string, number>;
  items: MigratorResultItem[];
}

export type LauncherStatus =
  | { state: "none" }
  | { state: "running" }
  | { state: "died" }
  | { state: "finished"; rc: number; result: MigratorResult | null };

export type LaunchOutcome = "started" | "already" | "fetch-failed" | "mkdir-failed" | "unknown";

export function parseLaunchOutput(output: string): LaunchOutcome {
  for (const line of output.split("\n")) {
    const f = line.replace(/\r$/, "").split("\t");
    if (f[0] === LAUNCH_MARK && (f[1] === "started" || f[1] === "already" || f[1] === "fetch-failed" || f[1] === "mkdir-failed")) return f[1];
  }
  return "unknown";
}

const SAFE_WORD = /^[A-Za-z0-9 _.:/-]{0,80}$/;

/** Reduce the migrator's JSON line to the few fields the run uses. Anything unexpected is dropped; text is charset-limited. */
export function parseMigratorResult(line: string): MigratorResult | null {
  let j: unknown;
  try {
    j = JSON.parse(line);
  } catch {
    return null;
  }
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  if (o.tool !== "tugra-migrate" || typeof o.exit !== "number" || !Number.isInteger(o.exit)) return null;
  const counts: Record<string, number> = {};
  if (o.counts && typeof o.counts === "object") {
    for (const [k, v] of Object.entries(o.counts as Record<string, unknown>)) if (/^[a-zA-Z]{1,20}$/.test(k) && typeof v === "number" && Number.isFinite(v)) counts[k] = v;
  }
  const items: MigratorResultItem[] = [];
  if (Array.isArray(o.items)) {
    for (const it of o.items.slice(0, 2000)) {
      if (!it || typeof it !== "object") continue;
      const r = it as Record<string, unknown>;
      if (typeof r.itemRef !== "string" || r.itemRef.length > 256 || typeof r.state !== "string" || !SAFE_WORD.test(r.state)) continue;
      items.push({ itemRef: r.itemRef, state: r.state, reason: typeof r.reason === "string" && SAFE_WORD.test(r.reason) ? r.reason : null });
    }
  }
  return { exit: o.exit, code: typeof o.code === "string" && SAFE_WORD.test(o.code) ? o.code : "unknown", counts, items };
}

export function parseLauncherStatus(output: string): LauncherStatus {
  let state: "none" | "running" | "died" | "finished" | null = null;
  let rc: number | null = null;
  let out: string | null = null;
  for (const line of output.split("\n")) {
    const raw = line.replace(/\r$/, "");
    const f = raw.split("\t");
    if (f[0] === MIG_OUT_MARK) {
      out = raw.slice(MIG_OUT_MARK.length + 1);
    } else if (f[0] === MIG_MARK) {
      if (f[1] === "finished" && /^[0-9]{1,3}$/.test(f[2] ?? "")) {
        state = "finished";
        rc = Number(f[2]);
      } else if (f[1] === "none" || f[1] === "running" || f[1] === "died") state = f[1];
    }
  }
  if (state === "finished" && rc !== null) return { state, rc, result: out ? parseMigratorResult(out) : null };
  if (state === "none" || state === "running" || state === "died") return { state };
  return { state: "died" }; // an unreadable answer is never "still running"
}
