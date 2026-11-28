"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { Btn, SectionCard } from "../ui";
import { useConfirm } from "../confirm";
import { Checkbox, Textarea } from "../form";
import { confirmNames, joinConfirmNames } from "../../lib/migration-run";
import type { MigrationRunView } from "../../lib/types";
import { GiveBackButton } from "./give-back";
import { TypedConfirmDialog } from "./typed-confirm";
import { useFreshSession, useRunPlumbing } from "./use-run-actions";

type Dialog = "abort" | "cleanup" | "reverse" | "decommission" | null;

/** Start a run, or promote a finished dry run into a NEW real run (the page then moves to it). Shared by the header button and
 *  the dry-run decision screen, so the two can never promote differently. */
export function useStartRun(run: MigrationRunView) {
  const { adopt, onError, t } = useRunPlumbing(run.id);
  const router = useRouter();
  const confirm = useConfirm();
  const promoting = run.status === "DRY_RUN_DONE";
  const fresh = useFreshSession(run.id);
  const start = useMutation({
    // A dry run sits for review, so its import session has usually expired: promote with the one the operator
    // just re-entered through the source-session form, when there is one.
    mutationFn: () => (promoting && fresh ? api.startMigrationRun(run.id, { sessionId: fresh.sessionId }) : api.startMigrationRun(run.id)),
    onSuccess: (next) => {
      adopt(next);
      // Promoting a dry-run creates a NEW real run: go to it.
      if (next.id !== run.id) router.push(`/import/runs/${next.id}`);
    },
    onError,
  });
  const onStart = async () => {
    // a plain start has nothing to confirm: the page above it says that nothing touches production before the owner's approval
    if (!promoting) return start.mutate();
    const ok = await confirm({
      title: t("migrationRun.actions.promoteTitle"),
      body: t("migrationRun.actions.promoteBody"),
      confirmLabel: t("migrationRun.actions.promote"),
    });
    if (ok) start.mutate();
  };
  return { onStart, pending: start.isPending, promoting };
}

/** Start / promote, pause and resume: the run's everyday controls, shown in the page header. A finished dry run is started
 *  from its decision screen instead, which says what the real run would do first. */
export function RunHeaderActions({ run }: { run: MigrationRunView }) {
  const { adopt, onError, t } = useRunPlumbing(run.id);
  const confirm = useConfirm();
  const { onStart, pending: starting, promoting } = useStartRun(run);
  const pause = useMutation({ mutationFn: () => api.pauseMigrationRun(run.id), onSuccess: adopt, onError });
  const resume = useMutation({ mutationFn: () => api.resumeMigrationRun(run.id), onSuccess: adopt, onError });
  const onPause = async () => {
    if (await confirm({ title: t("migrationRun.actions.pauseTitle"), body: t("migrationRun.actions.pauseBody"), confirmLabel: t("migrationRun.actions.pause") })) pause.mutate();
  };
  return (
    <>
      {run.allowed.start && !promoting && <Btn onClick={onStart} loading={starting}>{t("migrationRun.actions.start")}</Btn>}
      {run.allowed.pause && <Btn variant="ghost" onClick={onPause} loading={pause.isPending}>{t("migrationRun.actions.pause")}</Btn>}
      {run.allowed.resume && <Btn onClick={() => resume.mutate()} loading={resume.isPending}>{t("migrationRun.actions.resume")}</Btn>}
    </>
  );
}

/** Abort, cleanup, reverse and decommission. Each is offered only when the hub allows it, each names exactly what it
 *  does and does not do, and each is gated by typing a name. Abort never deletes data; reverse admits it can lose some. */
