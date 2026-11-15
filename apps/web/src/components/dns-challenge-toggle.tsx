"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";

/**
 * Per-app switch: issue the custom domain's certificate with DNS-01 instead of HTTP-01. It needs DNS-01
 * credentials on the app's server, so enabling is disabled (with the reason) when the server has none; turning
 * it OFF is always allowed. The hub answers 400 when enabling is not possible, and that message is shown inline.
 */
export function DnsChallengeToggle({ appId, serverId, dnsChallenge }: { appId: string; serverId: string; dnsChallenge: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [on, setOn] = useState(dnsChallenge);
  useEffect(() => setOn(dnsChallenge), [dnsChallenge]);
  const { data: server, isLoading } = useQuery({ queryKey: ["server", serverId], queryFn: () => api.getServer(serverId) });
  const hasCreds = !!server && (server.hasDnsCreds || !!server.dnsCredentialId);
  const save = useMutation({
    mutationFn: (next: boolean) => api.setAppDomainOptions(appId, { dnsChallenge: next }),
    onSuccess: (_r, next) => {
      setOn(next);
      void qc.invalidateQueries({ queryKey: ["app", appId] });
    },
  });
  const blocked = !on && !hasCreds; // can always switch it off; switching it on needs credentials
  return (
    <div style={{ marginTop: 10 }}>
      <label style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 13, color: blocked ? "var(--c-tx3)" : "var(--c-tx2)" }}>
        <input type="checkbox" checked={on} disabled={blocked || save.isPending} onChange={(e) => save.mutate(e.target.checked)} style={{ marginTop: 2 }} />
        <span>
          {t("apps.domainDnsChallenge.label")}
          <span style={{ display: "block", fontSize: 11, color: "var(--c-tx3)" }}>{t("apps.domainDnsChallenge.desc")}</span>
        </span>
      </label>
      {blocked && (
        <p role="note" style={{ fontSize: 11, color: "var(--c-am)", margin: "4px 0 0" }}>
          {isLoading ? t("apps.domainDnsChallenge.loadingServer") : t("apps.domainDnsChallenge.noCreds")}
        </p>
      )}
      {save.isError && <p role="alert" style={{ fontSize: 12, color: "var(--c-r)", margin: "4px 0 0" }}>{(save.error as Error).message}</p>}
    </div>
  );
}
