"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { blockerHref, blockersFromError, type TransferBlocker, type TransferDetach } from "../lib/server-transfer";
import type { ServerView } from "../lib/types";
import { useT } from "../i18n/provider";
import { Select } from "./form";
import { Modal } from "./modal";
import { Btn, SectionCard, Spinner } from "./ui";
import { useToast } from "./toast";

/** One blocking resource kind with its (sampled) items as links. */
function BlockerList({ blockers }: { blockers: TransferBlocker[] }) {
  const t = useT();
  return (
    <ul style={{ listStyle: "none", margin: "0 0 12px", padding: 0, display: "grid", gap: 10 }}>
      {blockers.map((b) => (
        <li key={b.kind} data-testid={`blocker-${b.kind}`}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--c-tx)" }}>
            {t(`servers.teamMoveBlocker_${b.kind}`)} <span style={{ color: "var(--c-tx3)", fontWeight: 400 }}>({b.count})</span>
          </div>
          <ul style={{ listStyle: "none", margin: "4px 0 0", padding: 0, display: "flex", flexWrap: "wrap", gap: "2px 12px", fontSize: 13 }}>
            {b.items.map((it) => {
              const href = blockerHref(b.kind, it.id);
              return (
                <li key={it.id} style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                  {href ? <Link href={href} style={{ color: "var(--c-a)" }}>{it.name}</Link> : <span style={{ color: "var(--c-tx2)" }}>{it.name}</span>}
                </li>
              );
            })}
            {b.count > b.items.length && <li style={{ color: "var(--c-tx3)" }}>{t("servers.teamMoveMoreItems", { n: b.count - b.items.length })}</li>}
          </ul>
        </li>
      ))}
    </ul>
  );
}

function detachLine(t: ReturnType<typeof useT>, d: TransferDetach): string {
  if (d.kind === "cloud_credential") return d.name ? t("servers.teamMoveDetachCloud", { name: d.name }) : t("servers.teamMoveDetachCloudUnnamed");
  if (d.kind === "dns_credential") return d.name ? t("servers.teamMoveDetachDns", { name: d.name }) : t("servers.teamMoveDetachDnsUnnamed");
  return t("servers.teamMoveDetachChannels");
}

