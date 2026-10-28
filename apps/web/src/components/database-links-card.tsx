"use client";

import { useState } from "react";
import { Unlink } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import { Btn, Card, EmptyState } from "./ui";
import { Select, fieldStyle } from "./form";

/**
 * Link managed databases to an app so each one's connection URI is injected into the app's env on
 * deploy. v1 is node-local (same-server, classic) linking only; this card is hidden by config-groups
 * for compose/swarm/preview apps, so the picker only needs to offer the app server's unlinked databases.
 */
export function DatabaseLinksCard({ id, serverId, canWrite }: { id: string; serverId: string; canWrite: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const links = useQuery({ queryKey: ["appDatabaseLinks", id], queryFn: () => api.getAppDatabaseLinks(id) });
  const databases = useQuery({ queryKey: ["databases"], queryFn: () => api.listDatabases(), enabled: canWrite });

  const [dbId, setDbId] = useState("");
  const [envVar, setEnvVar] = useState("");
  const [adopt, setAdopt] = useState(false);

  const reset = () => {
    setDbId("");
    setEnvVar("");
    setAdopt(false);
  };

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["appDatabaseLinks", id] });
    qc.invalidateQueries({ queryKey: ["app", id] });
  };

  const link = useMutation({
    mutationFn: () => api.linkAppDatabase(id, { databaseId: dbId, envVar: envVar.trim() || undefined, adoptEnv: adopt || undefined }),
    onSuccess: () => {
      invalidate();
      reset();
    },
    meta: { successMessage: t("apps.dbLinksLinked") },
  });
  const unlink = useMutation({
    mutationFn: (linkId: string) => api.unlinkAppDatabase(id, linkId),
    onSuccess: invalidate,
    meta: { successMessage: t("apps.dbLinksUnlinked") },
  });

  const list = links.data ?? [];
  const linkedIds = new Set(list.map((l) => l.databaseId).filter(Boolean));
  // Only the app server's not-yet-linked databases are eligible for a v1 (internal) link.
  const eligible = (databases.data ?? []).filter((d) => d.serverId === serverId && !linkedIds.has(d.id));

  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("apps.dbLinksTitle")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px", lineHeight: 1.5 }}>{t("apps.dbLinksDesc")}</p>

      {list.length === 0 ? (
        <EmptyState>{t("apps.dbLinksEmpty")}</EmptyState>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {list.map((l) => (
            <div key={l.linkId} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "8px 10px" }}>
              <span style={{ fontWeight: 600, fontSize: 13 }}>{l.restricted ? "•••" : l.name}</span>
              {l.engine && <span style={{ fontSize: 11, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{l.engine}</span>}
              <code style={{ fontSize: 11, background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "1px 6px" }}>{l.envVar}</code>
              {l.shadowedBy === "app-env" && <span style={{ fontSize: 11, color: "var(--c-am)" }}>{t("apps.dbLinksShadowed")}</span>}
              <span style={{ flex: 1 }} />
              {canWrite && (
                <button onClick={() => unlink.mutate(l.linkId)} disabled={unlink.isPending} style={{ background: "transparent", border: "none", color: "var(--c-r)", cursor: "pointer", fontFamily: "inherit", display: "inline-flex", alignItems: "center" }} aria-label={t("apps.dbLinksUnlink")}>
                  <Unlink size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {canWrite && (
        eligible.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <Select
                value={dbId}
                onChange={setDbId}
                placeholder={t("apps.dbLinksPickDb")}
                options={eligible.map((d) => ({ value: d.id, label: `${d.name} · ${d.engine}` }))}
                style={{ minWidth: 200, flex: 1 }}
              />
              <input
                style={{ ...fieldStyle, width: 220 }}
                placeholder={t("apps.dbLinksEnvVarPlaceholder")}
                value={envVar}
                onChange={(e) => setEnvVar(e.target.value)}
                aria-label={t("apps.dbLinksEnvVar")}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--c-tx3)" }}>
              <input type="checkbox" checked={adopt} onChange={(e) => setAdopt(e.target.checked)} />
              {t("apps.dbLinksAdopt")}
            </label>
            <div style={{ display: "flex" }}>
              <div style={{ flex: 1 }} />
              <Btn onClick={() => link.mutate()} disabled={!dbId || link.isPending}>{t("apps.dbLinksLink")}</Btn>
            </div>
          </div>
        ) : (
          <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "12px 0 0", lineHeight: 1.5 }}>{t("apps.dbLinksNoDbs")}</p>
        )
      )}
      {list.length > 0 && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 10 }}>{t("apps.dbLinksRedeploy")}</div>}
    </Card>
  );
}
