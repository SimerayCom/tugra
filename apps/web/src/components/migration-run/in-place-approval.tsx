"use client";

import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { Btn } from "../ui";
import { Checkbox } from "../form";
import { useConfirm } from "../confirm";
import { ackRows, approvalIssues, approvalPayload, codeText, confirmNames } from "../../lib/migration-run";
import { siteCounts } from "../../lib/inplace-run";
import type { MigrationRunApprovalBinding, MigrationRunGate, MigrationRunStepKey, MigrationRunView } from "../../lib/types";
import { useRunInPlace } from "./in-place-card";
import { useRunPlumbing } from "./use-run-actions";

/**
 * The owner's go-ahead on an in-place run, in three facts and one button. The approval is still bound to the exact review it was opened on
 * (the same hash, the same acknowledgements the hub asks for); what changes is how it is asked: every finding that needs an
 * acknowledgement is listed in words and the one button acknowledges them all, and the names the hub wants typed are filled in by the
 * page, because on the step that takes the ports the button asks one short question first ("Take over X now?").
 */
export function InPlaceApproval({ run, stepKey, binding, gate }: { run: MigrationRunView; stepKey: MigrationRunStepKey; binding: MigrationRunApprovalBinding; gate: MigrationRunGate | null }) {
  const t = useT();
  const confirm = useConfirm();
  const { adopt, onError, toast } = useRunPlumbing(run.id);
  const takeover = useRunInPlace(run);
  const expected = useMemo(() => confirmNames(binding.confirm, run), [binding.confirm, run]);
  const [reviewedHash, setReviewedHash] = useState(binding.inputHash);
  const [dataRisk, setDataRisk] = useState(false);
  const rows = ackRows(binding, gate);
  const draft = { reviewedHash, acks: new Set(rows.map((r) => r.id)), typed: expected ?? [], dataRisk };
  const issues = approvalIssues(binding, draft, expected);
  const stale = issues.includes("stale");
  const server = run.targetServerName ?? run.targetServerId;
  const takesPorts = stepKey === "VERIFY";
  const counts = takeover.data ? siteCounts(takeover.data.items) : null;
  const minutes = binding.ttlSec ? Math.max(1, Math.round(binding.ttlSec / 60)) : null;

  const submit = useMutation({
    mutationFn: () => api.approveMigrationRunStep(run.id, stepKey, approvalPayload(binding, draft)),
    onSuccess: (next) => {
      adopt(next);
      toast(t("migrationRun.approval.accepted"), "success");
    },
    onError,
  });
  const onApprove = async () => {
    if (issues.length > 0 || submit.isPending) return;
    if (takesPorts && !(await confirm({ title: t("inPlaceRun.approval.confirmTitle", { server }), body: t("inPlaceRun.approval.confirmBody"), confirmLabel: t("inPlaceRun.approval.confirmButton") }))) return;
    submit.mutate();
  };

  return (
    <form
      aria-label={t("inPlaceRun.next.goAhead")}
      onSubmit={(e) => {
        e.preventDefault();
        void onApprove();
      }}
      style={{ display: "flex", flexDirection: "column", gap: 12 }}
    >
      {takesPorts && counts && counts.sites > 0 && counts.same === counts.sites && counts.problems === 0 && (
        <p data-testid="in-place-sites-same" style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>
          {t(counts.sites === 1 ? "inPlaceRun.approval.sitesSameOne" : "inPlaceRun.approval.sitesSame", { count: counts.sites })}
        </p>
      )}
      {rows.length > 0 && (
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{t(takesPorts ? "inPlaceRun.approval.leftOut" : "inPlaceRun.approval.asks")}</div>
          <ul data-testid="in-place-asks" style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6, display: "flex", flexDirection: "column", gap: 2 }}>
            {rows.map((r) => {
              const first = r.checks[0];
              return <li key={r.id} style={{ wordBreak: "break-word" }}>{first ? codeText(t, first.code, first.params) : t("inPlaceRun.approval.askUnknown")}</li>;
            })}
          </ul>
        </div>
      )}
      {binding.requiresDataRisk && <Checkbox checked={dataRisk} onChange={setDataRisk} disabled={stale} label={<span style={{ color: "var(--c-r)" }}>{t("migrationRun.approval.dataRisk")}</span>} />}
      {takesPorts && <p style={{ margin: 0, fontSize: 13, color: "var(--c-tx2)", lineHeight: 1.5 }}>{t("inPlaceRun.approval.takes")}</p>}
      {minutes && <p style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)" }}>{t("migrationRun.approval.expires", { minutes })}</p>}
      {stale && (
        <div role="alert" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 13, color: "var(--c-am)" }}>
          <span style={{ flex: "1 1 220px" }}>{t("migrationRun.approval.issue.stale")}</span>
          <Btn variant="ghost" onClick={() => setReviewedHash(binding.inputHash)}>{t("migrationRun.approval.reReview")}</Btn>
        </div>
      )}
      {issues.includes("name-unavailable") && <p role="alert" style={{ margin: 0, fontSize: 12, color: "var(--c-am)" }}>{t("migrationRun.approval.issue.nameUnavailable")}</p>}
      <div>
        <Btn type="submit" disabled={issues.length > 0} loading={submit.isPending}>
          {takesPorts ? t("inPlaceRun.approval.takeOver", { server }) : t("inPlaceRun.approval.continue")}
        </Btn>
      </div>
    </form>
  );
}
