"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { API_BASE } from "../lib/api";
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
/** Shared SSE log consumer for any DeployLogHub-backed stream path. */
function useLogStream(path: string, active: boolean, onDone?: () => void): DeployLogState {
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
        const res = await fetch(`${API_BASE}${path}`, {
          headers: { accept: "text/event-stream" },
          credentials: "include", // same-origin session cookie authenticates the stream
          signal: controller.signal,
        });
        if (res.ok === false || !res.body) return; // non-2xx (e.g. expired cookie) → bail; the UI falls back to polling
        await consumeDeployLogStream(res.body, (event) => {
          if (event.type === "chunk") {
            setState((s) => ({ ...s, lines: s.lines + event.data }));
          } else {
            setState((s) => ({ ...s, done: true, status: event.status, exitCode: event.exitCode }));
            onDone?.();
          }
        });
      } catch {
        // aborted or network error — UI falls back to polling
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, active]);

  return state;
}

/**
 * Subscribe to the live build-log SSE stream for an app's active deploy. Only
 * connects while `active` is true; aborts and resets on unmount or deactivation.
 * On completion it refetches deployments so the persisted log/status take over.
 */
export function useDeployLogStream(appId: string, active: boolean): DeployLogState {
  const qc = useQueryClient();
  return useLogStream(`/apps/${appId}/deployments/stream`, active, () => {
    void qc.invalidateQueries({ queryKey: ["deployments", appId] });
    void qc.invalidateQueries({ queryKey: ["app", appId] });
  });
}

/** Live SSE stream for a server's active patch run (apt upgrade). */
export function usePatchLogStream(serverId: string, active: boolean): DeployLogState {
  const qc = useQueryClient();
  return useLogStream(`/servers/${serverId}/updates/stream`, active, () => {
    void qc.invalidateQueries({ queryKey: ["server", serverId] });
  });
}
