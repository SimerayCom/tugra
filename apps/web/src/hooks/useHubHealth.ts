"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { useT } from "../i18n/provider";
import type { HubHealthWarning } from "../lib/types";

/** Poll the owner-only hub health. Slow on purpose: the hub samples every 20 s and caches its Postgres / Redis part for 30 s. */
export const HUB_HEALTH_POLL_MS = 30_000;

export function useHubHealth(enabled: boolean) {
  return useQuery({ queryKey: ["hubHealth"], queryFn: () => api.getHubHealth(), enabled, refetchInterval: HUB_HEALTH_POLL_MS, refetchOnWindowFocus: false });
}

/** The localized sentence for one warning. */
export function warningText(t: ReturnType<typeof useT>, w: HubHealthWarning): string {
  return t(`settings.hubWarn_${w.code}`, { value: w.value, limit: w.limit, detail: w.detail ?? "" });
}
