"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { AppConfigMount } from "../lib/types";
import { useT } from "../i18n/provider";
import { useToast } from "./toast";
import { Btn, Card } from "./ui";

/**
 * Edit the CONTENT of a COMPOSE app's config mounts. serviceName and target are server-controlled
 * (shown read-only); only content is editable. Content holds `${KEY}` placeholders resolved at deploy,
 * so edits apply on the next deploy. Fetches on demand (content may contain secrets) rather than riding
 * the shared app view. Renders nothing until it has at least one mount.
 */
export function ConfigMountsCard({ id, onDeploy }: { id: string; onDeploy: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const mounts = useQuery({ queryKey: ["app-config-mounts", id], queryFn: () => api.getAppConfigMounts(id) });
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const list = mounts.data ?? [];
  // Keep a draft only while it is dirty; drop it once the server content equals it (saved elsewhere) or
  // its mount disappears. Avoids wiping an in-progress edit when the query refetches.
  useEffect(() => {
    setDrafts((d) => {
      const next: Record<string, string> = {};
      for (const m of list) if (d[m.target] !== undefined && d[m.target] !== m.content) next[m.target] = d[m.target];
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounts.data]);

  const save = useMutation({
    mutationFn: (m: AppConfigMount) => api.setAppConfigMount(id, { target: m.target, content: drafts[m.target] ?? m.content }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["app-config-mounts", id] });
      toast(t("apps.cfgMounts.saved"), "success");
    },
    onError: (e) => toast((e as Error).message, "error"),
  });

  if (mounts.isLoading || list.length === 0) return null;

  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("apps.cfgMounts.title")}</div>
      <div style={{ fontSize: 11, color: "var(--c-tx3)", marginBottom: 12 }}>{t("apps.cfgMounts.hint")}</div>
      {list.map((m) => {
        const val = drafts[m.target] ?? m.content;
        const dirty = val !== m.content;
        const pending = save.isPending && save.variables?.target === m.target;
        return (
          <div key={`${m.serviceName}\u0000${m.target}`} style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--c-tx2)", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "2px 6px" }}>{m.serviceName}</span>
              <span className="mono" style={{ fontSize: 11, color: "var(--c-tx2)", overflowWrap: "anywhere", minWidth: 0 }}>{m.target}</span>
              {m.mode && <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{t("apps.cfgMounts.mode", { mode: m.mode })}</span>}
              {dirty && <span style={{ fontSize: 11, color: "var(--c-am)", marginLeft: "auto" }}>{t("apps.cfgMounts.unsaved")}</span>}
            </div>
            <textarea
              className="mono"
              aria-label={m.target}
              value={val}
              spellCheck={false}
              disabled={pending}
              onChange={(e) => setDrafts((d) => ({ ...d, [m.target]: e.target.value }))}
              style={{ width: "100%", minHeight: 200, maxHeight: 520, resize: "vertical", fontSize: 12, lineHeight: 1.5, color: "var(--c-tx)", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 10, boxSizing: "border-box" }}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8, flexWrap: "wrap" }}>
              <Btn variant="ghost" onClick={() => setDrafts((d) => { const n = { ...d }; delete n[m.target]; return n; })} disabled={!dirty || pending}>{t("apps.cfgMounts.reset")}</Btn>
              <Btn variant="ghost" onClick={() => save.mutate(m)} disabled={!dirty || pending}>{pending ? "…" : t("apps.cfgMounts.save")}</Btn>
              <Btn onClick={() => { save.mutateAsync(m).then(() => onDeploy()).catch(() => {}); }} disabled={pending}>{t("apps.cfgMounts.saveDeploy")}</Btn>
            </div>
          </div>
        );
      })}
      {save.isSuccess && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 4 }}>{t("apps.cfgMounts.redeploy")}</div>}
      {save.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 6 }}>{(save.error as Error).message}</div>}
    </Card>
  );
}
