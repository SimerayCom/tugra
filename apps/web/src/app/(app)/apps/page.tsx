"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { appColor } from "../../../lib/apps";
import { useT } from "../../../i18n/provider";
import { Card, Spinner } from "../../../components/ui";

const field: React.CSSProperties = {
  padding: "8px 10px",
  background: "var(--c-el)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  fontSize: 13,
  fontFamily: "inherit",
};

export default function AppsPage() {
  const t = useT();
  const qc = useQueryClient();
  const { data: apps = [], isLoading } = useQuery({
    queryKey: ["apps"],
    queryFn: () => api.listApps(),
    refetchInterval: 8000,
  });
  const { data: servers = [] } = useQuery({ queryKey: ["servers"], queryFn: () => api.listServers() });

  const [name, setName] = useState("");
  const [serverId, setServerId] = useState("");
  const [image, setImage] = useState("");
  const [hostPort, setHostPort] = useState("");

  const [domain, setDomain] = useState("");

  const create = useMutation({
    mutationFn: () =>
      api.createApp({
        name,
        serverId: serverId || servers[0]?.id,
        image,
        hostPort: hostPort ? Number(hostPort) : undefined,
        domain: domain || undefined,
      }),
    onSuccess: () => {
      setName("");
      setImage("");
      setHostPort("");
      setDomain("");
      qc.invalidateQueries({ queryKey: ["apps"] });
    },
  });

  return (
    <div style={{ padding: 28 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>{t("apps.title")}</h1>
      <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: "0 0 22px" }}>{t("apps.subtitle")}</p>

      <Card style={{ padding: 16, marginBottom: 20 }}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
          style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}
        >
          <input style={{ ...field, flex: 1, minWidth: 110 }} placeholder={t("apps.name")} value={name} onChange={(e) => setName(e.target.value)} required />
          <select style={field} value={serverId} onChange={(e) => setServerId(e.target.value)}>
            <option value="">{servers[0]?.name ?? t("apps.server")}</option>
            {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <input style={{ ...field, flex: 2, minWidth: 160 }} placeholder={t("apps.image")} value={image} onChange={(e) => setImage(e.target.value)} required />
          <input style={{ ...field, width: 130 }} placeholder={t("apps.hostPort")} value={hostPort} onChange={(e) => setHostPort(e.target.value)} type="number" />
          <input style={{ ...field, flex: 1, minWidth: 150 }} placeholder={t("apps.domain")} value={domain} onChange={(e) => setDomain(e.target.value)} />
          <button type="submit" disabled={create.isPending} style={{ ...field, background: "var(--c-a)", color: "#0d0d11", fontWeight: 600, cursor: "pointer" }}>
            {create.isPending ? "…" : t("apps.create")}
          </button>
        </form>
        {create.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(create.error as Error).message}</div>}
      </Card>

      {isLoading ? (
        <Spinner />
      ) : (
        <div style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r2)", overflow: "hidden" }}>
          {apps.map((a) => (
            <Link key={a.id} href={`/apps/${a.id}`} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderTop: "1px solid var(--c-bd)", textDecoration: "none", color: "var(--c-tx)" }}>
              <span style={{ width: 9, height: 9, borderRadius: "50%", background: appColor(a.status) }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{a.name}</div>
                <div className="mono" style={{ fontSize: 11, color: "var(--c-tx3)" }}>{a.image}</div>
              </div>
              <span style={{ fontSize: 12, color: appColor(a.status), fontWeight: 600 }}>{a.status}</span>
            </Link>
          ))}
          {apps.length === 0 && (
            <div style={{ padding: 32, textAlign: "center", color: "var(--c-tx3)", fontSize: 13 }}>{t("apps.empty")}</div>
          )}
        </div>
      )}
    </div>
  );
}
