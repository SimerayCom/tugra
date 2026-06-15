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
