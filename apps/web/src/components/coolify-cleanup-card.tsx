"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CleanupRemnant, CompletenessRow } from "@tugra/shared";
import { api, ApiError } from "../lib/api";
import { useT } from "../i18n/provider";
import { cleanupGuard } from "../lib/launch-guards";
import { MOVE_OFF_HREF, connectHref } from "../lib/coolify-move";
import Link from "next/link";
import { canOfferConfirm, cleanupErrorKey, cleanupNeedsRead, cleanupFailureKey, rowNeedsAttention, sizeText, splitRemnants } from "../lib/coolify-cleanup";
import { Badge, Btn, SectionCard } from "./ui";
import { useConfirm } from "./confirm";

const STATUS_TONE = { CHECKING: "muted", INCOMPLETE: "warn", READY: "ok", CLEANING: "lapis", CLEANED: "ok", FAILED: "danger" } as const;
const RESULT_TONE = { ok: "ok", absent: "muted", in_use: "warn", running: "warn", mounted: "warn", refused: "muted", failed: "danger" } as const;

const li: React.CSSProperties = { borderTop: "1px solid var(--c-bd)", padding: "8px 0", display: "flex", gap: "4px 10px", flexWrap: "wrap", alignItems: "center", minWidth: 0, fontSize: 13 };
const mono: React.CSSProperties = { fontSize: 12, overflowWrap: "anywhere", minWidth: 0 };
const dim: React.CSSProperties = { fontSize: 12, color: "var(--c-tx3)" };

function ChecklistRow({ row }: { row: CompletenessRow }) {
  const t = useT();
  const bad = rowNeedsAttention(row);
  return (
    <li style={li} data-testid={`cleanup-row-${row.kind}`}>
      <span style={{ fontWeight: 600, flex: "1 1 140px" }}>{t(`coolifyCleanup.kind.${row.kind}`)}</span>
      <Badge tone={bad ? "warn" : "ok"}>{t("coolifyCleanup.counts", { tugra: row.tugra, coolify: row.coolify })}</Badge>
      {row.unreadable && <span style={{ ...dim, flexBasis: "100%" }}>{t("coolifyCleanup.unreadable")}</span>}
      {row.missing.length > 0 && <span style={{ ...dim, flexBasis: "100%", overflowWrap: "anywhere" }}>{t("coolifyCleanup.missing", { list: row.missing.join(", ") })}</span>}
      {row.notCarried && row.notCarried.length > 0 && <span style={{ ...dim, flexBasis: "100%" }}>{t("coolifyCleanup.notCarried", { list: row.notCarried.join(", ") })}</span>}
    </li>
  );
}

function RemnantRow({ r }: { r: CleanupRemnant }) {
  const t = useT();
  return (
    <li style={li}>
      <Badge tone="muted">{t(`coolifyCleanup.remnant.${r.kind}`)}</Badge>
      <span className="mono" style={mono}>{r.name}</span>
      {r.sizeBytes !== null && <span style={dim}>{sizeText(r.sizeBytes)}</span>}
      {r.keep && r.reason && <Badge tone="warn">{t(`coolifyCleanup.keep.${r.reason}`)}</Badge>}
    </li>
  );
}

/**
 * "Clean up Coolify" for one server (owner only; the hub enforces it). Checking changes nothing. Removal is offered only for a complete checklist,
 * and only after the owner types the server's name; the request quotes the fingerprint of the list shown, so a changed list is refused.
 */
const GUARD_KEY = { control_plane: "coolifyCleanup.error.control_plane", no_coolify_link: "coolifyCleanup.error.no_coolify_link", read_stale: "coolifyCleanup.error.read_stale" } as const;

