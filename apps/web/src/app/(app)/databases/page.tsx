"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { dbColor, engineLabel } from "../../../lib/databases";
import type { DbEngine } from "../../../lib/types";
import { useT } from "../../../i18n/provider";
import { Btn, Card, Spinner } from "../../../components/ui";
import { Field, Select, TextInput } from "../../../components/form";
import { TagChips, TagFilter } from "../../../components/tags";

const formGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
  gap: 12,
  alignItems: "end",
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

  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const allTags = [...new Set(databases.flatMap((d) => d.tags))].sort();
  const visible = databases.filter((d) => selectedTags.every((tag) => d.tags.includes(tag)));

  const [name, setName] = useState("");
  const [serverId, setServerId] = useState("");
  const [engine, setEngine] = useState<DbEngine>("POSTGRES");
  const [version, setVersion] = useState("");
  const [hostPort, setHostPort] = useState("");

  const noServer = servers.length === 0;

  const create = useMutation({
    mutationFn: () =>
      api.createDatabase({
        name,
        serverId,
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
        >
          <div style={formGrid}>
            <Field label={t("databases.name")} htmlFor="db-name">
              <TextInput id="db-name" value={name} onChange={(e) => setName(e.target.value)} required />
            </Field>
            <Field label={t("databases.server")}>
              <Select value={serverId} onChange={setServerId} required placeholder={t("databases.server")}
                options={servers.map((s) => ({ value: s.id, label: s.name }))} />
            </Field>
            <Field label={t("databases.engine")}>
              <Select value={engine} onChange={(v) => setEngine(v as DbEngine)}
                options={ENGINES.map((en) => ({ value: en, label: engineLabel(en) }))} />
            </Field>
            <Field label={t("databases.version")} hint={t("databases.versionHint")}>
              <TextInput value={version} onChange={(e) => setVersion(e.target.value)} />
            </Field>
            <Field label={t("databases.hostPort")} hint={t("databases.hostPortHint")}>
              <TextInput type="number" value={hostPort} onChange={(e) => setHostPort(e.target.value)} />
            </Field>
          </div>
          <div style={{ marginTop: 14 }}>
            <Btn type="submit" disabled={create.isPending || noServer}>
              {create.isPending ? "…" : t("databases.create")}
            </Btn>
          </div>
        </form>
        {noServer && (
          <div style={{ fontSize: 12, color: "var(--c-tx3)", marginTop: 10 }}>
            {t("databases.needServer")} <Link href="/servers/new" style={{ color: "var(--c-a)" }}>{t("databases.addServer")}</Link>
          </div>
        )}
        {create.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(create.error as Error).message}</div>}
      </Card>

      {isLoading ? (
        <Spinner />
      ) : (
        <>
          <TagFilter all={allTags} selected={selectedTags} onChange={setSelectedTags} />
          <div style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r2)", overflow: "hidden" }}>
            {visible.map((d) => (
              <Link key={d.id} href={`/databases/${d.id}`} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderTop: "1px solid var(--c-bd)", textDecoration: "none", color: "var(--c-tx)" }}>
                <span style={{ width: 9, height: 9, borderRadius: "50%", background: dbColor(d.status) }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 14, display: "flex", alignItems: "center", gap: 8 }}>
                    {d.name}
                    <TagChips tags={d.tags} />
                  </div>
                  <div className="mono" style={{ fontSize: 11, color: "var(--c-tx3)" }}>{engineLabel(d.engine)} · {d.version}</div>
                </div>
                <span style={{ fontSize: 12, color: dbColor(d.status), fontWeight: 600 }}>{d.status}</span>
              </Link>
            ))}
            {visible.length === 0 && (
              <div style={{ padding: 32, textAlign: "center", color: "var(--c-tx3)", fontSize: 13 }}>{t("databases.empty")}</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
