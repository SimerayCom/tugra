"use client";

import { SectionCard } from "../ui";
import { useT } from "../../i18n/provider";
import { ackableItems, consentRequiredItems, tokenReadOnlyItems } from "../../lib/import";
import type { ImportCoverageEnvApp, ImportEnvReason, ImportPlan } from "../../lib/types";

/** Literal keys so static key-usage checks keep working. */
const REASON_KEY: Record<ImportEnvReason, string> = {
  NO_VALUE: "import.env.reason.noValue",
  SHARED_UNEXPANDED: "import.env.reason.sharedUnexpanded",
  MAGIC: "import.env.reason.magic",
  LOCKED: "import.env.reason.locked",
};
const LIST_CAP = 40;

/**
 * Strict-env review (Coolify). Lists, per app, the variable NAMES the import cannot carry (never values) with a
 * reason label, lets the operator acknowledge each app (or all at once) to create it WITHOUT those variables, and
 * shows a non-ackable banner when the API token cannot read variable values at all. The parent keeps the acknowledged
 * set and disables Apply until every ackable blocker is acknowledged.
 */
export function EnvBlockers({ plan, acked, onChange }: { plan: ImportPlan; acked: ReadonlySet<string>; onChange: (next: Set<string>) => void }) {
  const t = useT();
  const items = ackableItems(plan);
  const readOnly = tokenReadOnlyItems(plan);
  const needConsent = consentRequiredItems(plan);
  if (items.length === 0 && readOnly.length === 0 && needConsent.length === 0) return null;
  const byRef = new Map<string, ImportCoverageEnvApp>((plan.preflight?.coverage?.env?.apps ?? []).map((a) => [a.itemRef, a]));
  const toggle = (ref: string, on: boolean) => {
    const next = new Set(acked);
    if (on) next.add(ref);
    else next.delete(ref);
    onChange(next);
  };
  const allAcked = items.length > 0 && items.every((it) => acked.has(it.itemRef));
  return (
    <>
      {needConsent.length > 0 && (
        <SectionCard title={t("import.env.consentRequired.title")} style={{ padding: 16, marginBottom: 0, borderColor: "var(--c-r)" }}>
          <div role="alert" style={{ fontSize: 12, color: "var(--c-r)", marginBottom: 8, lineHeight: 1.5 }}>{t("import.env.consentRequired.body")}</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
            {needConsent.map((it) => (
              <li key={it.itemRef} className="mono" style={{ wordBreak: "break-all" }}>{it.name}</li>
            ))}
          </ul>
        </SectionCard>
      )}
      {readOnly.length > 0 && (
        <SectionCard title={t("import.env.tokenReadOnly.title")} style={{ padding: 16, marginBottom: 0, borderColor: "var(--c-r)" }}>
          <div role="alert" style={{ fontSize: 12, color: "var(--c-r)", marginBottom: 8, lineHeight: 1.5 }}>{t("import.env.tokenReadOnly.body")}</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
            {readOnly.map((it) => (
              <li key={it.itemRef} className="mono" style={{ wordBreak: "break-all" }}>{it.name}</li>
            ))}
          </ul>
        </SectionCard>
      )}
      {items.length > 0 && (
        <SectionCard title={t("import.env.blockers.title")} desc={t("import.env.blockers.body")} style={{ padding: 16, marginBottom: 0, borderColor: "var(--c-am)" }}>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
            <input
              type="checkbox"
              checked={allAcked}
              onChange={(e) => onChange(e.target.checked ? new Set([...acked, ...items.map((it) => it.itemRef)]) : new Set([...acked].filter((r) => !items.some((it) => it.itemRef === r))))}
            />
            {t("import.env.ackAll", { n: items.length })}
          </label>
          <p role="alert" style={{ fontSize: 12, color: "var(--c-am)", margin: "0 0 12px", lineHeight: 1.5 }}>{t("import.env.ackWarning")}</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {items.map((it) => {
              const rep = byRef.get(it.itemRef);
              return (
                <div key={it.itemRef} style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 10 }}>
                  <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, fontWeight: 600 }}>
                    <input type="checkbox" checked={acked.has(it.itemRef)} onChange={(e) => toggle(it.itemRef, e.target.checked)} aria-label={t("import.env.ackItem", { name: it.name })} style={{ marginTop: 3 }} />
                    <span className="mono" style={{ wordBreak: "break-all" }}>{it.name}</span>
                  </label>
                  <KeyLists rep={rep} />
                </div>
              );
            })}
          </div>
        </SectionCard>
      )}
    </>
  );
}

function KeyLists({ rep }: { rep: ImportCoverageEnvApp | undefined }) {
  const t = useT();
  if (!rep) return null;
  const more = (n: number) => (n > LIST_CAP ? <li style={{ color: "var(--c-tx3)" }}>{t("import.env.keysMore", { n: n - LIST_CAP })}</li> : null);
  return (
    <details style={{ marginTop: 6 }}>
      <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--c-tx3)" }}>{t("import.notCarriedCount", { n: rep.unresolved.length + rep.invalidKeys.length })}</summary>
      {rep.unresolved.length > 0 && (
        <>
          <div style={{ fontSize: 11, color: "var(--c-tx3)", margin: "6px 0 2px" }}>{t("import.env.unresolvedHeading")}</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11 }}>
            {rep.unresolved.slice(0, LIST_CAP).map((u) => (
              <li key={u.key} style={{ wordBreak: "break-word" }}>
                <span className="mono" style={{ wordBreak: "break-all" }}>{u.key}</span> <span style={{ color: "var(--c-tx3)" }}>({t(REASON_KEY[u.reason] ?? REASON_KEY.NO_VALUE)})</span>
              </li>
            ))}
            {more(rep.unresolved.length)}
          </ul>
        </>
      )}
      {rep.invalidKeys.length > 0 && (
        <>
          <div style={{ fontSize: 11, color: "var(--c-tx3)", margin: "6px 0 2px" }}>{t("import.env.invalidHeading")}</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11 }}>
            {rep.invalidKeys.slice(0, LIST_CAP).map((k) => (
              <li key={k} style={{ wordBreak: "break-word" }}>
                <span className="mono" style={{ wordBreak: "break-all" }}>{k}</span> <span style={{ color: "var(--c-tx3)" }}>({t("import.env.reason.invalidKey")})</span>
              </li>
            ))}
            {more(rep.invalidKeys.length)}
          </ul>
        </>
      )}
      {rep.previewSkipped > 0 && <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "6px 0 0" }}>{t("import.env.previewSkipped", { n: rep.previewSkipped })}</p>}
    </details>
  );
}
