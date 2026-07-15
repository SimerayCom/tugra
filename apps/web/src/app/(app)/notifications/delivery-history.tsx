"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { useT } from "../../../i18n/provider";
import { Spinner } from "../../../components/ui";
import { deliveryColor } from "../../../lib/notifications";
import { relativeTime } from "../../../lib/fleet";

/** Per-channel delivery history — a lazily-loaded, collapsible read-only panel. Shows the frozen
 *  snapshot (title) + colored status + time; failed/dead rows reveal the sanitized lastError. Any
 *  team member may read (the backend authorizes reads to all members). */
export function DeliveryHistory({ channelId }: { channelId: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { data: deliveries = [], isLoading, isError } = useQuery({
    queryKey: ["deliveries", channelId],
    queryFn: () => api.listDeliveries(channelId),
    enabled: open, // lazy: nothing fetches until the panel is first expanded
  });

  return (
    <div style={{ width: "100%" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--c-tx3)", fontSize: 12, padding: 0 }}
      >
        {open ? "▾" : "▸"} {t("notifications.history")}
      </button>

      {open &&
        (isLoading ? (
          <div style={{ marginTop: 8 }}><Spinner /></div>
        ) : isError ? (
          <div style={{ marginTop: 8, fontSize: 12, color: "var(--c-r)" }}>{t("notifications.historyError")}</div>
        ) : deliveries.length === 0 ? (
          <div style={{ marginTop: 8, fontSize: 12, color: "var(--c-tx3)" }}>{t("notifications.noDeliveries")}</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
            {deliveries.map((d) => (
              <div
                key={d.id}
                style={{
                  display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
                  border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "6px 10px",
                }}
              >
                <span style={{ fontSize: 11, fontWeight: 700, color: deliveryColor(d.status) }}>{d.status}</span>
                <span style={{ fontSize: 12, color: "var(--c-tx2)", flex: 1, minWidth: 0 }}>{d.title}</span>
                {d.attempts > 1 && (
                  <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{t("notifications.attempts", { n: d.attempts })}</span>
                )}
                <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{relativeTime(d.createdAt)}</span>
                {(d.status === "FAILED" || d.status === "DEAD") && d.lastError && (
                  <div style={{ width: "100%", fontSize: 11, color: "var(--c-r)", fontFamily: "var(--font-mono, monospace)", wordBreak: "break-word" }}>
                    {d.lastError}
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}
