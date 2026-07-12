"use client";

import { useEffect, useState } from "react";
import { API_BASE } from "../lib/api";
import { consumeSseStream } from "../lib/sse";

const CAP = 2000; // keep the last N lines in memory (a live follow is unbounded)
const MIN_PRODUCTIVE_MS = 2000; // a connection alive at least this long counts as productive

/**
 * Next reconnect delay. A productive connection (streamed data, or stayed up a while) resets to the
 * floor; an unproductive one (a follow on a stopped container completes instantly with no data)
 * grows exponentially so it can't reconnect-storm and spawn a `docker logs` process every second.
 */
export function nextBackoff(current: number, productive: boolean): number {
  return productive ? 1000 : Math.min(current * 2, 15000);
}

export interface ContainerLogState {
  lines: string[];
  connected: boolean;
  ended: boolean; // a non-follow stream finished, or the container's log process exited
}

const EMPTY: ContainerLogState = { lines: [], connected: false, ended: false };

/**
 * Subscribe to an app's live container-log SSE stream (`docker logs --follow` relayed by the agent).
 * Only connects while `active`. In follow mode the stream is treated as infinite: a drop (proxy
 * recycle, token refresh, max-duration cap, container restart) reconnects with backoff. A one-shot
 * (follow=false) request stops once the log process exits. Aborts on unmount / dependency change.
 */
export function useContainerLogStream(
  appId: string,
  opts: { container?: string; follow: boolean; active: boolean; since?: string; search?: string; tail?: number },
): ContainerLogState {
  const { container, follow, active, since, search, tail } = opts;
  const [state, setState] = useState<ContainerLogState>(EMPTY);

  useEffect(() => {
    if (!active) {
      setState(EMPTY);
      return;
    }
    setState(EMPTY);
    const controller = new AbortController();

    const append = (line: string) =>
      setState((s) => ({ ...s, lines: [...s.lines, line].slice(-CAP) }));

    void (async () => {
      let backoff = 1000;
      const params = new URLSearchParams();
      if (container) params.set("container", container);
      params.set("follow", follow ? "1" : "0");
      if (since) params.set("since", since);
      if (search) params.set("search", search);
      if (tail) params.set("tail", String(tail));
      const url = `${API_BASE}/apps/${appId}/logs/stream?${params.toString()}`;

      while (!controller.signal.aborted) {
        let sawExit = false;
        let gotData = false;
        const connectedAt = Date.now();
        try {
          const res = await fetch(url, {
            headers: { accept: "text/event-stream" },
            credentials: "include",
            signal: controller.signal,
          });
          // A non-2xx (403/503/expired cookie) → throw so we back off rather than hot-loop.
          if (res.ok === false || !res.body) throw new Error(`log stream ${res.status}`);
          setState((s) => ({ ...s, connected: true }));
          await consumeSseStream(res.body, (raw) => {
            let evt: { chunk?: string; exitCode?: number };
            try {
              evt = JSON.parse(raw);
            } catch {
              return;
            }
            if (typeof evt.chunk === "string") {
              gotData = true;
              append(evt.chunk);
            }
            if (typeof evt.exitCode === "number") sawExit = true;
          });
        } catch {
          // aborted or network error — fall through to backoff + reconnect
        }
        if (controller.signal.aborted) break;
        setState((s) => ({ ...s, connected: false }));
        // A one-shot request is done once its process exits; a follow keeps going (reconnect).
        if (!follow && sawExit) {
          setState((s) => ({ ...s, ended: true }));
          break;
        }
        // Reset backoff ONLY after a productive connection. A follow on a stopped/exited container
        // completes instantly with no data — without this guard it would reconnect-storm at ~1/s,
        // spawning a fresh `docker logs` process on the host each time.
        backoff = nextBackoff(backoff, gotData || Date.now() - connectedAt >= MIN_PRODUCTIVE_MS);
        await new Promise((r) => setTimeout(r, backoff));
      }
    })();

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId, container, follow, active, since, search, tail]);

  return state;
}
