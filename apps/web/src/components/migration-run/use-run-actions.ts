"use client";

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useT } from "../../i18n/provider";
import { useToast } from "../toast";
import { errorText } from "../../lib/migration-run";
import type { MigrationRunView } from "../../lib/types";

export const runQueryKey = (id: string) => ["migration-run", id] as const;

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