export function CoolifyCleanupCard({ serverId, serverName, online, teamId }: { serverId: string; serverName: string; online: boolean; teamId?: string }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const key = ["coolify-cleanup", serverId];
  // the move-off status the page already loads says, before the click, what the hub would refuse: the Coolify host, an unknown server, an old read
  const move = useQuery({ queryKey: ["coolify-move", teamId], queryFn: () => api.coolifyMoveStatus(teamId as string), enabled: !!teamId, staleTime: 15_000, retry: false });
  const guard = cleanupGuard(move.data?.servers.find((x) => x.serverId === serverId), move.data?.hub, Date.now());
  const latest = useQuery({
    queryKey: key,
    queryFn: () => api.coolifyCleanupLatest(serverId),
    refetchInterval: (q) => (q.state.data?.status === "CLEANING" ? 2000 : false),
  });
  const check = useMutation({ mutationFn: () => api.coolifyCleanupCheck(serverId), onSuccess: (v) => qc.setQueryData(key, v) });
  const remove = useMutation({
    mutationFn: (body: { id: string; listHash: string }) => api.coolifyCleanupConfirm(body.id, { confirm: serverName, listHash: body.listHash }),
    onSuccess: (v) => qc.setQueryData(key, v),
    onError: () => qc.invalidateQueries({ queryKey: key }),
  });
  const v = latest.data ?? null;
  const { removable, kept } = splitRemnants(v?.remnants ?? []);
  const err = check.error ?? remove.error;
  // A check that stopped only because no Coolify read knows this server is not a failure: say "read the Coolify first", calmly.
  const needsRead = v?.status === "FAILED" && cleanupNeedsRead(v.failureCode);
  const errNeedsRead = err instanceof ApiError && cleanupNeedsRead(err.code) ? err.code : null;
  const busy = check.isPending || remove.isPending || v?.status === "CHECKING" || v?.status === "CLEANING";

  const onRemove = async () => {
    if (!canOfferConfirm(v)) return;
    const ok = await confirm({
      title: t("coolifyCleanup.confirm.title"),
      body: t("coolifyCleanup.confirmBody", { n: removable.length, server: serverName }),
      confirmLabel: t("coolifyCleanup.confirmLabel", { server: serverName }),
      confirmText: serverName,
      danger: true,
    });
    if (ok) remove.mutate({ id: v.id, listHash: v.listHash });
  };

  return (
    <SectionCard title={t("coolifyCleanup.title")} desc={t("coolifyCleanup.subtitle")} right={v ? needsRead ? <Badge tone="muted">{t("coolifyCleanup.needsRead")}</Badge> : <Badge tone={STATUS_TONE[v.status]}>{t(`coolifyCleanup.status.${v.status}`)}</Badge> : undefined}>
      <p style={{ ...dim, margin: "0 0 10px" }}>{t("coolifyCleanup.intro")}</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Btn variant={v ? "ghost" : "primary"} disabled={!online || busy || !!guard} onClick={() => check.mutate()} style={{ minHeight: 44 }}>
          {check.isPending ? t("coolifyCleanup.checking") : v ? t("coolifyCleanup.recheck") : t("coolifyCleanup.check")}
        </Btn>
        {canOfferConfirm(v) && (
          <Btn variant="danger" disabled={busy} onClick={onRemove} style={{ minHeight: 44 }}>
            {t("coolifyCleanup.confirm.button")}
          </Btn>
        )}
      </div>
      {guard && (
        <p role="note" data-testid="cleanup-guard" style={{ color: "var(--c-am)", fontSize: 12.5, margin: "10px 0 0", lineHeight: 1.5 }}>
          {t(GUARD_KEY[guard])}
          {guard !== "control_plane" && (
            <>
              {" "}
              <Link href={guard === "read_stale" && move.data?.hub ? connectHref(move.data.hub.serverId) : MOVE_OFF_HREF} className="tg-link">{t(guard === "read_stale" ? "coolifyCleanup.guard.readAgain" : "coolifyCleanup.guard.openMoveOff")}</Link>
            </>
          )}
        </p>
      )}
      {err && !errNeedsRead && <p role="alert" style={{ color: "var(--c-r)", fontSize: 12.5, margin: "10px 0 0" }}>{t(cleanupErrorKey(err))}</p>}
      {errNeedsRead && !needsRead && (
        <p role="note" data-testid="cleanup-needs-read" style={{ color: "var(--c-tx2)", fontSize: 12.5, margin: "10px 0 0", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span>{t(cleanupErrorKey(err))}</span>
          <Link href="/import/coolify-host" className="tg-link" style={{ minHeight: 44, display: "inline-flex", alignItems: "center" }}>{t("coolifyCleanup.needsReadLink")}</Link>
        </p>
      )}
      {v?.failureCode && needsRead && (
        <p role="note" data-testid="cleanup-needs-read" style={{ color: "var(--c-tx2)", fontSize: 12.5, margin: "10px 0 0", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span>{t(cleanupFailureKey(v.failureCode) ?? "coolifyCleanup.failure.conflict")}</span>
          <Link href="/import/coolify-host" className="tg-link" style={{ minHeight: 44, display: "inline-flex", alignItems: "center" }}>{t("coolifyCleanup.needsReadLink")}</Link>
        </p>
      )}
      {v?.failureCode && !needsRead && <p role="alert" style={{ color: "var(--c-r)", fontSize: 12.5, margin: "10px 0 0" }}>{t(cleanupFailureKey(v.failureCode) ?? "coolifyCleanup.failure.conflict")}</p>}

      {v && v.completeness.length > 0 && (
        <>
          <h4 style={{ margin: "16px 0 4px", fontSize: 13 }}>{t("coolifyCleanup.checklistTitle")}</h4>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>{v.completeness.map((r) => <ChecklistRow key={r.kind} row={r} />)}</ul>
          <p style={{ ...dim, margin: "8px 0 0", color: v.complete ? "var(--c-g)" : "var(--c-am)" }}>{v.complete ? t("coolifyCleanup.complete") : t("coolifyCleanup.incompleteNote")}</p>
        </>
      )}

      {v && v.status !== "CHECKING" && v.completeness.length > 0 && (
        <>
          <h4 style={{ margin: "16px 0 4px", fontSize: 13 }}>{t("coolifyCleanup.listTitle")}</h4>
          {v.remnants.length === 0 && <p style={dim}>{t("coolifyCleanup.listNone")}</p>}
          {removable.length > 0 && (
            <>
              <div style={{ ...dim, marginTop: 6 }}>{t("coolifyCleanup.removeTitle")}</div>
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>{removable.map((r) => <RemnantRow key={`${r.kind}:${r.name}`} r={r} />)}</ul>
            </>
          )}
          {kept.length > 0 && (
            <>
              <div style={{ ...dim, marginTop: 10 }}>{t("coolifyCleanup.keptTitle")}</div>
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>{kept.map((r) => <RemnantRow key={`${r.kind}:${r.name}`} r={r} />)}</ul>
            </>
          )}
        </>
      )}

      {v && v.results.length > 0 && (
        <ul style={{ listStyle: "none", margin: "12px 0 0", padding: 0 }}>
          {v.results.map((r) => (
            <li key={`${r.kind}:${r.name}`} style={li}>
              <Badge tone={RESULT_TONE[r.code]}>{t(`coolifyCleanup.result.${r.code}`)}</Badge>
              <span className="mono" style={mono}>{r.name}</span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
