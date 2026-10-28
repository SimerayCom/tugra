"use client";

import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { DiscoveredContainer, DiscoveredPort } from "../lib/types";
import { useT } from "../i18n/provider";
import { Card, Btn, Badge, EmptyState } from "./ui";
import { Modal } from "./modal";
import { useToast } from "./toast";

function fmtPort(p: DiscoveredPort): string {
  return p.host != null ? `${p.host}→${p.container}/${p.protocol}` : `${p.container}/${p.protocol}`;
}

/** Migrator: scan a server for foreign (non-Tugra) containers and adopt one as a Tugra app.
 *  Writer-only (gated at the call site). Adoption creates the app record and renames the running
 *  container to Tugra's convention — see the warning block for what a later redeploy will NOT carry. */
export function DiscoverAdoptCard({ id }: { id: string }) {
  const t = useT();
  const [rows, setRows] = useState<DiscoveredContainer[] | null>(null);
  const [target, setTarget] = useState<DiscoveredContainer | null>(null);

  const scan = useMutation({
    mutationFn: () => api.discoverContainers(id),
    onSuccess: (r) => setRows(r.containers),
  });

  return (
    <Card style={{ padding: 16, marginTop: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <div style={{ fontWeight: 600, flex: 1 }}>{t("servers.discoverTitle")}</div>
        <Btn onClick={() => scan.mutate()} disabled={scan.isPending}>
          {scan.isPending ? t("servers.scanning") : t("servers.scan")}
        </Btn>
      </div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("servers.discoverDesc")}</p>

      {scan.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginBottom: 8 }}>{(scan.error as Error).message}</div>}

      {rows && rows.length === 0 && <EmptyState>{t("servers.noForeignContainers")}</EmptyState>}

      {rows && rows.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--c-tx3)", borderBottom: "1px solid var(--c-bd)" }}>
                <th style={th}>{t("servers.containerName")}</th>
                <th style={th}>image</th>
                <th style={th}>ports</th>
                <th style={th} />
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id || c.name} style={{ borderBottom: "1px solid var(--c-bd)" }}>
                  <td style={td}>
                    <span className="mono" style={{ wordBreak: "break-all" }}>{c.name}</span>
                    {c.state !== "running" && <span style={{ marginLeft: 6 }}><Badge tone="muted">{c.state}</Badge></span>}
                  </td>
                  <td style={{ ...td, color: "var(--c-tx3)" }} className="mono">{c.image}</td>
                  <td style={{ ...td, color: "var(--c-tx3)" }} className="mono">
                    {c.ports.length ? c.ports.map(fmtPort).join(", ") : "—"}
                  </td>
                  <td style={{ ...td, textAlign: "right" }}>
                    {c.adoptable ? (
                      <Btn variant="ghost" onClick={() => setTarget(c)}>{t("servers.adopt")}</Btn>
                    ) : (
                      <Badge tone="muted">{t("servers.adoptComposeUnsupported")}</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {target && <AdoptModal id={id} container={target} onClose={() => setTarget(null)} onDone={() => { setTarget(null); scan.mutate(); }} />}
    </Card>
  );
}

function AdoptModal({
  id,
  container,
  onClose,
  onDone,
}: {
  id: string;
  container: DiscoveredContainer;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(container.name);
  const [portIndex, setPortIndex] = useState(0);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  const toggleEnv = (key: string) =>
    setExcluded((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  const adopt = useMutation({
    mutationFn: () =>
      api.adoptContainer(id, {
        container: container.name,
        name: name.trim(),
        portIndex: container.ports.length ? portIndex : undefined,
        envKeys: container.env.filter((e) => !excluded.has(e.key)).map((e) => e.key),
      }),
    onSuccess: () => {
      toast(t("servers.adoptSuccess", { name: name.trim() }), "success");
      qc.invalidateQueries({ queryKey: ["apps"] });
      onDone();
    },
    onError: (e) => toast((e as Error).message || t("servers.adoptFailed"), "error"),
  });

  return (
    <Modal onClose={onClose} width={520} labelledBy="adopt-title">
      <h3 id="adopt-title" style={{ margin: "0 0 4px", fontSize: 15 }}>{t("servers.adoptModalTitle")}</h3>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 14px" }} className="mono">{container.image}</p>

      <label style={label}>{t("servers.adoptName")}</label>
      <input style={field} value={name} onChange={(e) => setName(e.target.value)} />

      {container.ports.length > 1 && (
        <>
          <label style={label}>{t("servers.adoptPort")}</label>
          <select style={field} value={portIndex} onChange={(e) => setPortIndex(Number(e.target.value))}>
            {container.ports.map((p, i) => (
              <option key={i} value={i}>{fmtPort(p)}</option>
            ))}
          </select>
        </>
      )}

      {container.env.length > 0 && (
        <>
          <label style={label}>{t("servers.adoptEnvReview")}</label>
          <div style={{ maxHeight: 160, overflowY: "auto", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 8, marginBottom: 12 }}>
            {container.env.map((e) => (
              <label key={e.key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, padding: "2px 0" }}>
                <input type="checkbox" checked={!excluded.has(e.key)} onChange={() => toggleEnv(e.key)} />
                <span className="mono" style={{ wordBreak: "break-all" }}>{e.key}</span>
              </label>
            ))}
          </div>
        </>
      )}

      <div style={{ fontSize: 12, color: "var(--c-am)", background: "color-mix(in srgb, var(--c-am) 10%, transparent)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 10, marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 6, marginBottom: 4 }}><TriangleAlert size={13} aria-hidden style={{ flexShrink: 0, marginTop: 1 }} /> {t("servers.adoptDataWarning")}</div>
        <div>{t("servers.adoptImageWarning")}</div>
      </div>

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <Btn variant="ghost" onClick={onClose} disabled={adopt.isPending}>{t("servers.cancel")}</Btn>
        <Btn onClick={() => adopt.mutate()} disabled={adopt.isPending || !name.trim()}>
          {adopt.isPending ? t("servers.adopting") : t("servers.adopt")}
        </Btn>
      </div>
    </Modal>
  );
}

const th: React.CSSProperties = { padding: "8px 10px", fontWeight: 500, whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "8px 10px", whiteSpace: "nowrap" };
const label: React.CSSProperties = { display: "block", fontSize: 12, color: "var(--c-tx3)", margin: "0 0 4px" };
const field: React.CSSProperties = {
  width: "100%",
  padding: "7px 9px",
  fontSize: 13,
  background: "var(--c-bg2)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  marginBottom: 12,
  fontFamily: "inherit",
};
