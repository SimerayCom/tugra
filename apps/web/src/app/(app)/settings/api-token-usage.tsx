"use client";

import React from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { relativeTime } from "../../../lib/fleet";
import { useT } from "../../../i18n/provider";

/** A token's bounded recent-use history: when, from where, which tool, which client. Never shows the token. */
export function ApiTokenUsage({ tokenId }: { tokenId: string }) {
  const t = useT();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["apiTokenUsage", tokenId],
    queryFn: () => api.listApiTokenUsage(tokenId),
  });

  const cell: React.CSSProperties = { padding: "6px 10px 6px 0", verticalAlign: "top", fontSize: 12 };
  const head: React.CSSProperties = { ...cell, color: "var(--c-tx3)", fontWeight: 600, textAlign: "left", whiteSpace: "nowrap" };

  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{t("settings.tokenUsageTitle")}</div>
      {isLoading && <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("common.loading")}</div>}
      {isError && <div role="alert" style={{ fontSize: 12, color: "var(--c-r)" }}>{t("settings.tokenUsageFailed")}</div>}
      {data && data.length === 0 && <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("settings.tokenUsageEmpty")}</div>}
      {data && data.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 420 }}>
            <thead>
              <tr>
                <th scope="col" style={head}>{t("settings.tokenUsageColTime")}</th>
                <th scope="col" style={head}>{t("settings.tokenUsageColIp")}</th>
                <th scope="col" style={head}>{t("settings.tokenUsageColTool")}</th>
                <th scope="col" style={head}>{t("settings.tokenUsageColClient")}</th>
              </tr>
            </thead>
            <tbody>
              {data.map((u) => (
                <tr key={u.id} style={{ borderTop: "1px solid var(--c-bd)" }}>
                  <td style={{ ...cell, whiteSpace: "nowrap" }} title={new Date(u.at).toLocaleString()}>{relativeTime(u.at, t)}</td>
                  <td className="mono" style={cell}>{u.ip ?? t("settings.tokenUnknown")}</td>
                  <td className="mono" style={{ ...cell, wordBreak: "break-word" }}>
                    {u.action ?? t("settings.tokenUnknown")}
                    {u.count > 1 && <span style={{ color: "var(--c-tx3)", marginLeft: 6 }}>{t("settings.tokenUsageCount", { n: u.count })}</span>}
                  </td>
                  <td style={{ ...cell, wordBreak: "break-word", color: "var(--c-tx3)" }}>{u.userAgent ?? t("settings.tokenUnknown")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "8px 0 0" }}>{t("settings.tokenUsageNote")}</p>
    </div>
  );
}
