import net from "node:net";
import type { Monitor } from "@prisma/client";

export interface CheckResult {
  up: boolean;
  ms: number;
  msg: string;
}

export type Checker = (monitor: Monitor) => Promise<CheckResult>;

export const httpCheck: Checker = async (m) => {
  const start = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), m.timeoutMs);
  try {
    const res = await fetch(m.target, { signal: ctrl.signal, redirect: "follow" });
    clearTimeout(timer);
    return {
      up: res.status >= 200 && res.status < 400,
      ms: Date.now() - start,
      msg: `HTTP ${res.status}`,
    };
  } catch (e) {
    clearTimeout(timer);
    return {
      up: false,
      ms: Date.now() - start,
      msg: e instanceof Error ? e.message : "request failed",
    };
  }
};

export const tcpCheck: Checker = (m) =>
  new Promise<CheckResult>((resolve) => {
    const start = Date.now();
    const [host, portStr] = m.target.split(":");
    const sock = net.connect({ host, port: Number(portStr) });
    const done = (up: boolean, msg: string) => {
      sock.destroy();
      resolve({ up, ms: Date.now() - start, msg });
    };
    sock.setTimeout(m.timeoutMs);
    sock.once("connect", () => done(true, "connected"));
    sock.once("timeout", () => done(false, "timeout"));
    sock.once("error", (e) => done(false, e.message));
  });

export const checkers: Record<string, Checker> = {
  HTTP: httpCheck,
  TCP: tcpCheck,
};

export type MetricKind = "DISK" | "CPU" | "MEM";

export interface MetricSampleLite {
  cpu: number;
  memUsed: number;
  memTotal: number;
  diskUsed: number;
  diskTotal: number;
}

/**
 * Evaluate a server metric against a threshold. Pure (no DB) so it's unit-testable; the runner fetches the
 * latest sample and passes it in with its timestamp. A metric monitor can only CONFIRM health from a RECENT
 * sample, so a stale/absent sample counts as a FAILED check — never a recovery (the old code read the latest
 * row with no freshness gate, so a stale low row could flip a DOWN monitor back to UP, and after the 48h
 * retention purge an absent row did the same). `freshness` is optional for backward compatibility — when the
 * caller omits the timestamp, the behaviour is the original pure threshold check.
 */
export function metricCheckResult(
  kind: MetricKind,
  sample: MetricSampleLite | null,
  thresholdPct: number,
  freshness?: { ts?: number | Date | null; now?: number; maxAgeMs?: number; noDataIsDown?: boolean },
): CheckResult {
  if (!sample) {
    // No sample row. A monitor that is already alarming must NOT "recover" from the ABSENCE of data (e.g. after
    // the retention purge deletes a silent agent's rows). Only a monitor that has never seen a sample stays UP
    // ("no metrics yet"), so a just-created monitor doesn't false-alarm before the first sample arrives.
    if (freshness?.noDataIsDown) return { up: false, ms: 0, msg: "no metrics (agent not reporting)" };
    return { up: true, ms: 0, msg: "no metrics yet" };
  }
  // Freshness gate (active whenever the caller asks for it — i.e. supplies now + maxAgeMs; omitting the whole
  // `freshness` arg keeps the legacy pure-threshold behaviour for old callers). A sample that is stale,
  // future-dated (clock skew), or of unknown age can't confirm the resource is below the threshold RIGHT NOW,
  // so it counts as a failure, never a recovery. Fail CLOSED on a bad timestamp, not open.
  if (freshness && freshness.now != null && freshness.maxAgeMs != null) {
    const tsMs = freshness.ts instanceof Date ? freshness.ts.getTime() : freshness.ts != null ? Number(freshness.ts) : NaN;
    if (!Number.isFinite(tsMs)) return { up: false, ms: 0, msg: "unknown sample age" };
    const age = freshness.now - tsMs;
    if (age > freshness.maxAgeMs) return { up: false, ms: 0, msg: `stale metrics (${Math.round(age / 1000)}s old)` };
    if (tsMs > freshness.now + 60_000) return { up: false, ms: 0, msg: "metric timestamp in the future (clock skew)" };
  }
  let pct: number;
  if (kind === "CPU") pct = sample.cpu;
  else if (kind === "MEM") pct = sample.memTotal > 0 ? (sample.memUsed / sample.memTotal) * 100 : 0;
  else pct = sample.diskTotal > 0 ? (sample.diskUsed / sample.diskTotal) * 100 : 0;
  const rounded = Math.round(pct);
  return {
    up: rounded < thresholdPct,
    ms: 0,
    msg: `${kind} ${rounded}% (limit ${thresholdPct}%)`,
  };
}
