"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../../lib/api";
import { useT } from "../../i18n/provider";
import type { MatchRow } from "../../lib/coolify-agent";
import type { CoolifySshRunView } from "../../lib/coolify-ssh";
import { verifiableRows, verifyProgress } from "../../lib/host-verify";
import { Btn } from "../ui";
import { useOptionalConfirm } from "../confirm";
import { useToast } from "../toast";

type T = ReturnType<typeof useT>;

/** A localized line for a refused call: this card's own code first, then the install card's, else a generic one. */
function errorText(t: T, e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code) {
      for (const key of [`hostMatch.verify.error.${e.code}`, `coolifyInstall.error.${e.code}`]) {
        const text = t(key);
        if (text !== key) return text;
      }
    }
    if (e.status === 403) return t("hostMatch.verify.error.forbidden");
  }
  return t("hostMatch.verify.error.generic");
}

/**
 * "Check these machines automatically": the machines the hub matched only by address ("Probably the same") are asked who they are, read-only,
 * through the Coolify host's agent and Coolify's own SSH access (the same consent as the install, typed number of machines). Nothing is
 * installed. When the check is done the match is read again, so the rows that proved to be the same machine show as "Same machine" by
 * themselves. Owners only (the hub says so); renders nothing when no row can gain from it.
 */
export function HostVerify({ serverId, rows, onDone }: { serverId: string | null; rows: readonly MatchRow[]; onDone: () => void }) {
  const t = useT();
  const toast = useToast();
  const confirm = useOptionalConfirm();
  const uuids = verifiableRows(rows);
  const [started, setStarted] = useState<CoolifySshRunView | null>(null);

  const start = useMutation({
    mutationFn: async (list: string[]): Promise<CoolifySshRunView | null> => {
      try {
        return await api.coolifySshVerify(serverId!, { coolifyServerUuids: list });
      } catch (e) {
        // The hub names the consent it needs; it is asked here, in place, and the call is repeated with the typed number.
        if (!(e instanceof ApiError) || e.code !== "consent_required" || !confirm) throw e;
        const n = list.length;
        const ok = await confirm({ title: t("hostMatch.verify.consentTitle", { n }), body: t("hostMatch.verify.consentBody"), confirmLabel: t("hostMatch.verify.consentLabel"), confirmText: String(n) });
        if (!ok) return null;
        return api.coolifySshVerify(serverId!, { coolifyServerUuids: list, confirm: String(n) });
      }
    },
    onSuccess: (run) => run && setStarted(run),
    onError: (e) => toast(errorText(t, e), "error"),
  });

  const { data: run } = useQuery({
    queryKey: ["coolify-host-verify", serverId, started?.runId],
    queryFn: () => api.coolifySshRun(serverId!, started!.runId),
    enabled: !!serverId && !!started,
    initialData: started ?? undefined,
    refetchInterval: (q) => (q.state.data?.finished === false ? 2000 : false),
    gcTime: 0,
  });

  // The match is read again once, when the check of a run has finished.
  const notified = useRef<string | null>(null);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (run?.finished && notified.current !== run.runId) {
      notified.current = run.runId;
      done.current();
    }
  }, [run?.finished, run?.runId]);

  const progress = verifyProgress(run);
  const working = start.isPending || (!!started && !progress.finished);
  const names = new Map(rows.map((r) => [r.ref, r.name]));
  const failed = (run?.targets ?? []).filter((x) => x.state === "FAILED");

  if (!serverId || !confirm) return null;
  if (uuids.length === 0 && !run) return null;

  return (
    <div data-testid="host-verify" style={{ display: "grid", gap: 8, margin: "0 0 12px" }}>
      {uuids.length > 0 && !working && <p style={{ margin: 0, fontSize: 13, color: "var(--c-tx2)", lineHeight: 1.5 }}>{t("hostMatch.verify.summary", { n: uuids.length })}</p>}
      {working && progress.total > 0 && <p role="status" style={{ margin: 0, fontSize: 13, color: "var(--c-tx2)" }}>{t("hostMatch.verify.progress", { done: progress.done, total: progress.total })}</p>}
      {!working && progress.finished && progress.total > 0 && (
        <p role="status" style={{ margin: 0, fontSize: 13, color: failed.length ? "var(--c-am)" : "var(--c-g)" }}>{t("hostMatch.verify.done", { ok: progress.verified, total: progress.total })}</p>
      )}
      {!working && failed.length > 0 && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>{t("hostMatch.verify.failedTitle")}</div>
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 3 }}>
            {failed.map((x) => (
              <li key={x.id} style={{ fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5, overflowWrap: "anywhere" }}>
                {t("hostMatch.verify.failedLine", { name: names.get(x.coolifyServerUuid) ?? x.name, reason: x.code ? t(`coolifyInstall.code.${x.code}`) : t("hostMatch.verify.error.generic") })}
              </li>
            ))}
          </ul>
        </div>
      )}
      {uuids.length > 0 && (
        <div>
          <Btn onClick={() => start.mutate(uuids)} loading={working} disabled={working}>{t("hostMatch.verify.action")}</Btn>
        </div>
      )}
    </div>
  );
}
