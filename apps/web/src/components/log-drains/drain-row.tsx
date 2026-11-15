"use client";

import { useState } from "react";
import { Pencil } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { useConfirm } from "../confirm";
import { IconBtn } from "../icon-btn";
import { Badge, Btn } from "../ui";
import type { DrainDelivery, LogDrain } from "../../lib/types";
import { draftFromDrain, draftToPayload, validateDraft, type DrainDraft } from "./drain-model";
import { DrainForm, scopeKind, type DrainScope } from "./drain-form";

const DELIVERY_TONE: Record<DrainDelivery, "muted" | "gold" | "lapis" | "danger" | "warn" | "ok"> = {
  ok: "ok",
  pending: "muted",
  offline: "warn",
  agent_outdated: "warn",
  capability_revoked: "warn",
  disabled: "muted",
  error: "danger",
  invalid: "danger",
};

/** Delivery badge + one status line (lines sent / dropped, last delivery, the failure class). */
export function DeliveryInfo({ delivery, status }: { delivery: DrainDelivery; status: LogDrain["status"] }) {
  const t = useT();
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <Badge tone={DELIVERY_TONE[delivery] ?? "muted"}>{t(`logdrains.delivery_${delivery}`)}</Badge>
      {status && (
        <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>
          {t("logdrains.status_line", { sent: status.sent, dropped: status.dropped })}
          {status.truncated ? ` · ${t("logdrains.truncatedLines", { n: status.truncated })}` : ""}
          {status.errClass ? ` · ${t(`logdrains.err_${status.errClass}`)}` : ""}
          {status.lastOkAt ? ` · ${t("logdrains.lastDelivery", { time: new Date(status.lastOkAt).toLocaleString() })}` : ""}
        </span>
      )}
    </span>
  );
}

/** Update/delete go through the scope's own API functions (server vs app route). */
export function drainApi(scope: DrainScope) {
  return scope.kind === "server"
    ? {
        update: (drainId: string, body: Parameters<typeof api.updateLogDrain>[2]) => api.updateLogDrain(scope.id, drainId, body),
        remove: (drainId: string) => api.deleteLogDrain(scope.id, drainId),
      }
    : {
        update: (drainId: string, body: Parameters<typeof api.updateAppLogDrain>[2]) => api.updateAppLogDrain(scope.id, drainId, body),
        remove: (drainId: string) => api.deleteAppLogDrain(scope.id, drainId),
      };
}

/**
 * One drain: a compact row (enabled toggle, name, type badge, endpoint, delivery state, edit, delete) that flips
 * into the inline edit form. A blank token / shared key on save means "keep the stored one" (never wiped blindly).
 */
export function DrainRow({ scope, drain, onChanged }: { scope: DrainScope; drain: LogDrain; onChanged: () => void }) {
  const t = useT();
  const confirm = useConfirm();
  const calls = drainApi(scope);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DrainDraft>(() => draftFromDrain(drain));
  const [invalid, setInvalid] = useState<string | null>(null);
  const reset = () => {
    setDraft(draftFromDrain(drain));
    setInvalid(null);
    setEditing(false);
  };
  const save = useMutation({
    mutationFn: () => calls.update(drain.id, draftToPayload(draft, scopeKind(scope))),
    onSuccess: () => {
      setEditing(false);
      onChanged();
    },
  });
  const toggle = useMutation({ mutationFn: (enabled: boolean) => calls.update(drain.id, { enabled }), onSuccess: onChanged });
  const del = useMutation({ mutationFn: () => calls.remove(drain.id), onSuccess: onChanged });
  const submit = () => {
    const problem = validateDraft(draft, scopeKind(scope));
    setInvalid(problem);
    if (!problem) save.mutate();
  };

  if (editing) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "10px 0", borderTop: "1px solid var(--c-bd)" }}>
        <DrainForm scope={scope} draft={draft} onChange={setDraft} hasToken={drain.hasToken} mode="edit" />
        <div style={{ display: "flex", gap: 8 }}>
          <Btn onClick={submit} disabled={save.isPending}>{t("common.save")}</Btn>
          <Btn variant="ghost" onClick={reset} disabled={save.isPending}>{t("common.cancel")}</Btn>
        </div>
        {invalid && <div role="alert" style={{ color: "var(--c-r)", fontSize: 12 }}>{t(invalid)}</div>}
        {save.isError && <div role="alert" style={{ color: "var(--c-r)", fontSize: 12 }}>{(save.error as Error).message}</div>}
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, flexWrap: "wrap" }}>
        <input type="checkbox" checked={drain.enabled} onChange={(e) => toggle.mutate(e.target.checked)} aria-label={drain.name} />
        <span style={{ fontWeight: 600, minWidth: 100, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis" }}>{drain.name}</span>
        <span className="mono" style={{ fontSize: 11, color: "var(--c-tx3)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "1px 5px" }}>{t(`logdrains.type_${drain.type.toLowerCase()}`)}</span>
        <span className="mono" style={{ fontSize: 11, color: "var(--c-tx3)", flex: 1, minWidth: 120, overflow: "hidden", textOverflow: "ellipsis" }}>{drain.endpoint}</span>
        <IconBtn label={t("common.edit")} onClick={() => setEditing(true)}><Pencil size={14} /></IconBtn>
        <IconBtn label={t("common.delete")} danger onClick={async () => { if (await confirm({ body: t("common.deleteConfirm"), danger: true })) del.mutate(); }}>×</IconBtn>
      </div>
      <div style={{ paddingLeft: 26 }}>
        <DeliveryInfo delivery={drain.delivery} status={drain.status} />
        {drain.containers.length > 0 && (
          <span className="mono" style={{ fontSize: 11, color: "var(--c-tx3)", marginLeft: 8 }}>{drain.containers.join(", ")}</span>
        )}
      </div>
      {(toggle.isError || del.isError) && <div role="alert" style={{ color: "var(--c-r)", fontSize: 12, paddingLeft: 26 }}>{((toggle.error ?? del.error) as Error).message}</div>}
    </div>
  );
}
