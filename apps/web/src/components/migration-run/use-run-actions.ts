"use client";

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useT } from "../../i18n/provider";
import { useToast } from "../toast";
import { errorText } from "../../lib/migration-run";
import type { MigrationRunView } from "../../lib/types";

export const runQueryKey = (id: string) => ["migration-run", id] as const;
/** The safety hints of a run (image pins, worker marks, accepted dry-run warnings): one cache entry for every card that reads them. */
export const runHintsKey = (id: string) => ["migration-run-safety-hints", id] as const;

/** A source session the operator just re-created for a run: kept in memory only (never the token), so a dry-run
 *  promotion can hand the fresh session to the new run. */
export interface FreshSession {
  sessionId: string;
  expiresAt: string;
}
export const sessionQueryKey = (id: string) => ["migration-run-source-session", id] as const;

/** The fresh source session for a run, or null when none was entered or it has expired. */
export function useFreshSession(runId: string): FreshSession | null {
  const { data } = useQuery<FreshSession | null>({ queryKey: sessionQueryKey(runId), queryFn: () => null, enabled: false, staleTime: Infinity, gcTime: Infinity });
  if (!data) return null;
  return Date.parse(data.expiresAt) > Date.now() ? data : null;
}

/** Shared plumbing of every run action: put the fresh view the hub returned into the cache (so the page updates at
 *  once instead of waiting for the next poll), refresh the list, and localize the hub's error. */
export function useRunPlumbing(runId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  const t = useT();
  const adopt = useCallback(
    (next: MigrationRunView) => {
      qc.setQueryData(runQueryKey(next.id), next);
      void qc.invalidateQueries({ queryKey: ["migration-runs"] });
      void qc.invalidateQueries({ queryKey: ["migration-run-events", next.id] });
    },
    [qc],
  );
  const onError = useCallback(
    (e: unknown) => {
      toast(errorText(t, e), "error");
      // A 409 (stale hash, state moved on) is answered by what the hub says now.
      void qc.invalidateQueries({ queryKey: runQueryKey(runId) });
    },
    [qc, runId, t, toast],
  );
  return { adopt, onError, toast, t };
}
