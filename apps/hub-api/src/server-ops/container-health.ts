/**
 * Pure helpers for the container-health poll (crash/OOM notifications). The hub periodically runs a
 * read-only `docker inspect` + bounded `docker events` replay on each server's agent and diffs the result
 * against the persisted ContainerState to fire on a crash/OOM TRANSITION only. No agent/Go change — the
 * script runs over the existing "bulk" capability. Everything here is pure + unit-tested; only the exec is live.
 *
 * Why RestartCount is the crash signal: every Tugra container runs `--restart unless-stopped`, so a crash
 * comes straight back as `running` and the status alone shows nothing. RestartCount is monotonic and bumped
 * ONLY by the daemon's restart policy — a manual/Tugra `docker restart` does NOT bump it — so a delta is a
 * reliable "the process died and was restarted" signal. OOM is attributed from the events replay (primary)
 * or the OOMKilled flag (fallback), never from the exit code (OOM and `docker stop` both exit 137).
 */

export const COOLDOWN_MS = 15 * 60 * 1000; // ≤1 crash-loop alert per container per 15 min (carries total restarts)
const IGNORED_EXIT = new Set([0, 137, 143]); // clean exit, SIGKILL/`docker stop`, SIGTERM — never a "crash" by code

export interface ContainerSnap {
  name: string;
  id: string;
  status: string; // running | exited | restarting | dead | created | paused
  exitCode: number;
  oomKilled: boolean;
  restartCount: number;
  startedAt: string | null;
  finishedAt: string | null;
  health: string | null; // healthy | unhealthy | starting | null
}
export interface DockerEvt {
  ts: number; // epoch seconds
  name: string;
  action: string; // "oom" | "die"
  exitCode: number | null;
}
/** The persisted prior state for a container (ContainerState row), or undefined if never seen. */
export interface PrevState {
  containerId: string;
  restartCount: number;
  finishedAt: string | null;
  lastEventTs: number;
  lastNotifiedKey: string | null;
  lastNotifiedAt: number | null; // epoch ms
  restartCountAtNotify: number;
}
export interface NextState {
  containerId: string;
  status: string;
  exitCode: number;
  oomKilled: boolean;
  restartCount: number;
  startedAt: string | null;
  finishedAt: string | null;
  health: string | null;
  lastEventTs: number;
  lastNotifiedKey: string | null;
  lastNotifiedAt: number | null;
  restartCountAtNotify: number;
}
export type FireKind = "container_crashed" | "container_oom";
export interface DiffResult {
  fire: { type: FireKind; exitCode: number; oomKilled: boolean; restartDelta: number } | null;
  next: NextState;
}

/** The read-only poll script. `sinceEpoch` is the `docker events` cursor (hub-produced integer). TSV output
 *  in two marked sections so a failed/truncated events replay degrades to crash-only rather than failing. */
export function CONTAINER_HEALTH_SCRIPT(sinceEpoch: number): string {
  const since = Math.max(0, Math.floor(sinceEpoch)); // numeric only — no user input is ever interpolated
  return [
    "ids=$(docker ps -aq)",
    "echo '##INSPECT'",
    `[ -z "$ids" ] || docker inspect --format '{{.Name}}\t{{.Id}}\t{{.State.Status}}\t{{.State.ExitCode}}\t{{.State.OOMKilled}}\t{{.RestartCount}}\t{{.State.StartedAt}}\t{{.State.FinishedAt}}\t{{if .State.Health}}{{.State.Health.Status}}{{end}}' $ids`,
    "echo '##EVENTS'",
    `timeout 10 docker events --since ${since} --until $(date +%s) --filter type=container --filter event=oom --filter event=die --format '{{.Time}}\t{{.Actor.Attributes.name}}\t{{.Action}}\t{{.Actor.Attributes.exitCode}}' 2>/dev/null || true`,
  ].join("\n");
}

const ZERO_TIME = "0001-01-01T00:00:00Z"; // docker's "never" timestamp → null
function cleanTime(v: string): string | null {
  const t = (v ?? "").trim();
  return !t || t === ZERO_TIME ? null : t;
}

/** Parse the two-section TSV output. Tolerant: strips leading "/", drops malformed/partial lines, and treats
 *  a missing/empty ##EVENTS section as "no events" (crash detection via RestartCount still works). */
