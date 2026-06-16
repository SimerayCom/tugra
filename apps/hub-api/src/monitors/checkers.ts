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
 * Evaluate a server metric against a threshold. Pure (no DB) so it's unit-testable;
 * the runner fetches the latest sample and passes it in. No sample → no alarm
 * (UP), to avoid false positives before metrics arrive.
 */
export function metricCheckResult(
  kind: MetricKind,
  sample: MetricSampleLite | null,
  thresholdPct: number,
): CheckResult {
  if (!sample) return { up: true, ms: 0, msg: "no metrics yet" };
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
