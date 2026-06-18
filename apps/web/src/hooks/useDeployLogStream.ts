"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { API_BASE, tokens } from "../lib/api";
import { consumeDeployLogStream } from "../lib/sse";

export interface DeployLogState {
  lines: string;
  done: boolean;
  status?: "SUCCESS" | "FAILED";
  exitCode?: number;
}

const EMPTY: DeployLogState = { lines: "", done: false };

/**
 * Subscribe to the live build-log SSE stream for an app's active deploy. Only
 * connects while `active` is true; aborts and resets on unmount or deactivation.
 * On completion it refetches deployments so the persisted log/status take over.
 */
export function useDeployLogStream(appId: string, active: boolean): DeployLogState {
  const qc = useQueryClient();
  const [state, setState] = useState<DeployLogState>(EMPTY);

  useEffect(() => {
    if (!active) {
      setState(EMPTY);
      return;
    }
    const controller = new AbortController();
    setState(EMPTY);
    void (async () => {
      try {
        const res = await fetch(`${API_BASE}/apps/${appId}/deployments/stream`, {
          headers: {
            authorization: `Bearer ${tokens.access() ?? ""}`,
            accept: "text/event-stream",
          },
          signal: controller.signal,
        });
        if (!res.body) return;
        await consumeDeployLogStream(res.body, (event) => {
          if (event.type === "chunk") {
            setState((s) => ({ ...s, lines: s.lines + event.data }));
          } else {
            setState((s) => ({ ...s, done: true, status: event.status, exitCode: event.exitCode }));
            void qc.invalidateQueries({ queryKey: ["deployments", appId] });
            void qc.invalidateQueries({ queryKey: ["app", appId] });
          }
        });
      } catch {
        // aborted or network error — UI falls back to polling
      }
    })();
    return () => controller.abort();
  }, [appId, active, qc]);

  return state;
}
