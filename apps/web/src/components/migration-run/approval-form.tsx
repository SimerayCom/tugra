"use client";

import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { Btn } from "../ui";
import { Checkbox } from "../form";
import {
  CONFIRM_PROMPT_KEY,
  STEP_TITLE_KEY,
  ackRows,
  approvalIssues,
  approvalPayload,
  codeText,
  confirmNames,
  reviewLabel,
  reviewValue,
  type ApprovalIssue,
} from "../../lib/migration-run";
import type { MigrationRunApprovalBinding, MigrationRunGate, MigrationRunView, MigrationRunStepKey } from "../../lib/types";
import { useRunPlumbing } from "./use-run-actions";
import { TypedConfirmField } from "../typed-confirm-field";

const ISSUE_KEY: Record<ApprovalIssue, string> = {
  stale: "migrationRun.approval.issue.stale",
  "ack-missing": "migrationRun.approval.issue.ackMissing",
  "name-mismatch": "migrationRun.approval.issue.nameMismatch",
  "name-unavailable": "migrationRun.approval.issue.nameUnavailable",
  "data-risk": "migrationRun.approval.issue.dataRisk",
};

/**
 * The typed approval of a gated step. It is bound to the hash of what the operator reviewed: the form remembers the
 * `inputHash` it was opened on and sends THAT hash. When the live binding moves on (the evidence changed), the form
 * says so and stays locked until the operator reviews the new state, so nobody approves something they did not see.
 * The point-of-no-return approval additionally needs the data-risk acknowledgement and expires on the hub.
 */
export function ApprovalForm({ run, stepKey, binding, gate }: { run: MigrationRunView; stepKey: MigrationRunStepKey; binding: MigrationRunApprovalBinding; gate: MigrationRunGate | null }) {
  const t = useT();
  const { adopt, onError, toast } = useRunPlumbing(run.id);
  const expected = useMemo(() => confirmNames(binding.confirm, run), [binding.confirm, run]);
  const [reviewedHash, setReviewedHash] = useState(binding.inputHash);
  const [acks, setAcks] = useState<ReadonlySet<string>>(new Set());
  const [typed, setTyped] = useState<string[]>([]);
  const [dataRisk, setDataRisk] = useState(false);

  const draft = { reviewedHash, acks, typed: expected && expected.length > 0 ? expected.map((_, i) => typed[i] ?? "") : [], dataRisk };
  const issues = approvalIssues(binding, draft, expected);
  const stale = issues.includes("stale");
  const rows = ackRows(binding, gate);
  const reviewEntries = Object.entries(binding.review);

  const submit = useMutation({
    mutationFn: () => api.approveMigrationRunStep(run.id, stepKey, approvalPayload(binding, draft)),
    onSuccess: (next) => {
      adopt(next);
      toast(t("migrationRun.approval.accepted"), "success");
    },
    onError,
  });

  const reReview = () => {
    setReviewedHash(binding.inputHash);
    setAcks(new Set());
    setTyped([]);
    setDataRisk(false);
  };
  const toggleAck = (id: string, on: boolean) =>
    setAcks((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const accent = binding.ponr ? "var(--c-r)" : "var(--c-a)";
  const minutes = binding.ttlSec ? Math.max(1, Math.round(binding.ttlSec / 60)) : null;

  return (
    <form
      aria-label={t(STEP_TITLE_KEY[stepKey])}
      onSubmit={(e) => {
        e.preventDefault();
        if (issues.length === 0 && !submit.isPending) submit.mutate();
      }}
      style={{ display: "flex", flexDirection: "column", gap: 14, border: `1px solid ${accent}`, borderRadius: "var(--r2)", padding: 14, background: `color-mix(in srgb, ${accent} 6%, transparent)` }}
    >
      {binding.ponr && (
        <div role="alert" style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          <ShieldAlert size={20} color="var(--c-r)" aria-hidden style={{ flexShrink: 0, marginTop: 1 }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--c-r)" }}>{t("migrationRun.ponr.title")}</div>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--c-tx2)", lineHeight: 1.5 }}>{t("migrationRun.ponr.body")}</p>
          </div>
        </div>
      )}

      {reviewEntries.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>{t("migrationRun.approval.review")}</div>
          <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "minmax(0, max-content) minmax(0, 1fr)", gap: "4px 14px", fontSize: 13 }}>
            {reviewEntries.map(([k, v]) => (
              <div key={k} style={{ display: "contents" }}>
                <dt style={{ color: "var(--c-tx3)", wordBreak: "break-word" }}>{reviewLabel(t, k)}</dt>
                <dd className="mono" style={{ margin: 0, wordBreak: "break-word" }}>{reviewValue(t, k, v).text}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {rows.length > 0 && (
        <fieldset style={{ border: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          <legend style={{ fontSize: 12, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6, padding: 0 }}>{t("migrationRun.approval.acks")}</legend>
          {rows.map((r) => {
            const first = r.checks[0];
            const label = first ? codeText(t, first.code, first.params) : r.id;
            return (
              <div key={r.id}>
                <Checkbox
                  checked={acks.has(r.id)}
                  onChange={(on) => toggleAck(r.id, on)}
                  disabled={stale}
                  label={
                    <span style={{ wordBreak: "break-word" }}>
                      {label}
                      {r.checks.length > 1 && <span style={{ color: "var(--c-tx3)" }}> {t("migrationRun.approval.ackCount", { n: r.checks.length })}</span>}
                      {r.required && <span style={{ color: "var(--c-r)", fontWeight: 700 }}> {t("migrationRun.approval.required")}</span>}
                    </span>
                  }
                />
              </div>
            );
          })}
        </fieldset>
      )}

      {expected && expected.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 12, color: "var(--c-tx2)", lineHeight: 1.5 }}>{t(CONFIRM_PROMPT_KEY[binding.confirm])}</div>
          {expected.map((name, i) => (
            <TypedConfirmField
              key={name + i}
              mono
              expected={name}
              value={typed[i] ?? ""}
              disabled={stale}
              onChange={(v) => setTyped((prev) => expected.map((_, j) => (j === i ? v : prev[j] ?? "")))}
              label={t("migrationRun.confirm.typeToConfirm", { name })}
              style={{ fontSize: 14 }}
            />
          ))}
        </div>
      )}

      {binding.requiresDataRisk && (
        <Checkbox checked={dataRisk} onChange={setDataRisk} disabled={stale} label={<span style={{ color: "var(--c-r)" }}>{t("migrationRun.approval.dataRisk")}</span>} />
      )}

      {minutes && <p style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)" }}>{t("migrationRun.approval.expires", { minutes })}</p>}

      {stale && (
        <div role="alert" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 13, color: "var(--c-am)" }}>
          <span style={{ flex: "1 1 220px" }}>{t(ISSUE_KEY.stale)}</span>
          <Btn variant="ghost" onClick={reReview}>{t("migrationRun.approval.reReview")}</Btn>
        </div>
      )}

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <Btn type="submit" variant={binding.ponr ? "danger" : "primary"} disabled={issues.length > 0} loading={submit.isPending}>
          {binding.ponr ? t("migrationRun.approval.approvePonr") : t("migrationRun.approval.approve")}
        </Btn>
        {issues.filter((i) => i !== "stale").length > 0 && (
          <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: "var(--c-tx3)" }}>
            {issues.filter((i) => i !== "stale").map((i) => (
              <li key={i}>{t(ISSUE_KEY[i])}</li>
            ))}
          </ul>
        )}
      </div>
    </form>
  );
}
