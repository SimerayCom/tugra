"use client";

import { useRef, useState } from "react";
import { ArrowDown, ArrowUp, GripVertical, RotateCcw } from "lucide-react";
import { DASHBOARD_CARDS, dropCard, moveCard, toggleCard, type DashboardCardId, type DashboardLayout } from "../../lib/dashboard-layout";
import { useT } from "../../i18n/provider";
import { Btn, Card } from "../ui";

/** Show / hide / reorder the dashboard cards. Every action is reachable by keyboard (checkbox + up/down buttons);
 *  dragging a row is a bonus for pointer users. */
export function CustomizePanel({ layout, onChange, onReset, onClose }: { layout: DashboardLayout; onChange: (l: DashboardLayout) => void; onReset: () => void; onClose: () => void }) {
  const t = useT();
  const [dragging, setDragging] = useState<DashboardCardId | null>(null);
  const [over, setOver] = useState<DashboardCardId | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const name = (id: DashboardCardId) => t(`dashboard.card.${id}`);
  return (
    <Card style={{ padding: 16, marginBottom: 24 }}>
      <section aria-labelledby="dash-customize-title">
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
          <h2 id="dash-customize-title" style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>{t("dashboard.customizeTitle")}</h2>
          <div style={{ flex: 1 }} />
          <Btn variant="ghost" icon={RotateCcw} onClick={onReset}>{t("dashboard.customizeReset")}</Btn>
          <Btn onClick={onClose}>{t("dashboard.customizeDone")}</Btn>
        </div>
        <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("dashboard.customizeHint")}</p>
        <ul ref={list} style={{ listStyle: "none", margin: 0, padding: 0, border: "1px solid var(--c-bd)", borderRadius: "var(--r2)", overflow: "hidden" }}>
          {layout.order.map((id, i) => {
            const visible = !layout.hidden.includes(id);
            return (
              <li
                key={id}
                draggable
                onDragStart={(e) => { setDragging(id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", id); }}
                onDragOver={(e) => { e.preventDefault(); if (over !== id) setOver(id); }}
                onDragLeave={() => setOver((o) => (o === id ? null : o))}
                onDrop={(e) => { e.preventDefault(); if (dragging) onChange(dropCard(layout, dragging, id)); setDragging(null); setOver(null); }}
                onDragEnd={() => { setDragging(null); setOver(null); }}
                style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderTop: i > 0 ? "1px solid var(--c-bd)" : "none", background: over === id && dragging !== id ? "var(--c-el)" : "transparent", opacity: dragging === id ? 0.5 : 1 }}
              >
                <GripVertical size={15} color="var(--c-tx3)" aria-label={t("dashboard.customizeDrag", { name: name(id) })} role="img" style={{ cursor: "grab", flexShrink: 0 }} />
                <label style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0, fontSize: 13, cursor: "pointer" }}>
                  <input type="checkbox" checked={visible} onChange={() => onChange(toggleCard(layout, id))} aria-label={t("dashboard.customizeShow", { name: name(id) })} />
                  <span style={{ color: visible ? "var(--c-tx)" : "var(--c-tx3)" }}>{name(id)}</span>
                </label>
                <Btn variant="ghost" icon={ArrowUp} aria-label={t("dashboard.customizeMoveUp", { name: name(id) })} disabled={i === 0} onClick={() => onChange(moveCard(layout, id, -1))} style={{ padding: "4px 8px" }} />
                <Btn variant="ghost" icon={ArrowDown} aria-label={t("dashboard.customizeMoveDown", { name: name(id) })} disabled={i === DASHBOARD_CARDS.length - 1} onClick={() => onChange(moveCard(layout, id, 1))} style={{ padding: "4px 8px" }} />
              </li>
            );
          })}
        </ul>
      </section>
    </Card>
  );
}
