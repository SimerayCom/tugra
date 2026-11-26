"use client";

import { useT } from "../../i18n/provider";
import { Btn } from "../ui";

/** The one line shown on a step the wizard resumed after a page refresh: why the owner is here, and how to begin again. Dismissible. */
export function ResumeNote({ onDismiss }: { onDismiss: () => void }) {
  const t = useT();
  return (
    <div data-testid="resume-note" role="note" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "4px 4px 4px 12px", background: "var(--c-el)" }}>
      <span style={{ flex: "1 1 220px", fontSize: 12, color: "var(--c-tx2)", lineHeight: 1.5 }}>{t("import.resume.note")}</span>
      <Btn variant="ghost" onClick={onDismiss} aria-label={t("import.resume.dismissLabel")} style={{ minHeight: 44, minWidth: 44 }}>{t("import.resume.dismiss")}</Btn>
    </div>
  );
}
