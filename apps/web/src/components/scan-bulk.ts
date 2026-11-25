"use client";

import { useContext, useState } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { ServerView } from "../lib/types";
import { scanQueryKey } from "./server-scan-card";

/** Servers a bulk scan can run on: writable, online, with the "bulk" capability the scan uses. */
export function scannable(servers: ServerView[], ids: Iterable<string>): ServerView[] {
  const want = new Set(ids);
  return servers.filter((s) => want.has(s.id) && s.canOps && s.status === "ONLINE" && (s.capabilities ?? []).includes("bulk"));
}

/**
 * Scan many servers from the Servers list: two at a time (the hub serialises per server anyway and each scan starts
 * a short helper container on the host), each result written into that server's cached scan so the server page shows
 * it at once. Never throws; returns how many succeeded / failed.
 */
export function useBulkScan(concurrency = 2) {
  // Optional: the Servers table also renders outside a query client (tests, embeds); results are then just not cached.
  const qc = useContext(QueryClientContext);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const run = async (targets: ServerView[]): Promise<{ ok: number; failed: number }> => {
    let next = 0;
    let ok = 0;
    let failed = 0;
    setProgress({ done: 0, total: targets.length });
    const worker = async () => {
      while (next < targets.length) {
        const s = targets[next++];
        try {
          const view = await api.runServerScan(s.id);
          qc?.setQueryData(scanQueryKey(s.id), view);
          ok++;
        } catch {
          failed++;
        }
        setProgress({ done: ok + failed, total: targets.length });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
    setProgress(null);
    return { ok, failed };
  };
  return { run, progress };
}
