"use client";

import { useT } from "../i18n/provider";
import { STATE_KEY, STATE_TONE, tCode } from "../lib/cutover";
import { Badge } from "./ui";

/** One cutover entry's state as a toned badge (unknown/newer states fall back to the raw code, grey). */
export function CutoverStateBadge({ state }: { state: string }) {
  const t = useT();
  return <Badge tone={STATE_TONE[state] ?? "muted"}>{tCode(t, STATE_KEY, state)}</Badge>;
}
