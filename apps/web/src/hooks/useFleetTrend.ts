"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { trendByServer } from "../lib/fleet-view";
import type { FleetTrendRow } from "../lib/types";

const EMPTY: FleetTrendRow[] = []; // stable identity → keeps the memo below from re-running every render

/** Batch "last 30 minutes" CPU/RAM trend for every visible server (ONE request, not one per row). Backs the
 *  sparkline columns of the fleet and server tables; refreshes slowly (the points are per-minute) and a
 *  failure just leaves the cells as "—" — the trend is decoration, never a reason to break the table. */
export function useFleetTrend(enabled = true): Map<string, FleetTrendRow> {
  return useFleetTrendState(enabled).trends;
}

/** Same query as {@link useFleetTrend}, plus `isLoading` (first fetch in flight) so a view can tell "still
 *  loading" apart from "loaded, nothing there". */
export function useFleetTrendState(enabled = true): { trends: Map<string, FleetTrendRow>; isLoading: boolean } {
  const { data = EMPTY, isLoading } = useQuery({
    queryKey: ["fleetTrend"],
    queryFn: () => api.getFleetTrend(30),
    select: (d) => (Array.isArray(d) ? d : EMPTY),
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: false,
    enabled,
  });
  const trends = useMemo(() => trendByServer(data), [data]);
  return { trends, isLoading };
}
