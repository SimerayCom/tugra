"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { mergeEvents } from "../../lib/migration-run";
import type { MigrationRunEvent } from "../../lib/types";

/** The run's append-only event log, kept up to date by a cursor: whenever the run view's `eventSeq` moves past what we
 *  hold, fetch `?afterSeq=<last>` until the hub says there is no more. Events are codes + params, so a reload loses
 *  nothing: it simply re-reads from the start. */
export function useRunEvents(runId: string, eventSeq: number | undefined): { events: MigrationRunEvent[]; error: boolean } {
  const [events, setEvents] = useState<MigrationRunEvent[]>([]);
  const [error, setError] = useState(false);
  const last = useRef(0);
  const busy = useRef(false);
  const runRef = useRef(runId);

  useEffect(() => {
    if (runRef.current !== runId) {
      runRef.current = runId;
      last.current = 0;
      setEvents([]);
    }
  }, [runId]);

  useEffect(() => {
    if (eventSeq === undefined || eventSeq <= last.current || busy.current) return;
    let cancelled = false;
    busy.current = true;
    (async () => {
      try {
        // A bounded loop: a page is at most 200 events and the hub reports `hasMore`.
        for (let i = 0; i < 25 && !cancelled; i++) {
          const page = await api.getMigrationRunEvents(runId, last.current, 200);
          if (cancelled) return;
          if (page.events.length > 0) setEvents((prev) => mergeEvents(prev, page.events));
          last.current = Math.max(last.current, page.lastSeq);
          if (!page.hasMore) break;
        }
        if (!cancelled) setError(false);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        busy.current = false;
      }
    })();
    return () => {
      cancelled = true;
      busy.current = false;
    };
  }, [runId, eventSeq]);

  return { events, error };
}
