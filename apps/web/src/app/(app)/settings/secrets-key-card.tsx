"use client";

import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../i18n/provider";
import { Badge, Btn, Card } from "../../../components/ui";
import { useToast } from "../../../components/toast";

/**
 * Owner-only master-key rotation panel: which key is current, which previous keys are still configured, how
 * many stored secrets are not yet under the current key, and the Re-encrypt action. Never shows a key or a
 * secret value — only ids and counts. Polls while a re-encryption runs.
 */
export function SecretsKeyCard() {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const isOwner = !!user?.isInstanceOwner;
  const { data, isError } = useQuery({
    queryKey: ["secretsKey"],
    queryFn: () => api.getSecretsKeyStatus(),
    enabled: isOwner,
    refetchInterval: (q) => (q.state.data?.running ? 2000 : false),
    refetchOnWindowFocus: false,
  });
  const run = useMutation({
    mutationFn: () => api.reencryptSecrets(),
    onSuccess: () => {
      toast(t("settings.secretsKeyStarted"), "success");
      qc.invalidateQueries({ queryKey: ["secretsKey"] });
    },
    onError: (e) => toast(e instanceof Error && e.message ? e.message : t("settings.secretsKeyFailed"), "error"),
  });
  if (!isOwner) return null;

  const rotating = (data?.previousKeyIds.length ?? 0) > 0;
  const pending = !!data && (data.totals.stale > 0 || data.totals.unreadable > 0);
  const recovery = data?.hmacRowsOnOldKeys.find((h) => h.count && h.count > 0);
  return (
    <Card style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, flex: 1 }}>{t("settings.secretsKey")}</h3>
        {data && (
          <Badge tone={data.running ? "lapis" : pending ? "warn" : rotating ? "ok" : "muted"}>
            {data.running ? t("settings.secretsKeyRunning") : pending ? t("settings.secretsKeyBadgePending") : rotating ? t("settings.secretsKeyBadgeRemovable") : t("settings.secretsKeyBadgeIdle")}
          </Badge>
        )}
      </div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "8px 0 12px" }}>{t("settings.secretsKeyDesc")}</p>
      {isError && !data && <div role="alert" style={{ fontSize: 12, color: "var(--c-r)" }}>{t("settings.secretsKeyFailed")}</div>}
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
          {rotating && (
            <div role="status" style={{ color: data.previousKeyRemovable ? "var(--c-g)" : "var(--c-am)", fontSize: 12 }}>
              {data.previousKeyRemovable ? t("settings.secretsKeyRemovable") : t("settings.secretsKeyPending")}
            </div>
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
    </Card>
  );
}
