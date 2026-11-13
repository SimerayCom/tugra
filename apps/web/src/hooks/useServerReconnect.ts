"use client";

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ServerStatus } from "../lib/types";

/**
 * Auto-recover a server detail page when its agent reconnects. The Maintenance/Updates/Proxy cards are
 * one-shot queries (no refetchInterval; the global defaults are retry:1 + refetchOnWindowFocus:false), so a
 * card that loaded or errored while the agent was OFFLINE stays stale until a manual refresh. This watches the
 * polled `status` and, on any non-ONLINE → ONLINE edge, invalidates every query keyed to this server (its id
 * in slot 1) EXCEPT `['server', id]` itself (which already polls) — so the panel heals on its own, no refresh.
 */
export function useServerReconnect(id: string, status: ServerStatus | undefined): void {
  const qc = useQueryClient();
  const prev = useRef<ServerStatus | undefined>(undefined);
  useEffect(() => {
    const p = prev.current;
    if (status && p && p !== "ONLINE" && status === "ONLINE") {
      qc.invalidateQueries({
        predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[1] === id && q.queryKey[0] !== "server",
      });
    }
    prev.current = status;
  }, [status, id, qc]);
}
