"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { trafficIsEmpty } from "../lib/traffic";
import type { MetricsRange } from "../lib/types";
import { COUNTRY_LIMIT, POLL_MS, TOP_LIMIT } from "../components/traffic/traffic-panels";

/**
 * The three queries behind the traffic panels (summary, top paths, countries), polled together, plus the derived
 * `loading` / `failed` / `empty` states. Shared by the global Traffic page and the per-app Analytics tab.
 * `enabled: false` skips every request (the Analytics tab does while it shows an empty state instead).
 */
export function useTrafficData({ range, teamId, domain, appId, enabled = true }: { range: MetricsRange; teamId: string | null | undefined; domain?: string; appId?: string; enabled?: boolean }) {
  const summary = useQuery({
    queryKey: ["trafficSummary", teamId, range, domain, appId],
    queryFn: () => api.getTrafficSummary({ range, teamId, domain, appId }),
    refetchInterval: POLL_MS,
    enabled,
  });
  const paths = useQuery({
    queryKey: ["trafficPaths", teamId, range, domain, appId],
    queryFn: () => api.getTrafficPaths({ range, teamId, domain, appId, limit: TOP_LIMIT }),
    refetchInterval: POLL_MS,
    enabled,
  });
  const countries = useQuery({
    queryKey: ["trafficCountries", teamId, range, domain, appId],
    queryFn: () => api.getTrafficCountries({ range, teamId, domain, appId, limit: COUNTRY_LIMIT }),
    refetchInterval: POLL_MS,
    enabled,
  });
  const loading = summary.isLoading || paths.isLoading || countries.isLoading;
  const failed = summary.isError && paths.isError && countries.isError;
  const empty = trafficIsEmpty(summary.data, paths.data, countries.data);
  const refetch = () => {
    summary.refetch();
    paths.refetch();
    countries.refetch();
  };
  return { summary, paths, countries, loading, failed, empty, refetch };
}