/** Server page, Settings: move this server to another team (preview first, nothing moves until confirmed). */
export function ServerTeamCard({ id, server }: { id: string; server: ServerView }) {
  const t = useT();
  const qc = useQueryClient();
  const router = useRouter();
  const toast = useToast();
  const [target, setTarget] = useState("");
  const [open, setOpen] = useState(false);
  // Blockers a racing resource reported on confirm (the preview was clean a moment ago).
  const [raced, setRaced] = useState<TransferBlocker[] | null>(null);

  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });
  const { data: targets = [], isLoading: loadingTargets } = useQuery({
    queryKey: ["server-team-targets", id, server.teamId],
    queryFn: () => api.getServerTeamTargets(id),
  });
  const current = teams.find((tm) => tm.id === server.teamId)?.name ?? server.teamId.slice(0, 8);
  const targetName = targets.find((tm) => tm.id === target)?.name ?? "";

  const preview = useQuery({
    queryKey: ["server-team-preview", id, target],
    queryFn: () => api.previewServerTeamChange(id, target),
    enabled: open && !!target,
    retry: false,
    gcTime: 0, // a stale "movable" verdict must never be reused for a later attempt
  });

  const move = useMutation({
    mutationFn: () => api.changeServerTeam(id, target),
    onSuccess: () => {
      toast(t("servers.teamMoveDone", { name: server.name, team: targetName }), "success");
      setOpen(false);
      setTarget("");
      void qc.invalidateQueries({ queryKey: ["server", id] });
      void qc.invalidateQueries({ queryKey: ["servers"] });
      void qc.invalidateQueries({ queryKey: ["server-team-targets", id] });
      // An instance owner may move a server into a team they are not in: they can no longer open it.
      if (!teams.some((tm) => tm.id === target)) router.replace("/servers");
    },
    onError: (e) => {
      const blockers = e instanceof ApiError ? blockersFromError(e.data) : null;
      if (blockers) setRaced(blockers);
    },
  });

  const close = () => {
    if (move.isPending) return;
    setOpen(false);
    setRaced(null);
    move.reset();
  };
  const blockers = raced ?? preview.data?.blockers ?? [];
  const blocked = blockers.length > 0;
  const ready = preview.isSuccess && !blocked;

  return (
    <SectionCard title={t("servers.teamMoveTitle")} desc={t("servers.teamMoveDesc")} style={{ marginTop: 20 }}>
      <p style={{ margin: "0 0 10px", fontSize: 13, color: "var(--c-tx2)" }}>
        {t("servers.teamMoveCurrent")}: <strong style={{ color: "var(--c-tx)" }}>{current}</strong>
      </p>
      {!loadingTargets && targets.length === 0 ? (
        <p style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)" }}>{t("servers.teamMoveNoTargets")}</p>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ flex: "1 1 200px", minWidth: 0, maxWidth: 320 }}>
            <Select
              value={target}
              onChange={setTarget}
              options={targets.map((tm) => ({ value: tm.id, label: tm.name }))}
              placeholder={t("servers.teamMoveSelectPlaceholder")}
              ariaLabel={t("servers.teamMoveSelectLabel")}
              disabled={loadingTargets}
            />
          </div>
          <Btn variant="ghost" disabled={!target} onClick={() => { setRaced(null); setOpen(true); }}>{t("servers.teamMoveAction")}</Btn>
        </div>
      )}

      {open && (
        <Modal onClose={close} labelledBy="team-move-title" width={480}>
          <h3 id="team-move-title" style={{ margin: "0 0 10px", fontSize: 15 }}>{t("servers.teamMoveDialogTitle", { name: server.name, team: targetName })}</h3>

          {preview.isLoading && (
            <p role="status" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--c-tx3)", margin: "0 0 12px" }}>
              <Spinner /> {t("servers.teamMoveChecking")}
            </p>
          )}
          {preview.isError && !raced && (
            <p role="alert" style={{ fontSize: 13, color: "var(--c-r)", margin: "0 0 12px" }}>
              {(preview.error as Error).message || t("servers.teamMoveCheckFailed")}
            </p>
          )}

          {blocked && (
            <>
              <p role="alert" style={{ fontSize: 13, color: "var(--c-tx2)", margin: "0 0 10px" }}>
                {raced ? t("servers.teamMoveBlockedRetry") : t("servers.teamMoveBlocked", { team: current })}
              </p>
              <BlockerList blockers={blockers} />
            </>
          )}

          {ready && (
            <>
              <p style={{ fontSize: 13, color: "var(--c-tx2)", margin: "0 0 10px" }}>{t("servers.teamMoveSafe")}</p>
              <details style={{ margin: "0 0 14px", fontSize: 12, color: "var(--c-tx3)" }}>
                <summary style={{ cursor: "pointer", color: "var(--c-tx2)" }}>{t("servers.teamMoveMore")}</summary>
                <ul style={{ margin: "8px 0 0", paddingLeft: 18, display: "grid", gap: 4, lineHeight: 1.5 }}>
                  <li>{t("servers.teamMoveMoreKeeps")}</li>
                  <li>{t("servers.teamMoveMoreMonitor")}</li>
                  <li>{t("servers.teamMoveOpenShells")}</li>
                  {preview.data.detaches.map((d) => <li key={d.kind}>{detachLine(t, d)}</li>)}
                </ul>
              </details>
            </>
          )}

          {move.isError && !raced && <p role="alert" style={{ color: "var(--c-r)", fontSize: 12, margin: "0 0 10px" }}>{(move.error as Error).message}</p>}

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <Btn variant="ghost" onClick={close} disabled={move.isPending}>{t("common.cancel")}</Btn>
            <Btn onClick={() => move.mutate()} disabled={!ready || !!raced} loading={move.isPending}>
              {move.isPending ? t("servers.teamMoveMoving") : t("servers.teamMoveConfirm")}
            </Btn>
          </div>
        </Modal>
      )}
    </SectionCard>
  );
}
