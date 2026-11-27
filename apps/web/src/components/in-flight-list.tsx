"use client";

import Link from "next/link";
import { useT } from "../i18n/provider";
import { inFlightHref } from "../lib/in-flight";
import { relativeTime } from "../lib/fleet";
import type { InFlightItem } from "../lib/types";

/**
 * What an update is waiting for: one line per piece of work (its kind, its name, since when), with a link where the work has a page.
 * Shows the first `max` and says how many more there are.
 */
export function InFlightList({ items, max = 6, testId = "in-flight-list" }: { items: readonly InFlightItem[]; max?: number; testId?: string }) {
  const t = useT();
  if (items.length === 0) return null;
  const shown = items.slice(0, max);
  return (
    <ul data-testid={testId} style={{ listStyle: "none", margin: "6px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
      {shown.map((i) => {
        const href = inFlightHref(i);
        return (
          <li key={`${i.kind}:${i.id}`} data-kind={i.kind} style={{ fontSize: 12, color: "var(--c-tx2)", overflowWrap: "anywhere" }}>
            <span style={{ fontWeight: 600, color: "var(--c-tx)" }}>{t(`inFlight.kind.${i.kind}`)}</span>
            {i.label && i.label !== i.id ? <> · {i.label}</> : null}
            <span style={{ color: "var(--c-tx3)" }}> · {t("inFlight.since", { when: relativeTime(i.since) })}</span>
            {href && (
              <>
                {" "}
                <Link href={href} style={{ color: "var(--c-lapis, var(--c-a))", textDecoration: "none" }}>
                  {t("inFlight.view")} →
                </Link>
              </>
            )}
          </li>
        );
      })}
      {items.length > shown.length && <li style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("inFlight.more", { n: items.length - shown.length })}</li>}
    </ul>
  );
}
