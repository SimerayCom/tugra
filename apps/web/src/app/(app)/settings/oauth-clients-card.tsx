"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plug } from "lucide-react";
import { api } from "../../../lib/api";
import { relativeTime } from "../../../lib/fleet";
import { useT } from "../../../i18n/provider";
import { useToast } from "../../../components/toast";
import { useConfirm } from "../../../components/confirm";
import { Btn, Card, EmptyState } from "../../../components/ui";
import { SCOPE_OPTIONS } from "./api-token-form";

/** The MCP clients the user signed in to over OAuth, with a one-click revoke. */
export function OAuthClientsCard() {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { data: grants = [] } = useQuery({ queryKey: ["oauthGrants"], queryFn: () => api.listOAuthGrants() });

  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeOAuthGrant(id),
    onSuccess: (_r, id) => {
      toast(t("oauth.revoked", { client: grants.find((g) => g.id === id)?.clientName ?? "" }), "success");
      void qc.invalidateQueries({ queryKey: ["oauthGrants"] });
    },
  });

  const scopeLabel = (sc: string) => {
    const o = SCOPE_OPTIONS.find((s) => s.key === sc);
    return o ? t(`settings.scope${o.stem}`) : sc;
  };

  return (
    <Card style={{ padding: 18 }}>
      <div style={{ fontWeight: 600, marginBottom: 2 }}>{t("oauth.connectedTitle")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("oauth.connectedDesc")}</p>
      {grants.length === 0 ? (
        <EmptyState icon={Plug} title={t("oauth.emptyTitle")}>{t("oauth.empty")}</EmptyState>
      ) : (
        <table className="tok-table" aria-label={t("oauth.connectedTitle")}>
          <thead>
            <tr>
              <th scope="col">{t("oauth.colClient")}</th>
              <th scope="col">{t("oauth.colTeam")}</th>
              <th scope="col">{t("oauth.colAccess")}</th>
              <th scope="col">{t("oauth.colLastUsed")}</th>
              <th scope="col">{t("oauth.colActions")}</th>
            </tr>
          </thead>
          <tbody>
            {grants.map((g) => {
              const team = g.teamName ?? t("oauth.unknownTeam");
              return (
                <tr key={g.id}>
                  <td data-label={t("oauth.colClient")} style={{ fontWeight: 600, wordBreak: "break-word" }}>{g.clientName}</td>
                  <td data-label={t("oauth.colTeam")} style={{ fontSize: 12, color: "var(--c-tx2)", wordBreak: "break-word" }}>{team}</td>
                  <td data-label={t("oauth.colAccess")}>
                    <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {g.scopes.map((sc) => (
                        <span key={sc} title={sc} style={{ fontSize: 11, padding: "1px 7px", borderRadius: 999, background: "var(--c-el)", border: "1px solid var(--c-bd)", color: "var(--c-tx2)" }}>{scopeLabel(sc)}</span>
                      ))}
                    </span>
                  </td>
                  <td data-label={t("oauth.colLastUsed")} style={{ fontSize: 12, color: "var(--c-tx3)" }}>
                    {g.lastUsedAt ? <span title={new Date(g.lastUsedAt).toLocaleString()}>{relativeTime(g.lastUsedAt, t)}</span> : t("oauth.never")}
                  </td>
                  <td data-label={t("oauth.colActions")}>
                    <Btn
                      variant="dangerGhost"
                      disabled={revoke.isPending}
                      aria-label={t("oauth.revokeTitle", { client: g.clientName })}
                      onClick={async () => {
                        if (await confirm({ title: t("oauth.revokeTitle", { client: g.clientName }), body: t("oauth.revokeBody", { client: g.clientName, team }), danger: true })) revoke.mutate(g.id);
                      }}
                    >
                      {t("oauth.revoke")}
                    </Btn>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}
