"use client";

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { resolveTab } from "../lib/tab-param";

/**
 * Detail-page tab state kept in the URL (?tab=) so a refresh / back / shared link
 * lands on the same tab (e.g. a live deploy log). Drop-in for useState<string>.
 *
 * `param` names the query key (default "tab"), so a page can keep a second piece
 * of state in the URL — e.g. `useTabState("general", keys, "section")` for a
 * sub-nav — without clobbering the main tab.
 */
export function useTabState(fallback: string, validKeys: string[], param = "tab"): [string, (key: string) => void] {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tab = resolveTab(sp.get(param), validKeys, fallback);

  const setTab = useCallback(
    (key: string) => {
      const params = new URLSearchParams(sp.toString());
      if (key === fallback) params.delete(param);
      else params.set(param, key);
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [sp, router, pathname, fallback, param],
  );

  return [tab, setTab];
}
