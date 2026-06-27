"use client";

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { resolveTab } from "../lib/tab-param";

/**
 * Detail-page tab state kept in the URL (?tab=) so a refresh / back / shared link
 * lands on the same tab (e.g. a live deploy log). Drop-in for useState<string>.
 */
export function useTabState(fallback: string, validKeys: string[]): [string, (key: string) => void] {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tab = resolveTab(sp.get("tab"), validKeys, fallback);

  const setTab = useCallback(
    (key: string) => {
      const params = new URLSearchParams(sp.toString());
      if (key === fallback) params.delete("tab");
      else params.set("tab", key);
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [sp, router, pathname, fallback],
  );

  return [tab, setTab];
}