export function parseHealthOutput(out: string): { containers: ContainerSnap[]; events: DockerEvt[]; truncated: boolean } {
  const truncated = out.includes("…(truncated)");
  const inspectIdx = out.indexOf("##INSPECT");
  const eventsIdx = out.indexOf("##EVENTS");
  const inspectBlock = inspectIdx < 0 ? "" : out.slice(inspectIdx + "##INSPECT".length, eventsIdx < 0 ? undefined : eventsIdx);
  const eventsBlock = eventsIdx < 0 ? "" : out.slice(eventsIdx + "##EVENTS".length);

  const containers: ContainerSnap[] = [];
  for (const line of inspectBlock.split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 8) continue; // header/blank/truncated-partial line
    const name = (parts[0] ?? "").replace(/^\//, "").trim();
    if (!name) continue;
    containers.push({
      name,
      id: (parts[1] ?? "").trim(),
      status: (parts[2] ?? "").trim(),
      exitCode: Number.parseInt(parts[3] ?? "", 10) || 0,
      oomKilled: (parts[4] ?? "").trim() === "true",
      restartCount: Number.parseInt(parts[5] ?? "", 10) || 0,
      startedAt: cleanTime(parts[6] ?? ""),
      finishedAt: cleanTime(parts[7] ?? ""),
      health: ((parts[8] ?? "").trim() || null),
    });
  }

  const events: DockerEvt[] = [];
  for (const line of eventsBlock.split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const ts = Number.parseInt(parts[0] ?? "", 10);
    const name = (parts[1] ?? "").replace(/^\//, "").trim();
    const action = (parts[2] ?? "").trim();
    if (!Number.isFinite(ts) || !name || !action) continue;
    const ec = Number.parseInt(parts[3] ?? "", 10);
    events.push({ ts, name, action, exitCode: Number.isFinite(ec) ? ec : null });
  }
  return { containers, events, truncated };
}

/**
 * Decide whether `cur` represents a NEW crash/OOM vs `prev`, and compute the state to persist. Edge-only:
 * fires on a restart-count increase or a fresh death event, never on a steady state. Dedupe via a death key
 * + a per-container cooldown (state still advances during cooldown, so one loop → 1 alert per 15 min with the
 * accumulated restart count). A recreated container (different id) resets the baseline, so a deploy never alerts.
 * STOPPED-app suppression is the caller's job (it knows the app status); this stays pure.
 */
export function diffContainerStates(prev: PrevState | undefined, cur: ContainerSnap, events: DockerEvt[], opts: { now: number }): DiffResult {
  const recreated = !prev || prev.containerId !== cur.id;
  const baseRestart = recreated ? 0 : prev!.restartCount;
  const baseFinished = recreated ? null : prev!.finishedAt;
  const lastEventTs = recreated ? 0 : prev!.lastEventTs;

  // Fresh death events for THIS container, newer than the cursor already consumed.
  const mine = events.filter((e) => e.name === cur.name && e.ts > lastEventTs);
  const maxEventTs = mine.reduce((m, e) => Math.max(m, e.ts), lastEventTs);

  const oomEvent = mine.some((e) => e.action === "oom");
  const oomFallback = cur.oomKilled && cur.finishedAt !== baseFinished && cur.finishedAt !== null;
  const isOom = oomEvent || oomFallback;

  const restartDelta = cur.restartCount - baseRestart;
  const crashByRestart = restartDelta > 0;
  // A container that died non-cleanly and stayed down (restart policy none / foreign) — caught via a die event
  // whose exit code isn't a clean/stop code, now in a terminal state.
  const crashByDie = mine.some((e) => e.action === "die" && e.exitCode != null && !IGNORED_EXIT.has(e.exitCode)) && (cur.status === "exited" || cur.status === "dead");

  let fireKind: FireKind | null = null;
  if (isOom) fireKind = "container_oom";
  else if (crashByRestart || crashByDie) fireKind = "container_crashed";

  // The identity of this death — a new restartCount or a new finishedAt makes a distinct episode.
  const deathKey = `${cur.id}:${cur.restartCount}:${cur.finishedAt ?? ""}`;
  const prevNotifiedKey = recreated ? null : prev!.lastNotifiedKey;
  const prevNotifiedAt = recreated ? null : prev!.lastNotifiedAt;
  const prevRestartAtNotify = recreated ? 0 : prev!.restartCountAtNotify;

  let fire: DiffResult["fire"] = null;
  let lastNotifiedKey = prevNotifiedKey;
  let lastNotifiedAt = prevNotifiedAt;
  let restartCountAtNotify = prevRestartAtNotify;
  if (fireKind) {
    const sameDeath = deathKey === prevNotifiedKey;
    const inCooldown = prevNotifiedAt != null && opts.now - prevNotifiedAt < COOLDOWN_MS;
    if (!sameDeath && !inCooldown) {
      fire = { type: fireKind, exitCode: cur.exitCode, oomKilled: isOom, restartDelta: Math.max(1, cur.restartCount - prevRestartAtNotify) };
      lastNotifiedKey = deathKey;
      lastNotifiedAt = opts.now;
      restartCountAtNotify = cur.restartCount;
    }
    // else: suppressed (same death or within cooldown) — state still advances below so the loop is tracked.
  }

  return {
    fire,
    next: {
      containerId: cur.id,
      status: cur.status,
      exitCode: cur.exitCode,
      oomKilled: cur.oomKilled,
      restartCount: cur.restartCount,
      startedAt: cur.startedAt,
      finishedAt: cur.finishedAt,
      health: cur.health,
      lastEventTs: maxEventTs,
      lastNotifiedKey,
      lastNotifiedAt,
      restartCountAtNotify,
    },
  };
}
