"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { dbColor, engineLabel } from "../../../lib/databases";
import type { DbEngine } from "../../../lib/types";
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

const ENGINES: DbEngine[] = ["POSTGRES", "MYSQL", "MARIADB", "REDIS", "KEYDB", "DRAGONFLY", "MONGO", "CLICKHOUSE"];

export default function DatabasesPage() {
  const t = useT();
  const qc = useQueryClient();
  const { data: databases = [], isLoading } = useQuery({
    queryKey: ["databases"],
    queryFn: () => api.listDatabases(),
    refetchInterval: 8000,
  });
  const { data: servers = [] } = useQuery({ queryKey: ["servers"], queryFn: () => api.listServers() });

  const [name, setName] = useState("");
  const [serverId, setServerId] = useState("");
  const [engine, setEngine] = useState<DbEngine>("POSTGRES");
  const [version, setVersion] = useState("");
  const [hostPort, setHostPort] = useState("");

  const create = useMutation({
    mutationFn: () =>
      api.createDatabase({
        name,
        serverId: serverId || servers[0]?.id,
        engine,
        version: version || undefined,
        hostPort: hostPort ? Number(hostPort) : undefined,
      }),
    onSuccess: () => {
      setName("");
      setVersion("");
      setHostPort("");
      qc.invalidateQueries({ queryKey: ["databases"] });
    },
  });

  return (
    <div style={{ padding: 28 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>{t("databases.title")}</h1>
      <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: "0 0 22px" }}>{t("databases.subtitle")}</p>

      <Card style={{ padding: 16, marginBottom: 20 }}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
          style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}
        >
          <input style={{ ...field, flex: 1, minWidth: 120 }} placeholder={t("databases.name")} value={name} onChange={(e) => setName(e.target.value)} required />
          <select style={field} value={serverId} onChange={(e) => setServerId(e.target.value)}>
            <option value="">{servers[0]?.name ?? t("databases.server")}</option>
            {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select style={field} value={engine} onChange={(e) => setEngine(e.target.value as DbEngine)}>
            {ENGINES.map((en) => <option key={en} value={en}>{engineLabel(en)}</option>)}
          </select>
          <input style={{ ...field, width: 130 }} placeholder={t("databases.version")} value={version} onChange={(e) => setVersion(e.target.value)} />
          <input style={{ ...field, width: 130 }} placeholder={t("databases.hostPort")} value={hostPort} onChange={(e) => setHostPort(e.target.value)} type="number" />
          <button type="submit" disabled={create.isPending} style={{ ...field, background: "var(--c-a)", color: "#0d0d11", fontWeight: 600, cursor: "pointer" }}>
            {create.isPending ? "…" : t("databases.create")}
          </button>
        </form>
        {create.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(create.error as Error).message}</div>}
      </Card>

      {isLoading ? (
        <Spinner />
      ) : (
        <div style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r2)", overflow: "hidden" }}>
          {databases.map((d) => (
            <Link key={d.id} href={`/databases/${d.id}`} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderTop: "1px solid var(--c-bd)", textDecoration: "none", color: "var(--c-tx)" }}>
              <span style={{ width: 9, height: 9, borderRadius: "50%", background: dbColor(d.status) }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{d.name}</div>
                <div className="mono" style={{ fontSize: 11, color: "var(--c-tx3)" }}>{engineLabel(d.engine)} · {d.version}</div>
              </div>
              <span style={{ fontSize: 12, color: dbColor(d.status), fontWeight: 600 }}>{d.status}</span>
            </Link>
          ))}
          {databases.length === 0 && (
            <div style={{ padding: 32, textAlign: "center", color: "var(--c-tx3)", fontSize: 13 }}>{t("databases.empty")}</div>
          )}
        </div>
      )}
    </div>
  );
}
