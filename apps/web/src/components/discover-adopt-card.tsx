"use client";

import Link from "next/link";
import { useState, useEffect, useRef } from "react";
import { TriangleAlert } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { DiscoveredContainer, DiscoveredPort, DiscoveredStack, ServerView } from "../lib/types";
import { useT } from "../i18n/provider";
import { blockText, serverBlock } from "../lib/cta-readiness";
import { rememberImportFocus } from "../lib/import-focus";
import { BlockedNote } from "./cta-parts";
import { Card, Btn, Badge, EmptyState } from "./ui";
import { Modal } from "./modal";
import { useToast } from "./toast";

function fmtPort(p: DiscoveredPort): string {
  return p.host != null ? `${p.host}→${p.container}/${p.protocol}` : `${p.container}/${p.protocol}`;
}

/** Migrator: scan a server for foreign (non-Tugra) containers and adopt one as a Tugra app.
 *  Writer-only (gated at the call site). Adoption creates the app record and renames the running
 *  container to Tugra's convention — see the warning block for what a later redeploy will NOT carry. */
const PLATFORM = { coolify: "Coolify", dokploy: "Dokploy" } as const;

export function DiscoverAdoptCard({ id, autoScan = 0, teamId, server }: { id: string; autoScan?: number; teamId?: string; server?: Pick<ServerView, "name" | "status" | "canWrite" | "capabilities"> }) {
  const t = useT();
  // Adopting reads and registers the host through the agent: it needs the server online, write access and the deploy capability.
  const block = server ? serverBlock(server, ["deploy"]) : null;
  const blockWhy = block ? blockText(t, block) : undefined;
  const openImport = (platform: "coolify" | "dokploy") => rememberImportFocus({ kind: platform, ...(server?.name ? { fromServerName: server.name } : {}) });
  const [rows, setRows] = useState<DiscoveredContainer[] | null>(null);
  const [stacks, setStacks] = useState<DiscoveredStack[]>([]);
  const [target, setTarget] = useState<DiscoveredContainer | null>(null);
  const [stackTarget, setStackTarget] = useState<DiscoveredStack | null>(null);
  // Adopting a whole stack runs host files with the docker socket: owner/admin only (the hub enforces it too).
  const { data: teams } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams(), enabled: !!teamId, staleTime: 60_000 });
  const role = teams?.find((tm) => tm.id === teamId)?.role;
  const canAdoptStack = role === "OWNER" || role === "ADMIN";

  const scan = useMutation({
    mutationFn: () => api.discoverContainers(id),
    onSuccess: (r) => {
      setRows(r.containers);
      setStacks(r.stacks ?? []);
    },
  });
  // "Review" on the server scan bumps autoScan: start the scan right away instead of asking for a second click.
  const scanRef = useRef(scan);
  scanRef.current = scan;
  useEffect(() => {
    if (autoScan > 0) scanRef.current.mutate();
  }, [autoScan]);

  return (
    <Card style={{ padding: 16, marginTop: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <div style={{ fontWeight: 600, flex: 1 }}>{t("servers.discoverTitle")}</div>
        <Btn onClick={() => scan.mutate()} disabled={scan.isPending || !!block} title={blockWhy}>
          {scan.isPending ? t("servers.scanning") : t("servers.scan")}
        </Btn>
      </div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>
        {t("servers.discoverDesc")} {t("servers.discoverOwnNote")}
      </p>
      {block && <p style={{ margin: "0 0 12px" }}><BlockedNote block={block} serverId={id} /></p>}

      {scan.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginBottom: 8 }}>{(scan.error as Error).message}</div>}

      {rows && rows.length === 0 && <EmptyState>{t("servers.noForeignContainers")}</EmptyState>}

      {rows && rows.length > 0 && (
        <div className="tg-tablewrap">
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
              {rows.map((c) => {
                const stack = c.composeProject ? stacks.find((s) => s.project === c.composeProject) : undefined;
                const firstOfStack = !!stack && stack.firstContainer === c.name;
                return (
                <tr key={c.id || c.name} style={{ borderBottom: "1px solid var(--c-bd)" }}>
                  <td style={td}>
                    <span className="mono" style={{ wordBreak: "break-all" }}>{c.name}</span>
                    {c.state !== "running" && <span style={{ marginLeft: 6 }}><Badge tone="muted">{c.state}</Badge></span>}
                    {firstOfStack && !stack.adoptable && !c.managedBy && (
                      <div data-testid="stack-refusal" style={{ whiteSpace: "normal", fontSize: 11, color: "var(--c-am)", marginTop: 2 }}>
                        {t(`servers.stackRefusal.${stack.reason ?? "no_config"}`)}
                        {stack.reason === "managed" && stack.managedBy && (
                          <> <Link href="/import" onClick={() => openImport(stack.managedBy as "coolify" | "dokploy")} style={{ color: "var(--c-lapis)" }}>{t("servers.cta.openImport")}</Link></>
                        )}
                      </div>
                    )}
                    {firstOfStack && stack.adoptable && (
                      <div data-testid="stack-preview" style={{ whiteSpace: "normal", fontSize: 11, color: "var(--c-tx3)", marginTop: 2 }}>
                        {t("servers.stackPreview", { project: stack.project, n: stack.services.length, services: stack.services.map((s) => s.service).join(", ") })}
                      </div>
                    )}
                  </td>
                  <td style={{ ...td, color: "var(--c-tx3)" }} className="mono">{c.image}</td>
                  <td style={{ ...td, color: "var(--c-tx3)" }} className="mono">
                    {c.ports.length ? c.ports.map(fmtPort).join(", ") : "—"}
                  </td>
                  <td style={{ ...td, textAlign: "right" }}>
                    {c.adoptable ? (
                      <Btn variant="ghost" disabled={!!block} title={blockWhy} onClick={() => setTarget(c)}>{t("servers.adopt")}</Btn>
                    ) : firstOfStack && stack.adoptable && canAdoptStack ? (
                      <Btn variant="ghost" disabled={!!block} title={blockWhy} onClick={() => setStackTarget(stack)}>{t("servers.adoptStack")}</Btn>
                    ) : c.managedBy && (c.platformInfra || /^(coolify|dokploy)([-_]|$)/.test(c.name)) ? (
                      <span style={{ fontSize: 12, color: "var(--c-tx3)", whiteSpace: "normal" }}>{t("servers.cta.infraRow", { platform: PLATFORM[c.managedBy] })}</span>
                    ) : c.managedBy ? (
                      <span style={{ display: "grid", gap: 2, justifyItems: "end", whiteSpace: "normal" }}>
                        <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{t("servers.cta.needsImport", { platform: PLATFORM[c.managedBy] })}</span>
                        <Link href="/import" onClick={() => openImport(c.managedBy as "coolify" | "dokploy")} data-tip={t("servers.adoptManagedHint", { platform: PLATFORM[c.managedBy] })} style={{ fontSize: 12, color: "var(--c-lapis)", textDecoration: "none", whiteSpace: "nowrap" }}>
                          {t("servers.cta.openImport")} →
                        </Link>
                      </span>
                    ) : c.swarm ? (
                      <span style={{ display: "grid", gap: 2, justifyItems: "end", whiteSpace: "normal" }}>
                        <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{t("servers.cta.swarmRefused")}</span>
                        <Link href="/import" onClick={() => openImport("dokploy")} style={{ fontSize: 12, color: "var(--c-lapis)", textDecoration: "none", whiteSpace: "nowrap" }}>
                          {t("servers.cta.openImport")} →
                        </Link>
                      </span>
                    ) : (
                      <span data-tip={stackHint(t, stack, firstOfStack, canAdoptStack)} tabIndex={0}><Badge tone="muted">{t("servers.adoptComposeUnsupported")}</Badge></span>
                    )}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {target && <AdoptModal id={id} container={target} onClose={() => setTarget(null)} onDone={() => { setTarget(null); scan.mutate(); }} />}
      {stackTarget && <AdoptStackModal id={id} stack={stackTarget} onClose={() => setStackTarget(null)} onDone={() => { setStackTarget(null); scan.mutate(); }} />}
    </Card>
  );
}

/** Why a compose member has no Adopt button: the stack's own refusal, or "use the first row" / "owners and admins". */
function stackHint(t: ReturnType<typeof useT>, stack: DiscoveredStack | undefined, first: boolean, canAdoptStack: boolean): string {
  if (!stack) return t("servers.adoptComposeHint");
  if (!stack.adoptable) return t(`servers.stackRefusal.${stack.reason ?? "no_config"}`);
  if (first && !canAdoptStack) return t("servers.stackNeedsAdmin");
  return t("servers.stackAdoptOnFirst", { project: stack.project });
}

function AdoptStackModal({ id, stack, onClose, onDone }: { id: string; stack: DiscoveredStack; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(stack.project);
  const adopt = useMutation({
    mutationFn: () => api.adoptStack(id, { project: stack.project, name: name.trim() }),
    onSuccess: () => {
      toast(t("servers.stackAdoptSuccess", { name: name.trim() }), "success");
      qc.invalidateQueries({ queryKey: ["apps"] });
      onDone();
    },
    onError: (e) => toast((e as Error).message || t("servers.adoptFailed"), "error"),
  });
  return (
    <Modal onClose={onClose} width={560} labelledBy="adopt-stack-title">
      <h3 id="adopt-stack-title" style={{ margin: "0 0 4px", fontSize: 15 }}>{t("servers.stackModalTitle", { project: stack.project })}</h3>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("servers.stackModalDesc")}</p>

      <label style={label} htmlFor="adopt-stack-name">{t("servers.adoptName")}</label>
      <input id="adopt-stack-name" style={field} value={name} onChange={(e) => setName(e.target.value)} />

      <div style={label}>{t("servers.stackServices", { n: stack.services.length })}</div>
      <ul data-testid="stack-services" style={{ listStyle: "none", margin: "0 0 12px", padding: 0, border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", maxHeight: 180, overflowY: "auto" }}>
        {stack.services.map((s) => (
          <li key={s.service} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "2px 10px", padding: "6px 10px", borderBottom: "1px solid var(--c-bd)", fontSize: 12 }}>
            <span className="mono" style={{ fontWeight: 600 }}>{s.service}</span>
            <span className="mono" style={{ color: "var(--c-tx3)", wordBreak: "break-all" }}>{s.image}</span>
            {s.ports.length > 0 && <span className="mono" style={{ color: "var(--c-tx3)" }}>{s.ports.join(", ")}</span>}
            {s.state !== "running" && <Badge tone="muted">{s.state}</Badge>}
          </li>
        ))}
      </ul>

      <div style={label}>{t("servers.stackFiles")}</div>
      <div className="mono" style={{ fontSize: 11, color: "var(--c-tx3)", marginBottom: 12, wordBreak: "break-all" }}>
        {stack.configFiles.map((f) => <div key={f}>{f}</div>)}
      </div>
      {stack.volumes.length > 0 && <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("servers.stackVolumes", { n: stack.volumes.length })}</p>}

      <div style={{ fontSize: 12, color: "var(--c-am)", background: "color-mix(in srgb, var(--c-am) 10%, transparent)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 10, marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 6, marginBottom: 4 }}><TriangleAlert size={13} aria-hidden style={{ flexShrink: 0, marginTop: 1 }} /> {t("servers.stackNoRecreate")}</div>
        <div>{t("servers.stackFilesStay")}</div>
      </div>

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <Btn variant="ghost" onClick={onClose} disabled={adopt.isPending}>{t("servers.cancel")}</Btn>
        <Btn onClick={() => adopt.mutate()} disabled={adopt.isPending || !name.trim()}>
          {adopt.isPending ? t("servers.adopting") : t("servers.adoptStack")}
        </Btn>
      </div>
    </Modal>
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
