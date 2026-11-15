"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../../../lib/api";
import { useT } from "../../../../../i18n/provider";
import { Btn, Card, SectionCard, Spinner } from "../../../../../components/ui";
import { ErrorState } from "../../../../../components/error-state";
import { PageHeader } from "../../../../../components/page-header";
import { useToast } from "../../../../../components/toast";
import { useConfirm } from "../../../../../components/confirm";
import { BucketTable } from "../../../../../components/object-migration/bucket-table";
import { PhasePanel } from "../../../../../components/object-migration/phase-panel";
import { FreezeAckDialog } from "../../../../../components/object-migration/freeze-ack-dialog";
import { ConfigCarry } from "../../../../../components/object-migration/config-carry";
import { isLive, nextActions, needsMergeAck } from "../../../../../lib/object-migration";
import { statusLabelKey, warningText } from "../../../../../lib/object-migration-labels";
import type { ObjectMigrationView } from "../../../../../lib/types";

/** Poll fast while a helper is live (progress), slowly otherwise. */
const POLL_LIVE_MS = 3000;

export default function ObjectMigrationPage() {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const router = useRouter();
  const qc = useQueryClient();
  const { id } = useParams<{ id: string }>();
  const key = ["object-migration", id];
  const { data: m, isLoading, isError, refetch } = useQuery({
    queryKey: key,
    queryFn: () => api.getObjectMigration(id),
    refetchInterval: (q) => (isLive(q.state.data as ObjectMigrationView | undefined) ? POLL_LIVE_MS : false),
  });
  const [mergeAck, setMergeAck] = useState(false);
  const [finalOpen, setFinalOpen] = useState(false);
  const done = (v: ObjectMigrationView) => qc.setQueryData(key, v);
  const fail = (e: unknown) => toast((e as Error).message, "error");

  const preflight = useMutation({ mutationFn: () => api.preflightObjectMigration(id), onSuccess: done, onError: fail });
  const save = useMutation({ mutationFn: (rows: Array<{ srcBucket: string; dstBucket: string; selected: boolean; exclude: string[] }>) => api.setObjectMigrationBuckets(id, rows), onSuccess: done, onError: fail });
  const start = useMutation({ mutationFn: (input: Parameters<typeof api.startObjectMigration>[1]) => api.startObjectMigration(id, input), onSuccess: (v) => { done(v); setFinalOpen(false); }, onError: fail });
  const verify = useMutation({ mutationFn: () => api.verifyObjectMigration(id), onSuccess: done, onError: fail });
  const carry = useMutation({ mutationFn: () => api.carryObjectMigrationConfig(id), onSuccess: done, onError: fail });
  const cancel = useMutation({ mutationFn: () => api.cancelObjectMigration(id), onSuccess: done, onError: fail });
  const remove = useMutation({ mutationFn: () => api.deleteObjectMigration(id), onSuccess: () => { toast(t("objectMigration.deleted"), "success"); router.push("/migrations/objects"); }, onError: fail });

  if (isError && !m) return <div style={{ padding: "var(--page-pad)" }}><ErrorState onRetry={() => refetch()} /></div>;
  if (isLoading || !m) return <div style={{ padding: "var(--page-pad)" }}><Spinner /></div>;

  const act = nextActions(m);
  const busy = preflight.isPending || save.isPending || start.isPending || verify.isPending || carry.isPending || cancel.isPending;
  const blockers = m.warnings.filter((w) => w.level === "blocker");
  const notices = m.warnings.filter((w) => w.level !== "blocker");
  const onDelete = async () => {
    if (await confirm({ title: t("objectMigration.delete"), body: t("objectMigration.deleteConfirm"), danger: true })) remove.mutate();
  };
  return (
    <div style={{ padding: "var(--page-pad)", maxWidth: 880, display: "flex", flexDirection: "column", gap: 16 }}>
      <PageHeader
        breadcrumb={[{ label: t("objectMigration.back"), href: "/migrations/objects" }, { label: m.name }]}
        title={m.name}
        status={{ label: t(statusLabelKey(m.status)), color: m.status === "FAILED" ? "var(--c-r)" : m.status === "DONE" ? "var(--c-g)" : "var(--c-am)" }}
        actions={m.canWrite ? <Btn variant="ghost" onClick={onDelete} disabled={isLive(m) || remove.isPending}>{t("objectMigration.delete")}</Btn> : undefined}
      >
        <div className="mono" style={{ fontSize: 11, color: "var(--c-tx3)", wordBreak: "break-all" }}>{m.srcEndpoint} {"->"} {m.dstEndpoint}</div>
      </PageHeader>
      {!m.canWrite && <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: 0 }}>{t("objectMigration.readOnly")}</p>}

      <SectionCard title={t("objectMigration.preflight.title")} desc={t("objectMigration.preflight.notCarried")} style={{ padding: 16, marginBottom: 0 }}>
        {blockers.map((w, i) => (
          <div key={i} role="alert" style={{ fontSize: 12, color: "var(--c-r)", marginBottom: 6 }}>{warningText(t, w)}</div>
        ))}
        {notices.length > 0 && (
          <ul style={{ margin: "0 0 10px", paddingLeft: 18, fontSize: 12, color: "var(--c-am)" }}>
            {notices.map((w, i) => (
              <li key={i}>{warningText(t, w)}</li>
            ))}
          </ul>
        )}
        <Btn onClick={() => preflight.mutate()} disabled={!act.preflight || busy}>{preflight.isPending ? t("objectMigration.preflight.running") : t("objectMigration.preflight.run")}</Btn>
      </SectionCard>

      {m.status !== "DRAFT" && (
        <BucketTable buckets={m.buckets} canEdit={act.select} saving={save.isPending} onSave={(rows) => save.mutate(rows)} />
      )}

      {m.status !== "DRAFT" && (
        <PhasePanel
          m={m}
          h={{
            onSeed: () => start.mutate({ phase: "seed", mergeIntoExisting: mergeAck || undefined }),
            onFinal: () => setFinalOpen(true),
            onVerify: () => verify.mutate(),
            onCancel: () => cancel.mutate(),
            mergeAck,
            onMergeAck: setMergeAck,
            needsMergeAck: needsMergeAck(m),
            busy,
          }}
        />
      )}

      {m.status !== "DRAFT" && <ConfigCarry buckets={m.buckets} canCarry={act.carry} busy={carry.isPending} onCarry={() => carry.mutate()} />}

      <Card style={{ padding: 16 }}>
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>{t("objectMigration.cutover.title")}</div>
        <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "var(--c-tx2)", lineHeight: 1.7 }}>
          <li>{t("objectMigration.cutover.steps.stop")}</li>
          <li>{t("objectMigration.cutover.steps.final")}</li>
          <li>{t("objectMigration.cutover.steps.verify")}</li>
          <li>{t("objectMigration.cutover.steps.endpoint")}</li>
          <li>{t("objectMigration.cutover.steps.start")}</li>
        </ol>
      </Card>

      {finalOpen && (
        <FreezeAckDialog
          busy={start.isPending}
          onCancel={() => setFinalOpen(false)}
          onConfirm={(o) => start.mutate({ phase: "final", acknowledgeWritesFrozen: true, removeExtraneous: o.removeExtraneous || undefined, mergeIntoExisting: mergeAck || undefined })}
        />
      )}
    </div>
  );
}
