"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { Btn, SectionCard, Spinner } from "../ui";
import { sessionGone } from "../../lib/import-recovery";
import { loadLaunchHandoff, type LaunchHandoff } from "../../lib/launch-handoff";
import { scopedPlan } from "../../lib/import-scope";
import { GuidedLaunchForm } from "./guided-launch-form";

/** The guided move's launch page, `/import/guided/new?s=<session>`. What the owner chose on the preview comes from the handoff the preview
 *  saved; the plan is read again here, so a reload keeps the page and a changed source is said before anything is created. */
function LaunchPageBody() {
  const t = useT();
  const router = useRouter();
  const sid = useSearchParams().get("s") ?? "";
  // undefined = not read yet (the page renders on the server first)
  const [handoff, setHandoff] = useState<LaunchHandoff | null | undefined>(undefined);
  useEffect(() => {
    setHandoff(loadLaunchHandoff());
  }, []);
  const mine = handoff && handoff.sessionId === sid ? handoff : null;
  const dbModes = mine?.extras.dbDataModes;

  const { data: servers = [], isPending: serversPending } = useQuery({ queryKey: ["servers"], queryFn: () => api.listServers() });
  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });
  const planQ = useQuery({
    queryKey: ["launch-plan", sid, mine?.planHash],
    queryFn: () => api.importPlan({ sourceKind: mine!.kind, sessionId: sid, ...(dbModes && Object.keys(dbModes).length ? { dbDataModes: dbModes } : {}) }),
    enabled: !!mine,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const writable = useMemo(() => servers.filter((s) => s.canWrite).map((s) => ({ id: s.id, name: s.name, teamId: s.teamId, status: s.status, capabilities: s.capabilities, canWrite: s.canWrite })), [servers]);

  const shell = (children: React.ReactNode) => <div style={{ padding: "24px 20px", maxWidth: 760, margin: "0 auto" }}>{children}</div>;
  const back = (
    <Link href="/import" className="tg-link" style={{ fontSize: 13 }}>
      {t("migrationRun.launch.page.back")}
    </Link>
  );

  if (handoff === undefined) return shell(<Spinner />);
  if (!mine) {
    return shell(
      <SectionCard title={t("migrationRun.launch.page.gone.title")}>
        <p data-testid="launch-gone" style={{ fontSize: 13, color: "var(--c-tx2)", lineHeight: 1.5, margin: "0 0 12px" }}>{t("migrationRun.launch.page.gone.body")}</p>
        {back}
      </SectionCard>,
    );
  }
  if (planQ.isPending || serversPending) return shell(<div style={{ display: "grid", gap: 12 }}><Spinner /><p role="status" style={{ margin: 0, fontSize: 13, color: "var(--c-tx3)" }}>{t("migrationRun.launch.page.reading")}</p></div>);
  if (planQ.isError || !planQ.data) {
    const ended = sessionGone(planQ.error);
    return shell(
      <SectionCard title={t(ended ? "migrationRun.launch.page.ended.title" : "migrationRun.launch.page.unreadable.title")}>
        <p role="alert" data-testid="launch-read-failed" style={{ fontSize: 13, color: "var(--c-am)", lineHeight: 1.5, margin: "0 0 12px" }}>{t(ended ? "migrationRun.launch.page.ended.body" : "migrationRun.launch.page.unreadable.body")}</p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          {!ended && <Btn variant="ghost" onClick={() => void planQ.refetch()}>{t("migrationRun.launch.page.retry")}</Btn>}
          {back}
        </div>
      </SectionCard>,
    );
  }
  const full = planQ.data;
  if (full.planHash !== mine.planHash) {
    return shell(
      <SectionCard title={t("migrationRun.launch.page.changed.title")}>
        <p role="alert" data-testid="launch-changed" style={{ fontSize: 13, color: "var(--c-am)", lineHeight: 1.5, margin: "0 0 12px" }}>{t("migrationRun.launch.page.changed.body")}</p>
        {back}
      </SectionCard>,
    );
  }
  const plan = mine.scope ? scopedPlan(full, mine.scope.inScope) : full;
  return shell(
    <GuidedLaunchForm plan={plan} kind={mine.kind} sessionId={sid} servers={writable} teams={teams} extras={mine.extras} scope={mine.scope} onChangeScope={() => router.push("/import")} onRecheck={() => router.push("/import")} backHref="/import" />,
  );
}

export function GuidedLaunchPage() {
  return (
    <Suspense fallback={<div style={{ padding: "24px 20px" }}><Spinner /></div>}>
      <LaunchPageBody />
    </Suspense>
  );
}
