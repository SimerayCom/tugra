"use client";

import { useMutation } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { EXACT_REASON_KEY, exactImageLine, groupExactImages } from "../../lib/migration-run";
import type { MigrationRunSafetyHints } from "../../lib/types";
import { useRunPlumbing } from "./use-run-actions";

const heading: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.05em" };
const hint: React.CSSProperties = { margin: "4px 0 0", fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 };

/**
 * "Keep the exact image": Tugra keeps the image each app, database and service of the source runs (the digest the source host reports),
 * so a redeploy or a move to another server never pulls a newer one. Every item is ticked by default; unticking one makes it run
 * whatever its tag points at when it is deployed. An item the host reported no image for is listed as unknown and keeps what the source writes.
 */
export function ExactImagesSection({ runId, hints, closed, onSaved }: { runId: string; hints: MigrationRunSafetyHints; closed: boolean; onSaved: (next: MigrationRunSafetyHints) => void }) {
  const t = useT();
  const { onError } = useRunPlumbing(runId);
  const save = useMutation({ mutationFn: (item: { itemRef: string; keep: boolean }) => api.setMigrationRunExactImages(runId, { items: [item] }), onSuccess: (v) => onSaved(v), onError });
  const groups = groupExactImages(hints.exactImages ?? []);
  const unknown = hints.exactUnknown ?? [];
  const skipped = hints.exactSkipped ?? [];
  // the box shows what was just asked for while the hub answers, so a click is never a silent no-op
  const asked = save.isPending ? save.variables : undefined;
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div>
        <div style={heading}>{t("migrationRun.safety.exactTitle")}</div>
        <p style={hint}>{t("migrationRun.safety.exactHint")}</p>
      </div>
      {groups.length === 0 && unknown.length === 0 && skipped.length === 0 && <div style={{ fontSize: 13, color: "var(--c-tx3)" }}>{t("migrationRun.safety.exactEmpty")}</div>}
      {groups.length > 0 && (
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 10 }}>
          {groups.map((g) => (
            <li key={g.itemRef} style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, fontWeight: 600, minHeight: 28, minWidth: 0 }}>
                <input
                  type="checkbox"
                  checked={asked?.itemRef === g.itemRef ? asked.keep : g.kept}
                  disabled={closed || save.isPending}
                  aria-busy={asked?.itemRef === g.itemRef}
                  aria-label={t("migrationRun.safety.exactKeep", { name: g.name })}
                  onChange={(e) => save.mutate({ itemRef: g.itemRef, keep: e.target.checked })}
                />
                <span style={{ minWidth: 0, wordBreak: "break-word" }}>{g.name}</span>
                <span style={{ fontSize: 12, fontWeight: 400, color: "var(--c-tx3)" }}>{t("migrationRun.safety.exactKeepLabel")}</span>
              </label>
              {g.rows.map((r) => {
                const line = exactImageLine(r);
                return (
                  <div key={`${r.itemRef}#${r.member}`} style={{ fontSize: 12, lineHeight: 1.5, paddingLeft: 24, color: g.kept ? "var(--c-tx2)" : "var(--c-tx3)", display: "flex", flexWrap: "wrap", gap: "2px 8px", minWidth: 0 }}>
                    {r.member && <span className="mono">{r.member}</span>}
                    <span>{g.kept ? t(line.key, line.params) : t("migrationRun.safety.exactOff")}</span>
                  </div>
                );
              })}
            </li>
          ))}
        </ul>
      )}
      {unknown.length > 0 && (
        <div role="note" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--c-am)" }}>{t("migrationRun.safety.exactUnknownTitle")}</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 }}>
            {unknown.map((u) => (
              <li key={`${u.itemRef}#${u.member}`} style={{ wordBreak: "break-word" }}>
                {t("migrationRun.safety.exactUnknown", { name: u.member ? `${u.name || u.itemRef} / ${u.member}` : u.name || u.itemRef, image: u.image || t("migrationRun.safety.exactDash") })}
              </li>
            ))}
          </ul>
        </div>
      )}
      {skipped.length > 0 && (
        <div role="alert" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--c-r)" }}>{t("migrationRun.safety.exactSkippedTitle")}</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "var(--c-tx2)", lineHeight: 1.5 }}>
            {skipped.map((u) => (
              <li key={u.itemRef} style={{ wordBreak: "break-word" }}>
                {t("migrationRun.safety.exactSkipped", { name: u.name || u.itemRef, reason: t(EXACT_REASON_KEY[u.reason] ?? "migrationRun.exactReason.refused") })}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
