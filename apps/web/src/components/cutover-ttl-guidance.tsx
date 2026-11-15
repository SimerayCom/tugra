"use client";

import { useT } from "../i18n/provider";
import { fmtWhen } from "../lib/cutover";
import type { CutoverFlipPlan, CutoverTtlGuidance } from "../lib/api";
import { CopyBtn } from "./copy-row";

/**
 * Manual-DNS hosts: Tugra cannot edit these records, so this shows the exact records to create at the DNS provider
 * (copy-paste) plus when to lower the old TTL so resolvers pick the change up quickly. Renders nothing when empty.
 */
export function CutoverTtlGuidance({ guidance = [], records = [] }: { guidance?: CutoverTtlGuidance[]; records?: CutoverFlipPlan["copyPaste"] }) {
  const t = useT();
  if (guidance.length === 0 && records.length === 0) return null;
  return (
    <div style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 12, background: "var(--c-sur)" }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--c-tx2)", marginBottom: 6 }}>{t("cutover.ttl.manualTitle")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 8px", lineHeight: 1.5 }}>{t("cutover.ttl.guidance")}</p>
      {guidance.length > 0 && (
        <ul style={{ margin: "0 0 8px", paddingLeft: 18, fontSize: 12, color: "var(--c-tx2)", lineHeight: 1.6 }}>
          {guidance.map((g) => (
            <li key={g.hostname} style={{ wordBreak: "break-word" }}>
              {g.lowerBefore
                ? t("cutover.ttl.guidanceItem", { hostname: g.hostname, oldTtl: g.oldTtl, when: fmtWhen(g.lowerBefore) })
                : t("cutover.ttl.guidanceItemNoTime", { hostname: g.hostname, oldTtl: g.oldTtl })}
            </li>
          ))}
        </ul>
      )}
      {records.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {records.map((r, i) => {
            const line = t("cutover.ttl.recordLine", { type: r.type, name: r.name, content: r.content, ttl: r.ttl });
            return (
              <div key={`${r.hostname}-${r.type}-${i}`} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <code className="mono" style={{ flex: "1 1 220px", fontSize: 11, wordBreak: "break-all", color: "var(--c-tx)" }}>{line}</code>
                {r.lowerTtlBefore && <span style={{ fontSize: 11, color: "var(--c-am)" }}>{t("cutover.ttl.lowerBefore", { when: fmtWhen(r.lowerTtlBefore) })}</span>}
                <CopyBtn text={`${r.type}\t${r.name}\t${r.content}\t${r.ttl}`} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
