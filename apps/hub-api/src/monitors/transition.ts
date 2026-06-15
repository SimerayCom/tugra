import { MonitorStatus } from "@prisma/client";

export interface MonitorState {
  status: MonitorStatus;
  failCount: number;
  downCount: number;
}

export interface Transition extends MonitorState {
  important: boolean;
}

/**
 * Uptime-Kuma-style state machine: a failure becomes PENDING until `retries`
 * are exhausted, then DOWN. Only UP↔DOWN edges are "important" (notify-worthy);
 * resendEvery re-flags long-running DOWNs.
 */
export function nextState(
  prev: MonitorState,
  up: boolean,
  opts: { retries: number; resendEvery: number },
): Transition {
  if (up) {
    return {
      status: MonitorStatus.UP,
      failCount: 0,
      downCount: 0,
      important: prev.status === MonitorStatus.DOWN,
    };
  }

  const failCount = prev.failCount + 1;
  if (failCount > opts.retries) {
    const downCount = prev.downCount + 1;
    let important = prev.status !== MonitorStatus.DOWN; // first time down
    if (!important && opts.resendEvery > 0 && downCount % opts.resendEvery === 0) {
      important = true;
    }
    return { status: MonitorStatus.DOWN, failCount, downCount, important };
  }

  return {
    status: MonitorStatus.PENDING,
    failCount,
    downCount: prev.downCount,
    important: false,
  };
}

export function uptimePercent(upCount: number, total: number): number {
  return total > 0 ? Math.round((upCount / total) * 10000) / 100 : 0;
}
