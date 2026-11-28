"use client";

import { AlertTriangle, CheckCircle2, HelpCircle, XCircle } from "lucide-react";
import { useT } from "../../i18n/provider";
import { CHECK_STATUS_KEY, OWNER_INPUT_LABEL_KEY, checkStatusColor, codeText } from "../../lib/migration-run";
import type { MigrationRunGateCheck } from "../../lib/types";
import { EvidenceBadge } from "./badges";

export const INPUTS_ANCHOR = "migration-run-inputs";

function CheckIcon({ status }: { status: MigrationRunGateCheck["status"] }) {
  const p = { size: 15, color: checkStatusColor(status), "aria-hidden": true as const, style: { flexShrink: 0, marginTop: 1 } };
  if (status === "pass") return <CheckCircle2 {...p} />;
  if (status === "fail") return <XCircle {...p} />;
  if (status === "warn") return <AlertTriangle {...p} />;
  return <HelpCircle {...p} />;
}

/** A step's gate: one row per check with a status word, the localized code, its subject, its evidence kind and, for a
 *  check an owner input would resolve, a link to the inputs card. `unknown` reads as a failure, as the hub treats it. */
export function GateChecks({ checks, dense = false, hideInputLinks = false }: { checks: MigrationRunGateCheck[]; dense?: boolean; hideInputLinks?: boolean }) {
  const t = useT();
  if (checks.length === 0) return null;
  return (
    <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: dense ? 6 : 8 }}>
      {checks.map((c, i) => (
        <li key={`${c.id}:${c.subject ?? ""}:${i}`} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, minWidth: 0 }}>
          <CheckIcon status={c.status} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ wordBreak: "break-word", color: "var(--c-tx)" }}>
              <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: checkStatusColor(c.status), marginRight: 6 }}>{t(CHECK_STATUS_KEY[c.status])}</span>
              {codeText(t, c.code, c.params)}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 3 }}>
              {c.subject && <span className="mono" style={{ fontSize: 11, color: "var(--c-tx3)", wordBreak: "break-all" }}>{c.subject}</span>}
              {c.evidence && <EvidenceBadge kind={c.evidence} />}
              {c.acked && <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{t("migrationRun.check.acked")}</span>}
              {!hideInputLinks && c.ownerInput && !c.acked && c.status !== "pass" && (
                <a href={`#${INPUTS_ANCHOR}`} className="tg-link" style={{ fontSize: 11 }}>
                  {t("migrationRun.check.needsInput", { input: t(OWNER_INPUT_LABEL_KEY[c.ownerInput]) })}
                </a>
              )}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
