"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { API_BASE } from "../lib/api";
import { consumeSseStream } from "../lib/sse";
import type { MetricsSample } from "../lib/types";

const CAP = 60; // keep in sync with getMetrics(id, 60) history depth

function isMetricsSample(v: unknown): v is MetricsSample {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as MetricsSample).ts === "number" &&
    typeof (v as MetricsSample).cpu === "number"
  );
}

/**
 * Subscribe to a server's live metrics SSE stream and push each sample into the
 * ["metrics", serverId] query cache the charts already read — so they update in
 * real time instead of via polling. Only connects while `active` (the monitoring
 * tab is open); aborts on unmount/deactivation. The heartbeat ping frames are
 * ignored. The initial history and a slow refetch still come from the query, so
 * if the stream can't connect the charts degrade to that fallback.
 */
export function useMetricsStream(serverId: string, active: boolean): void {
  const qc = useQueryClient();

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void (async () => {
      // The stream is infinite (server merges a hot subject with keep-alive pings)
      // so any drop — proxy recycle, hub redeploy, laptop sleep/wake, token expiry
      // — must be reconnected, or live updates would stop permanently and leave
      // only the slow poll. Reconnect with backoff until the effect is torn down.
      let backoff = 1000;
      while (!controller.signal.aborted) {
        try {
          const res = await fetch(`${API_BASE}/servers/${serverId}/metrics/stream`, {
            headers: { accept: "text/event-stream" },
            credentials: "include", // same-origin session cookie authenticates the stream
            signal: controller.signal,
          });
          // Treat a non-2xx (e.g. 401 after the access cookie expired) as a failed connect: throw so
          // we back off instead of hot-looping. A co-located query's apiFetch refreshes the cookie,
          // so a later reconnect succeeds. (A 401 carries a JSON body, so `!res.body` alone misses it.)
          if (res.ok === false || !res.body) throw new Error(`metrics stream ${res.status}`);
          backoff = 1000; // reset after a successful connect
          await consumeSseStream(res.body, (raw) => {
            let msg: unknown;
            try {
              msg = JSON.parse(raw);
            } catch {
              return;
            }
            if (!isMetricsSample(msg)) return; // ignore heartbeat pings
            const sample = msg;
            qc.setQueryData<MetricsSample[]>(["metrics", serverId], (old = []) => {
              // Drop duplicates / out-of-order samples; append and cap to history depth.
              if (old.length && old[old.length - 1].ts >= sample.ts) return old;
              return [...old, sample].slice(-CAP);
            });
          });
        } catch {
          // aborted or network error — fall through to backoff + reconnect
        }
        if (controller.signal.aborted) break;
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 15000);
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, active]);
}
