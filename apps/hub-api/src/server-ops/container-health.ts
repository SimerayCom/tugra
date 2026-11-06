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

export const MEM_PRESSURE_PCT = 90; // sustained ≥90% of the cgroup memory limit → a pre-OOM warning
export const MEM_MIN_SAMPLES = 3; // need a few samples so a single 15s spike / page-cache blip can't trip it

/**
 * Decide whether a container is under SUSTAINED memory pressure from its recent `docker stats` memPct
 * samples (oldest→newest). Pure + unit-tested. The caller MUST only pass containers that have a REAL
 * memory limit (a managed app/db with `memoryMb` set) — for an unlimited container `docker stats` reports
 * percent-of-HOST-RAM, which is meaningless as a pre-OOM signal. Requires enough samples AND a high average
 * AND the latest sample still high, so a spike that has already subsided does not alert.
 */
export function memUnderPressure(samplesPct: number[], opts: { thresholdPct?: number; minSamples?: number } = {}): boolean {
  const threshold = opts.thresholdPct ?? MEM_PRESSURE_PCT;
  const minSamples = opts.minSamples ?? MEM_MIN_SAMPLES;
  if (samplesPct.length < minSamples) return false;
  const avg = samplesPct.reduce((a, b) => a + b, 0) / samplesPct.length;
  const latest = samplesPct[samplesPct.length - 1];
  return avg >= threshold && latest >= threshold;
}

/**
 * Human-readable meaning of a container exit code — the headline answer to "why did it die". OOM takes
 * precedence because both OOM and `docker stop` surface as 137, so the flag disambiguates. Pure + unit-tested;
 * used by both the crash notification and the persisted ContainerEvent timeline.
 */
export function explainExit(code: number, oomKilled: boolean): string {
  if (oomKilled) return "Out of memory (OOM-killed)";
  switch (code) {
    case 0: return "Clean exit (0)";
    case 1: return "Application error (1)";
    case 2: return "Shell/usage error (2)";
    case 125: return "Container failed to start (125)";
    case 126: return "Command not executable (126)";
    case 127: return "Command not found (127)";
    case 134: return "Aborted — SIGABRT (134)";
    case 137: return "Killed — SIGKILL / OOM (137)";
    case 139: return "Segmentation fault — SIGSEGV (139)";
    case 143: return "Terminated — SIGTERM (143)";
    default:
      if (code > 128 && code < 165) return `Killed by signal ${code - 128} (${code})`;
      return `Exit code ${code}`;
  }
}

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
  health: string | null; // prior HEALTHCHECK status — needed to detect a healthy→unhealthy transition
  unhealthySince: number | null; // epoch ms the container has been continuously unhealthy (else null)
  healthNotifiedAt: number | null; // epoch ms of the last unhealthy alert — own cooldown, separate from crash
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
  unhealthySince: number | null;
  healthNotifiedAt: number | null;
}
export type FireKind = "container_crashed" | "container_oom" | "container_unhealthy";
/** A distinct crash/OOM episode to append to the ContainerEvent timeline (recorded regardless of the
 *  notification cooldown, so the history is complete even when alerts are throttled). */
export interface RecordableEvent {
  ts: number; // epoch seconds — docker-event time when known, else poll time
  kind: "crash" | "oom";
  exitCode: number;
  oomKilled: boolean;
  restartCount: number;
  restartDelta: number;
  reason: string;
}
export interface DiffResult {
  fire: { type: FireKind; exitCode: number; oomKilled: boolean; restartDelta: number } | null;
  /** An unhealthy-healthcheck alert, fired once on the transition INTO `unhealthy` (independent of a
   *  crash/OOM in the same tick, with its own cooldown). */
  healthFire: { type: "container_unhealthy"; unhealthySince: number | null } | null;
  event: RecordableEvent | null;
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
  let event: DiffResult["event"] = null;
  let lastNotifiedKey = prevNotifiedKey;
  let lastNotifiedAt = prevNotifiedAt;
  let restartCountAtNotify = prevRestartAtNotify;
  if (fireKind) {
    // Timeline event — one per tick-with-change, independent of the notification cooldown.
    event = {
      ts: mine.length ? maxEventTs : Math.floor(opts.now / 1000),
      kind: isOom ? "oom" : "crash",
      exitCode: cur.exitCode,
      oomKilled: isOom,
      restartCount: cur.restartCount,
      restartDelta: Math.max(0, restartDelta),
      reason: explainExit(cur.exitCode, isOom),
    };
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

  // Unhealthy-healthcheck alert — ORTHOGONAL to crash/OOM. Fire once on the transition INTO `unhealthy`
  // (prev was healthy/starting/null/unknown), deduped by its OWN cooldown so a flapping healthcheck can't
  // spam. Docker's HEALTHCHECK retries already debounce `unhealthy` (N consecutive probe failures), so the
  // transition is a real signal. `unhealthySince` tracks the continuous-unhealthy start (cleared on recovery).
  const prevUnhealthySince = recreated ? null : prev!.unhealthySince;
  const prevHealthNotifiedAt = recreated ? null : prev!.healthNotifiedAt;
  const isUnhealthy = cur.health === "unhealthy";
  // `unhealthySince` marks the start of the CURRENT continuous-unhealthy episode (carried across ticks,
  // cleared on recovery). A recreated container (new id) resets it, so a fresh container's clock starts now.
  const unhealthySince = isUnhealthy ? (prevUnhealthySince ?? opts.now) : null;
  let healthNotifiedAt = prevHealthNotifiedAt;
  let healthFire: DiffResult["healthFire"] = null;
  if (isUnhealthy && unhealthySince != null) {
    // Fire once per EPISODE, not merely on the healthy→unhealthy edge: the episode is "already alerted" only
    // if the last alert happened at/after it began. So a transition that was suppressed by the cooldown (a
    // quick flap) still fires on the first tick after the cooldown expires while the container stays unhealthy
    // — otherwise a flap-then-stuck container would stay broken for hours with no alert. A genuine continuous
    // episode alerts exactly once (no 15-min nagging), unlike a crash LOOP whose every restart is a new death.
    const episodeAlreadyAlerted = prevHealthNotifiedAt != null && prevHealthNotifiedAt >= unhealthySince;
    const inHealthCooldown = prevHealthNotifiedAt != null && opts.now - prevHealthNotifiedAt < COOLDOWN_MS;
    if (!episodeAlreadyAlerted && !inHealthCooldown) {
      healthFire = { type: "container_unhealthy", unhealthySince };
      healthNotifiedAt = opts.now;
    }
  }

  return {
    fire,
    healthFire,
    event,
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
      unhealthySince,
      healthNotifiedAt,
    },
  };
}
