"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { Btn, SectionCard } from "../ui";
import { draftToPayload, emptyDraft, validateDraft, type DrainDraft } from "./drain-model";
import { DrainForm, scopeKind, type DrainScope } from "./drain-form";
import { DeliveryInfo, DrainRow } from "./drain-row";

/** Query keys, one per scope (the app card and the server card never share a cache entry). */
export const drainsKey = (scope: DrainScope) => ["logDrains", scope.kind, scope.id] as const;
export const serverAppDrainsKey = (serverId: string) => ["serverAppDrains", serverId] as const;

/** Read-only: app drains shipping from this server (name, type, app link, delivery; never an endpoint). */
function ServerAppDrains({ serverId }: { serverId: string }) {
  const t = useT();
  const { data = [] } = useQuery({ queryKey: serverAppDrainsKey(serverId), queryFn: () => api.listServerAppDrains(serverId) });
  return (
    <div style={{ marginTop: 20, borderTop: "1px solid var(--c-bd)", paddingTop: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{t("logdrains.appDrainsOnServer")}</div>
      {data.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("logdrains.appDrainsOnServerEmpty")}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {data.map((d) => (
            <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, flexWrap: "wrap" }}>
              <span style={{ fontWeight: 600 }}>{d.name}</span>
              <span className="mono" style={{ fontSize: 11, color: "var(--c-tx3)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "1px 5px" }}>{t(`logdrains.type_${d.type.toLowerCase()}`)}</span>
              <Link href={`/apps/${d.appId}`} aria-label={t("logdrains.openApp", { name: d.appName })} style={{ color: "var(--c-a)", fontSize: 12 }}>{d.appName}</Link>
              <DeliveryInfo delivery={d.delivery} status={null} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The log-drain card for a server (server-wide drains, glob container filter) or one app (that app's containers
 * only, compose-service filter, `allowPrivate`). The scope picks the API routes and query key; everything else is
 * shared. A server scope also lists the app drains shipping from the server, read-only.
 */
export function LogDrainCard({ scope }: { scope: DrainScope }) {
  const t = useT();
  const qc = useQueryClient();
  const key = drainsKey(scope);
  const { data: drains = [] } = useQuery({
    queryKey: key,
    queryFn: () => (scope.kind === "server" ? api.listLogDrains(scope.id) : api.listAppLogDrains(scope.id)),
  });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: key });
    if (scope.kind === "server") void qc.invalidateQueries({ queryKey: serverAppDrainsKey(scope.id) });
  };
  const [draft, setDraft] = useState<DrainDraft>(() => emptyDraft("http"));
  const [invalid, setInvalid] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () => {
      const body = draftToPayload(draft, scopeKind(scope));
      return scope.kind === "server" ? api.createLogDrain(scope.id, body) : api.createAppLogDrain(scope.id, body);
    },
    onSuccess: () => {
      setDraft(emptyDraft("http"));
      setInvalid(null);
      invalidate();
    },
  });
  const submit = () => {
    const problem = validateDraft(draft, scopeKind(scope));
    setInvalid(problem);
    if (!problem) add.mutate();
  };

  return (
    <SectionCard title={t("logdrains.title")} desc={scope.kind === "app" ? t("logdrains.descApp") : t("logdrains.desc")} style={{ marginTop: 20 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 14 }}>
        {drains.map((d) => (
          <DrainRow key={d.id} scope={scope} drain={d} onChanged={invalidate} />
        ))}
        {drains.length === 0 && <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("logdrains.empty")}</div>}
      </div>

      <DrainForm scope={scope} draft={draft} onChange={setDraft} mode="create" />
      <div style={{ marginTop: 10 }}>
        <Btn onClick={submit} disabled={add.isPending}>{t("logdrains.add")}</Btn>
      </div>
      {invalid && <div role="alert" style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{t(invalid)}</div>}
      {add.isError && <div role="alert" style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(add.error as Error).message}</div>}

      <div style={{ fontSize: 11, color: "var(--c-tx3)", marginTop: 12 }}>{t("logdrains.lossNote")}</div>
      {scope.kind === "app" && <div style={{ fontSize: 11, color: "var(--c-tx3)", marginTop: 4 }}>{t("logdrains.previewNote")}</div>}
      {scope.kind === "server" && <ServerAppDrains serverId={scope.id} />}
    </SectionCard>
  );
}
