"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { Btn } from "../ui";
import { useConfirm } from "../confirm";
import { Field, TextInput } from "../form";
import { CopyBtn } from "../copy-row";
import { codeText, paramText } from "../../lib/migration-run";
import type { MigrationRunStepView } from "../../lib/types";
import { CommandBlock } from "./command-block";
import { useRunPlumbing } from "./use-run-actions";

/** Operator attestation: "I did this outside the hub". Recorded as `operator-attested` evidence, never upgraded. */
function AttestRow({ runId, step, checkId, subject }: { runId: string; step: MigrationRunStepView; checkId: string; subject?: string }) {
  const { adopt, onError, t } = useRunPlumbing(runId);
  const confirm = useConfirm();
  const [note, setNote] = useState("");
  // One check id can repeat once per subject: an attestation covers exactly its own subject.
  const check = step.gate?.checks.find((c) => (c.id === checkId || c.attestable?.includes(checkId)) && c.subject === subject);
  // an inventory "mapped" attestation says WHICH plan item the container is: without that note it settles nothing
  const needsNote = checkId === "inventory-mapped";
  const done = step.evidence.attestations.some((a) => a.checkId === checkId && a.subject === subject);
  const attest = useMutation({
    mutationFn: () => api.attestMigrationRunStep(runId, step.key, { checkId, ...(subject ? { subject } : {}), ...(note.trim() ? { note: note.trim() } : {}) }),
    onSuccess: adopt,
    onError,
  });
  const label = check ? codeText(t, check.code, check.params) : checkId;
  const rawRecords = check?.params?.records;
  const records = Array.isArray(rawRecords) ? rawRecords.map((r) => String(r)).filter(Boolean) : [];
  const observed = check?.params?.observed !== undefined ? paramText(check.params.observed) : "";
  const onAttest = async () => {
    if (await confirm({ title: t("migrationRun.attest.title"), body: t("migrationRun.attest.body", { what: label }), confirmLabel: t("migrationRun.attest.confirm") })) attest.mutate();
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 12 }}>
      <div style={{ fontSize: 13, wordBreak: "break-word" }}>{label}</div>
      {/* a manual-DNS host lists the exact records to enter and what the resolvers show right now */}
      {records.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("migrationRun.attest.records")}</div>
          {records.map((r, i) => (
            <div key={`${r}:${i}`} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <code className="mono" style={{ fontSize: 12, wordBreak: "break-all", flex: "1 1 200px", minWidth: 0 }}>{r}</code>
              <CopyBtn text={r} />
            </div>
          ))}
          {observed && <div style={{ fontSize: 12, color: "var(--c-tx3)", wordBreak: "break-word" }}>{t("migrationRun.attest.observed", { observed })}</div>}
        </div>
      )}
      {done ? (
        <div style={{ fontSize: 12, color: "var(--c-g)" }}>{t("migrationRun.attest.recorded")}</div>
      ) : (
        <>
          <Field label={needsNote ? t("migrationRun.attest.noteRequired") : t("migrationRun.attest.note")}>
            <TextInput value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} style={{ minHeight: 44 }} />
          </Field>
          <div>
            <Btn variant="ghost" onClick={onAttest} loading={attest.isPending} disabled={needsNote && !note.trim()}>{t("migrationRun.attest.button")}</Btn>
          </div>
        </>
      )}
    </div>
  );
}

/** Attach an object migration (created with its own credentials in Migrate objects): the run only drives it. */
function AttachRow({ runId, step }: { runId: string; step: MigrationRunStepView }) {
  const { adopt, onError, t } = useRunPlumbing(runId);
  const [id, setId] = useState("");
  const attach = useMutation({ mutationFn: () => api.attachMigrationRunStep(runId, step.key, { kind: "object-migration", resourceId: id.trim() }), onSuccess: (v) => { adopt(v); setId(""); }, onError });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <p style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 }}>{t("migrationRun.attach.hint")}</p>
      {step.evidence.attachments.map((a) => (
        <a key={a.resourceId} href={`/migrations/objects/${encodeURIComponent(a.resourceId)}`} className="tg-link mono" style={{ fontSize: 12, wordBreak: "break-all" }}>{t("migrationRun.attach.attached", { id: a.resourceId })}</a>
      ))}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
        <Field label={t("migrationRun.attach.label")} style={{ flex: "1 1 220px" }}>
          <TextInput value={id} onChange={(e) => setId(e.target.value)} mono maxLength={64} autoComplete="off" spellCheck={false} style={{ minHeight: 44 }} />
        </Field>
        <Btn variant="ghost" onClick={() => attach.mutate()} disabled={!id.trim()} loading={attach.isPending}>{t("migrationRun.attach.button")}</Btn>
      </div>
      <a href="/migrations/objects/new" className="tg-link" style={{ fontSize: 12 }}>{t("migrationRun.attach.create")}</a>
    </div>
  );
}

/** Everything an operator can do on a waiting step besides approve: get the migrator command, attest a check that was
 *  done by hand, attach an object migration, or skip an optional step. Each is shown only when the hub allows it. */
export function OperatorTools({ runId, step, attest, offersCommand, runnerIsHostLoop = false }: { runId: string; step: MigrationRunStepView; attest?: string[]; offersCommand?: boolean; runnerIsHostLoop?: boolean }) {
  const { adopt, onError, t } = useRunPlumbing(runId);
  const confirm = useConfirm();
  const skip = useMutation({ mutationFn: () => api.skipMigrationRunStep(runId, step.key), onSuccess: adopt, onError });
  const onSkip = async () => {
    if (await confirm({ title: t("migrationRun.skip.title"), body: t("migrationRun.skip.body"), confirmLabel: t("migrationRun.skip.confirm"), danger: true })) skip.mutate();
  };
  const showCommand = step.allowed.command && (offersCommand ?? true);
  // the hub mints the command of what the step waits for: an inventory first, then the host-loop script (FREEZE always asks for the script)
  const waited = step.wait && step.wait.kind === "operator" ? step.wait.commandKind : undefined;
  const commandKind = waited ?? (runnerIsHostLoop || step.key === "FREEZE" ? "host-loop" : "migrator");
  // One row per gate check an attestation can cover (a check id may appear once per subject); an id with no check in
  // the gate still gets its single row.
  const attestRows = step.allowed.evidence
    ? (attest ?? []).flatMap((id) => {
        // a check lists the attestations that settle IT (`attestable`): a finding blocks with its own subject, so each gets a row
        const subjects = (step.gate?.checks ?? []).filter((c) => c.id === id || (c.attestable?.includes(id) && c.status !== "pass")).map((c) => c.subject);
        return (subjects.length > 0 ? subjects : [undefined]).map((subject) => ({ id, subject }));
      })
    : [];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {showCommand && <CommandBlock runId={runId} stepKey={step.key} kind={commandKind} />}
      {attestRows.map((r) => (
        <AttestRow key={`${r.id}:${r.subject ?? ""}`} runId={runId} step={step} checkId={r.id} subject={r.subject} />
      ))}
      {step.allowed.attach && <AttachRow runId={runId} step={step} />}
      {step.allowed.skip && (
        <div>
          <Btn variant="ghost" onClick={onSkip} loading={skip.isPending}>{t("migrationRun.skip.button")}</Btn>
        </div>
      )}
    </div>
  );
}
