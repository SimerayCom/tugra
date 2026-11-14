"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Rocket } from "lucide-react";
import { useConfirm } from "../../../../../../components/confirm";
import { ErrorState } from "../../../../../../components/error-state";
import { PageHeader } from "../../../../../../components/page-header";
import { useToast } from "../../../../../../components/toast";
import { Card, EmptyState, Spinner } from "../../../../../../components/ui";
import { useDeploymentLogStream } from "../../../../../../hooks/useDeployLogStream";
import { useT } from "../../../../../../i18n/provider";
import { ApiError, api } from "../../../../../../lib/api";
import { deploymentColor } from "../../../../../../lib/apps";
import { DeploymentDetailView } from "../../deployment-detail";

/** HTTP status of a failed apiFetch (ApiError carries it); null for network/unknown errors. */
function statusOf(e: unknown): number | null {
  return e instanceof ApiError ? e.status : null;
}

/**
 * /apps/[id]/deployments/[depId] — one deployment, lazy-loaded and deep-linkable (notifications, rollouts and the
 * Deployments list point here). Polls while QUEUED/RUNNING, follows the live build log while the ROW itself is
 * RUNNING, and owns the cancel / rollback / analyze mutations.
 */
export default function DeploymentDetailPage() {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const router = useRouter();
  const params = useParams();
  const id = String(params.id);
  const depId = String(params.depId);

  const appQ = useQuery({ queryKey: ["app", id], queryFn: () => api.getApp(id), refetchInterval: 5000 });
  const depQ = useQuery({
    queryKey: ["deployment", id, depId],
    queryFn: () => api.getDeployment(id, depId),
    refetchInterval: (q) => (q.state.data && (q.state.data.status === "QUEUED" || q.state.data.status === "RUNNING") ? 3000 : false),
    retry: (count, e) => statusOf(e) === null && count < 2,
  });
  const d = depQ.data;
  const live = useDeploymentLogStream(id, depId, d?.status === "RUNNING");

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["deployment", id, depId] });
    void qc.invalidateQueries({ queryKey: ["deployments", id] });
    void qc.invalidateQueries({ queryKey: ["app", id] });
  };
  const errMsg = (e: unknown) => (e instanceof Error && e.message ? e.message : t("apps.actionFailed"));
  const cancel = useMutation({ mutationFn: () => api.cancelDeployment(id, depId), onSuccess: invalidate, onError: (e) => toast(errMsg(e), "error"), meta: { successMessage: t("apps.deployCancelled") } });
  // A rollback creates a NEW deployment row: go to it so the operator watches the rollback itself, not this page.
  const rollback = useMutation({
    mutationFn: () => api.rollbackApp(id, depId),
    onSuccess: (r) => {
      invalidate();
      if (r?.id) router.push(`/apps/${id}/deployments/${r.id}`);
    },
    onError: (e) => toast(errMsg(e), "error"),
  });
  const [aiResult, setAiResult] = useState<string | undefined>(undefined);
  const analyze = useMutation({
    mutationFn: () => api.analyzeDeployment(id, depId),
    onSuccess: (r) => setAiResult(r.analysis),
    onError: (e) => setAiResult((e as Error).message || t("apps.aiFailed")),
  });

  const appName = appQ.data?.name ?? "…";
  const header = (
    <PageHeader
      breadcrumb={[
        { label: t("nav.apps"), href: "/apps" },
        { label: appName, href: `/apps/${id}` },
        { label: t("apps.depBreadcrumbDeployments"), href: `/apps/${id}?tab=deployments` },
        { label: d ? new Date(d.createdAt).toLocaleString() : depId.slice(0, 8) },
      ]}
      title={t("apps.depDetailTitle")}
      icon={<Rocket size={18} color="var(--c-lapis)" />}
      status={d ? { label: d.status, color: deploymentColor(d.status) } : undefined}
    />
  );

  // Only an INITIAL load failure replaces the page; a failed background poll (hub restart, blip) keeps the last
  // good data on screen — exactly when the deploy is "recovering" the operator must not lose the view.
  if (depQ.isError && !d) {
    const code = statusOf(depQ.error);
    return (
      <div style={{ padding: "var(--page-pad)" }}>
        {header}
        {code === 404 || code === 403 ? (
          <Card style={{ padding: 16 }}><EmptyState>{t(code === 404 ? "apps.depNotFound" : "apps.depForbidden")}</EmptyState></Card>
        ) : (
          <ErrorState onRetry={() => void depQ.refetch()} />
        )}
      </div>
    );
  }
  if (!d || !appQ.data) return <div style={{ padding: "var(--page-pad)" }}>{header}<Spinner /></div>;

  return (
    <div style={{ padding: "var(--page-pad)" }}>
      {header}
      <DeploymentDetailView
        app={appQ.data}
        d={d}
        live={d.status === "RUNNING" ? live : null}
        aiResult={aiResult}
        pending={{ cancel: cancel.isPending, rollback: rollback.isPending, analyze: analyze.isPending }}
        onCancel={() => cancel.mutate()}
        onRollback={async () => { if (await confirm({ body: t("apps.rollbackConfirm"), danger: true })) rollback.mutate(); }}
        onAnalyze={() => analyze.mutate()}
      />
    </div>
  );
}