export function RecoveryCard({ run }: { run: MigrationRunView }) {
  const t = useT();
  const { adopt, onError } = useRunPlumbing(run.id);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [includeData, setIncludeData] = useState(false);
  const [dataNames, setDataNames] = useState("");
  const [ackLoss, setAckLoss] = useState(false);
  const close = () => {
    setDialog(null);
    setIncludeData(false);
    setDataNames("");
    setAckLoss(false);
  };
  const done = (next: MigrationRunView) => {
    adopt(next);
    close();
  };
  const abort = useMutation({ mutationFn: (name: string) => api.abortMigrationRun(run.id, { confirmName: name }), onSuccess: done, onError });
  const cleanup = useMutation({
    mutationFn: (name: string) =>
      api.cleanupMigrationRun(run.id, {
        confirmName: name,
        includeData,
        dataConfirmNames: includeData ? dataNames.split("\n").map((s) => s.trim()).filter(Boolean) : [],
      }),
    onSuccess: done,
    onError,
  });
  const reverse = useMutation({ mutationFn: (name: string) => api.reverseMigrationRun(run.id, { confirmName: name, acknowledgeDataLoss: true }), onSuccess: done, onError });
  const decommission = useMutation({ mutationFn: (name: string) => api.decommissionMigrationRun(run.id, { confirmName: name }), onSuccess: done, onError });

  const a = run.allowed;
  const pastPonr = !!run.ponrAt;
  const live = !["ABORTED", "ROLLED_BACK", "REVERSED", "COMPLETED", "DRY_RUN_DONE"].includes(run.status);
  const any = a.abort || a.cleanup || a.reverse || a.decommission;
  if (!any && !(live && pastPonr)) return null;

  const runIdNames = confirmNames("run-id", run) ?? [run.id];
  const hostNames = confirmNames("source-host", run);
  const dataList = dataNames.split("\n").map((s) => s.trim()).filter(Boolean);

  const row = (title: string, body: string, action: React.ReactNode) => (
    <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", padding: "12px 0", borderTop: "1px solid var(--c-bd)" }}>
      <div style={{ flex: "1 1 260px", minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
        <div style={{ fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5, marginTop: 2 }}>{body}</div>
      </div>
      {action}
    </div>
  );

  return (
    <SectionCard title={t("migrationRun.recovery.title")} desc={t("migrationRun.recovery.desc")} style={{ marginBottom: 0 }}>
      {a.abort && !run.inPlace && row(t("migrationRun.recovery.abort"), t("migrationRun.recovery.abortBody"), <Btn variant="dangerGhost" onClick={() => setDialog("abort")}>{t("migrationRun.recovery.abortButton")}</Btn>)}
      {/* an in-place run does not "abort": it gives Coolify back, which is the same undo, asked in one short question */}
      {a.abort && run.inPlace && row(t("inPlaceRun.giveBack.button"), t("inPlaceRun.giveBack.hint"), <GiveBackButton run={run} variant="dangerGhost" />)}
      {!a.abort && pastPonr && live && <div style={{ fontSize: 12, color: "var(--c-am)", padding: "12px 0", borderTop: "1px solid var(--c-bd)", lineHeight: 1.5 }}>{t("migrationRun.recovery.abortRefused")}</div>}
      {a.cleanup && row(t("migrationRun.recovery.cleanup"), t("migrationRun.recovery.cleanupBody"), <Btn variant="dangerGhost" onClick={() => setDialog("cleanup")}>{t("migrationRun.recovery.cleanupButton")}</Btn>)}
      {a.reverse && row(t("migrationRun.recovery.reverse"), t("migrationRun.recovery.reverseBody"), <Btn variant="dangerGhost" onClick={() => setDialog("reverse")}>{t("migrationRun.recovery.reverseButton")}</Btn>)}
      {a.decommission && row(t("migrationRun.recovery.decommission"), t("migrationRun.recovery.decommissionBody"), <Btn variant="dangerGhost" onClick={() => setDialog("decommission")}>{t("migrationRun.recovery.decommissionButton")}</Btn>)}

      {dialog === "abort" && (
        <TypedConfirmDialog
          title={t("migrationRun.recovery.abort")}
          body={t("migrationRun.recovery.abortConfirm")}
          names={runIdNames}
          confirmLabel={t("migrationRun.recovery.abortButton")}
          busy={abort.isPending}
          onConfirm={(typed) => abort.mutate(joinConfirmNames(typed))}
          onClose={close}
        />
      )}
      {dialog === "cleanup" && (
        <TypedConfirmDialog
          title={t("migrationRun.recovery.cleanup")}
          body={t("migrationRun.recovery.cleanupConfirm")}
          names={runIdNames}
          confirmLabel={t("migrationRun.recovery.cleanupButton")}
          busy={cleanup.isPending}
          extraReady={!includeData || dataList.length > 0}
          extra={
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 14 }}>
              <Checkbox checked={includeData} onChange={setIncludeData} label={t("migrationRun.recovery.includeData")} />
              {includeData && (
                <label style={{ display: "block" }}>
                  <span style={{ display: "block", fontSize: 12, color: "var(--c-tx2)", marginBottom: 6, lineHeight: 1.5 }}>{t("migrationRun.recovery.dataNames")}</span>
                  <Textarea mono rows={4} value={dataNames} onChange={(e) => setDataNames(e.target.value)} aria-label={t("migrationRun.recovery.dataNames")} spellCheck={false} />
                </label>
              )}
            </div>
          }
          onConfirm={(typed) => cleanup.mutate(joinConfirmNames(typed))}
          onClose={close}
        />
      )}
      {dialog === "reverse" && (
        <TypedConfirmDialog
          title={t("migrationRun.recovery.reverse")}
          body={t("migrationRun.recovery.reverseConfirm")}
          names={runIdNames}
          confirmLabel={t("migrationRun.recovery.reverseButton")}
          busy={reverse.isPending}
          extraReady={ackLoss}
          extra={<div style={{ marginBottom: 14 }}><Checkbox checked={ackLoss} onChange={setAckLoss} label={<span style={{ color: "var(--c-r)" }}>{t("migrationRun.recovery.ackLoss")}</span>} /></div>}
          onConfirm={(typed) => reverse.mutate(joinConfirmNames(typed))}
          onClose={close}
        />
      )}
      {dialog === "decommission" && hostNames && (
        <TypedConfirmDialog
          title={t("migrationRun.recovery.decommission")}
          body={t("migrationRun.recovery.decommissionConfirm")}
          names={hostNames}
          confirmLabel={t("migrationRun.recovery.decommissionButton")}
          busy={decommission.isPending}
          onConfirm={(typed) => decommission.mutate(joinConfirmNames(typed))}
          onClose={close}
        />
      )}
      {dialog === "decommission" && !hostNames && (
        <TypedConfirmDialog title={t("migrationRun.recovery.decommission")} body={t("migrationRun.approval.issue.nameUnavailable")} names={[""]} confirmLabel={t("migrationRun.recovery.decommissionButton")} extraReady={false} onConfirm={() => undefined} onClose={close} />
      )}
    </SectionCard>
  );
}
