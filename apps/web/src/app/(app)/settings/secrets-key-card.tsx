"use client";

import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../i18n/provider";
import { Badge, Btn, Card } from "../../../components/ui";
import { Modal } from "../../../components/modal";
import { useToast } from "../../../components/toast";
import type { SecretsKeyInfo } from "../../../lib/types";

const ERR_CODES = new Set(["referenced", "grace", "rotation_running", "ring_degraded", "no_root", "not_decrypt_only", "not_retired", "already_env_root", "unknown_key"]);

/**
 * Owner-only secrets-key panel: rotate the encryption key without a restart, see which keys exist and how many
 * stored secrets each still protects, retire keys nothing uses any more, and run the Re-encrypt job. Never shows a
 * key or a secret value — only ids, roles and counts. Polls while a re-encryption runs.
 */
export function SecretsKeyCard() {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const isOwner = !!user?.isInstanceOwner;
  const [modal, setModal] = useState<"rotate" | "env" | null>(null);
  const [reencryptNow, setReencryptNow] = useState(true);
  const { data, isError } = useQuery({
    queryKey: ["secretsKey"],
    queryFn: () => api.getSecretsKeyStatus(),
    enabled: isOwner,
    refetchInterval: (q) => (q.state.data?.running ? 2000 : false),
    refetchOnWindowFocus: false,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["secretsKey"] });
  const failMessage = (e: unknown, fallback: string) => {
    if (e instanceof ApiError && e.code && ERR_CODES.has(e.code)) return t(`settings.secretsKeyErr.${e.code}`);
    return e instanceof Error && e.message ? e.message : fallback;
  };
  const run = useMutation({
    mutationFn: () => api.reencryptSecrets(),
    onSuccess: () => {
      toast(t("settings.secretsKeyStarted"), "success");
      refresh();
    },
    onError: (e) => toast(e instanceof Error && e.message ? e.message : t("settings.secretsKeyFailed"), "error"),
  });
  const rotate = useMutation({
    mutationFn: (v: { target: "new-key" | "env-root"; reencrypt: boolean }) =>
      api.rotateSecretsKey({ expectedCurrentKeyId: data!.currentKeyId, target: v.target, reencrypt: v.reencrypt }),
    onSuccess: () => {
      setModal(null);
      toast(t("settings.secretsKeyRotated"), "success");
      refresh();
    },
    onError: (e) => {
      setModal(null);
      if (e instanceof ApiError && e.code === "stale_current") {
        refresh(); // the page showed an old active key: reload it, then let the owner decide again
        toast(t("settings.secretsKeyRotateStale"), "error");
        return;
      }
      toast(failMessage(e, t("settings.secretsKeyRotateFailed")), "error");
    },
  });
  const retire = useMutation({
    mutationFn: (id: string) => api.retireSecretsKey(id),
    onSuccess: () => {
      toast(t("settings.secretsKeyRetired"), "success");
      refresh();
    },
    onError: (e) => {
      refresh();
      toast(failMessage(e, t("settings.secretsKeyRotateFailed")), "error");
    },
  });
  const restore = useMutation({
    mutationFn: (id: string) => api.restoreSecretsKey(id),
    onSuccess: () => {
      toast(t("settings.secretsKeyRestored"), "success");
      refresh();
    },
    onError: (e) => {
      refresh();
      toast(failMessage(e, t("settings.secretsKeyRotateFailed")), "error");
    },
  });
  if (!isOwner) return null;

  const keys: SecretsKeyInfo[] = data?.keys ?? [];
  const hasRingKey = keys.some((k) => k.source === "ring");
  const ringActive = keys.some((k) => k.source === "ring" && k.role === "active");
  const degraded = data?.degraded ?? null;
  const pending = !!data && (data.totals.stale > 0 || data.totals.unreadable > 0);
  const anyRetirable = keys.some((k) => k.source === "ring" && k.retirable);
  // Env-only rotation (no data keys): the old "restart without the previous key" note still applies.
  const envRotationDone = !!data && !hasRingKey && data.previousKeyIds.length > 0;
  const recovery = data?.hmacRowsOnOldKeys.find((h) => h.count && h.count > 0);
  const busy = !!data && (data.running || !!degraded || rotate.isPending);
  const roleLabel = (k: SecretsKeyInfo) =>
    k.role === "active" ? t("settings.secretsKeyRoleActive") : k.role === "root" ? t("settings.secretsKeyRoleRoot") : k.role === "retired" ? t("settings.secretsKeyRoleRetired") : t("settings.secretsKeyRoleDecryptOnly");
  const roleTone = (k: SecretsKeyInfo) => (k.role === "active" ? "ok" : k.role === "root" ? "gold" : "muted");
  return (
    <Card style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, flex: 1 }}>{t("settings.secretsKey")}</h3>
        {data && (
          <Badge tone={data.running ? "lapis" : pending ? "warn" : anyRetirable || envRotationDone ? "ok" : "muted"}>
            {data.running ? t("settings.secretsKeyRunning") : pending ? t("settings.secretsKeyBadgePending") : anyRetirable || envRotationDone ? t("settings.secretsKeyBadgeRemovable") : t("settings.secretsKeyBadgeIdle")}
          </Badge>
        )}
        {data && (
          <Btn onClick={() => { setReencryptNow(true); setModal("rotate"); }} disabled={busy}>
            {t("settings.secretsKeyRotate")}
          </Btn>
        )}
      </div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "8px 0 12px" }}>{t("settings.secretsKeyDesc")}</p>
      {isError && !data && <div role="alert" style={{ fontSize: 12, color: "var(--c-r)" }}>{t("settings.secretsKeyFailed")}</div>}
      {degraded && (
        <div role="alert" style={{ fontSize: 12, color: "var(--c-r)", border: "1px solid var(--c-r)", borderRadius: 6, padding: "8px 10px", marginBottom: 12 }}>
          {t("settings.secretsKeyDegraded", { reason: degraded })}
        </div>
      )}
      {data && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
          <div>
            <span style={{ color: "var(--c-tx3)" }}>{t("settings.secretsKeyCurrent")}: </span>
            <code className="mono">{data.currentKeyId}</code>
          </div>
          <div>
            <span style={{ color: "var(--c-tx3)" }}>{t("settings.secretsKeyPrevious")}: </span>
            {data.previousKeyIds.length ? data.previousKeyIds.map((k) => <code key={k} className="mono" style={{ marginRight: 6 }}>{k}</code>) : <span>{t("settings.secretsKeyNoPrevious")}</span>}
          </div>
          <div>{t("settings.secretsKeyTotals", { current: data.totals.current, stale: data.totals.stale, unreadable: data.totals.unreadable })}</div>
          {data.totals.unreadable > 0 && <div role="status" style={{ color: "var(--c-r)", fontSize: 12 }}>{t("settings.secretsKeyUnreadableHint")}</div>}
          {recovery && <div role="status" style={{ color: "var(--c-am)", fontSize: 12 }}>{t("settings.secretsKeyRecoveryCodes", { count: recovery.count ?? 0 })}</div>}
          {data.previousKeyIds.length > 0 && !hasRingKey && (
            <div role="status" style={{ color: data.previousKeyRemovable ? "var(--c-g)" : "var(--c-am)", fontSize: 12 }}>
              {data.previousKeyRemovable ? t("settings.secretsKeyRemovable") : t("settings.secretsKeyPending")}
            </div>
          )}
          {ringActive && !data.downgradeSafe && (
            <div role="status" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", color: "var(--c-am)", fontSize: 12 }}>
              <span style={{ flex: "1 1 240px" }}>{t("settings.secretsKeyDowngradeNote")}</span>
              <Btn variant="ghost" onClick={() => setModal("env")} disabled={busy}>{t("settings.secretsKeyBackToEnv")}</Btn>
            </div>
          )}
          {keys.length > 0 && (
            <details style={{ fontSize: 12 }}>
              <summary style={{ cursor: "pointer", color: "var(--c-tx2)" }}>{t("settings.secretsKeysTable")}</summary>
              <div style={{ display: "flex", flexDirection: "column", marginTop: 6 }}>
                {keys.map((k) => (
                  <div key={k.id} data-testid="secrets-key-row" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "6px 0", borderTop: "1px solid var(--c-bd)" }}>
                    <code className="mono" title={k.id}>{k.id.slice(0, 8)}</code>
                    <Badge tone={roleTone(k)}>{roleLabel(k)}</Badge>
                    <span style={{ color: "var(--c-tx3)" }}>{k.source === "env" ? t("settings.secretsKeySourceEnv") : t("settings.secretsKeySourceRing")}</span>
                    <span style={{ color: "var(--c-tx3)", flex: "1 1 140px" }}>{t("settings.secretsKeyReferenced", { count: k.referenced })}</span>
                    {k.source === "ring" && k.role === "decrypt-only" && (
                      <>
                        <Btn variant="ghost" onClick={() => retire.mutate(k.id)} disabled={!k.retirable || retire.isPending}>{t("settings.secretsKeyRetire")}</Btn>
                        {!k.retirable && k.retireBlockedReason && <span style={{ color: "var(--c-tx3)", flexBasis: "100%" }}>{t(`settings.secretsKeyBlocked.${k.retireBlockedReason}`)}</span>}
                      </>
                    )}
                    {k.source === "ring" && k.role === "retired" && (
                      <Btn variant="ghost" onClick={() => restore.mutate(k.id)} disabled={restore.isPending || !!degraded}>{t("settings.secretsKeyRestore")}</Btn>
                    )}
                  </div>
                ))}
              </div>
            </details>
          )}
          {data.lastRun && (
            <div style={{ fontSize: 12, color: data.lastRun.error ? "var(--c-r)" : "var(--c-tx3)" }}>
              {data.lastRun.error
                ? t("settings.secretsKeyLastRunError", { error: data.lastRun.error })
                : t("settings.secretsKeyLastRun", {
                    when: new Date(data.lastRun.finishedAt ?? data.lastRun.startedAt).toLocaleString(),
                    rewritten: data.lastRun.rewritten,
                    alreadyCurrent: data.lastRun.alreadyCurrent,
                    unreadable: data.lastRun.unreadable,
                    skipped: data.lastRun.skipped,
                    errors: data.lastRun.errors,
                  })}
            </div>
          )}
          {data.models.some((m) => m.stale > 0 || m.unreadable > 0) && (
            <details style={{ fontSize: 12 }}>
              <summary style={{ cursor: "pointer", color: "var(--c-tx2)" }}>{t("settings.secretsKeyModels")}</summary>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {data.models
                  .filter((m) => m.stale > 0 || m.unreadable > 0)
                  .map((m) => (
                    <li key={m.model} className="mono">
                      {m.model}: {t("settings.secretsKeyTotals", { current: m.current, stale: m.stale, unreadable: m.unreadable })}
                    </li>
                  ))}
              </ul>
            </details>
          )}
          <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: 0 }}>{t("settings.secretsKeyBackupNote")}</p>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Btn onClick={() => run.mutate()} disabled={run.isPending || data.running || !pending} loading={run.isPending || data.running}>
              {data.running ? t("settings.secretsKeyRunning") : t("settings.secretsKeyReencrypt")}
            </Btn>
          </div>
        </div>
      )}
      {modal === "rotate" && (
        <Modal ariaLabel={t("settings.secretsKeyRotateTitle")} onClose={() => setModal(null)} zIndex={9000} cardStyle={{ width: 480, maxWidth: "92vw", background: "var(--c-sb)", padding: 20 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 6px" }}>{t("settings.secretsKeyRotateTitle")}</h2>
          <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 14px" }}>{t("settings.secretsKeyRotateBody")}</p>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: 16 }}>
            <input type="checkbox" checked={reencryptNow} onChange={(e) => setReencryptNow(e.target.checked)} />
            {t("settings.secretsKeyRotateReencryptNow")}
          </label>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <Btn variant="ghost" onClick={() => setModal(null)}>{t("common.cancel")}</Btn>
            <Btn onClick={() => rotate.mutate({ target: "new-key", reencrypt: reencryptNow })} loading={rotate.isPending}>{t("settings.secretsKeyRotate")}</Btn>
          </div>
        </Modal>
      )}
      {modal === "env" && (
        <Modal ariaLabel={t("settings.secretsKeyBackToEnv")} onClose={() => setModal(null)} zIndex={9000} cardStyle={{ width: 480, maxWidth: "92vw", background: "var(--c-sb)", padding: 20 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 6px" }}>{t("settings.secretsKeyBackToEnv")}</h2>
          <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 14px" }}>{t("settings.secretsKeyBackToEnvConfirm")}</p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <Btn variant="ghost" onClick={() => setModal(null)}>{t("common.cancel")}</Btn>
            <Btn onClick={() => rotate.mutate({ target: "env-root", reencrypt: true })} loading={rotate.isPending}>{t("settings.secretsKeyBackToEnv")}</Btn>
          </div>
        </Modal>
      )}
    </Card>
  );
}
