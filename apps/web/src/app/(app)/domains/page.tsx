"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Globe } from "lucide-react";
import { api } from "../../../lib/api";
import { appColor } from "../../../lib/apps";
import type { DomainView } from "../../../lib/types";
import { useT } from "../../../i18n/provider";
import { Card, EmptyState, Spinner } from "../../../components/ui";

function sslColor(state: DomainView["ssl"]["state"]): string {
  if (state === "ok") return "var(--c-g)";
  if (state === "expiring") return "var(--c-am)";
  return "var(--c-tx3)";
}

export default function DomainsPage() {
  const t = useT();
  const { data: domains = [], isLoading } = useQuery({
    queryKey: ["domains"],
    queryFn: () => api.listDomains(),
    refetchInterval: 30000,
  });

  return (
    <div style={{ padding: "var(--page-pad)" }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>{t("domains.title")}</h1>
      <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: "0 0 22px" }}>{t("domains.subtitle")}</p>

      {isLoading ? (
        <Spinner />
      ) : domains.length === 0 ? (
        <Card><EmptyState icon={Globe} title={t("domains.emptyTitle")}>{t("domains.empty")}</EmptyState></Card>
      ) : (
        <div style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r2)", overflow: "hidden" }}>
          {domains.map((d) => {
            const ssl = d.ssl;
            const sslText =
              ssl.state === "error"
                ? t("domains.noCert")
                : ssl.daysRemaining != null
                  ? t("domains.daysLeft", { n: ssl.daysRemaining })
                  : "—";
            return (
              <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderTop: "1px solid var(--c-bd)" }}>
                <span style={{ width: 9, height: 9, borderRadius: "50%", background: sslColor(ssl.state) }} />
                <div style={{ flex: 1 }}>
                  <a href={d.url ?? `https://${d.domain}`} target="_blank" rel="noreferrer" style={{ fontWeight: 600, fontSize: 14, color: "var(--c-lapis)", textDecoration: "none" }}>
                    {d.domain}
                  </a>
                  <div className="mono" style={{ fontSize: 11, color: "var(--c-tx3)", display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
                    <span title={d.appStatus} style={{ width: 7, height: 7, borderRadius: "50%", background: appColor(d.appStatus), flexShrink: 0 }} />
                    <Link href={`/apps/${d.appId}`} style={{ color: "var(--c-tx2)", textDecoration: "none" }}>{d.name}</Link>
                    {(d.domainRedirect || d.securityHeaders) && (
                      <span>
                        {d.domainRedirect ? `· ${t("domains.redirect")}:${d.domainRedirect}` : ""}
                        {d.securityHeaders ? ` · ${t("domains.headers")}` : ""}
                      </span>
                    )}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 12, color: sslColor(ssl.state), fontWeight: 600 }}>{sslText}</div>
                  {ssl.issuer && <div style={{ fontSize: 10, color: "var(--c-tx3)" }}>{ssl.issuer}</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
