"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Maximize2, Minimize2, Terminal as TerminalIcon, RefreshCw } from "lucide-react";
import { api } from "../../../lib/api";
import { useT } from "../../../i18n/provider";
import { Spinner } from "../../../components/ui";
import { TerminalTargetPicker } from "../../../components/terminal-target-picker";
import { targetFromQuery, terminalQuery, type TerminalStatus, type TerminalTarget } from "../../../lib/ws";

const TerminalView = dynamic(() => import("../../../components/terminal"), { ssr: false, loading: () => <Spinner /> });

const STATUS_COLOR: Record<TerminalStatus, string> = {
  open: "var(--c-g)",
  connecting: "var(--c-am)",
  reconnecting: "var(--c-am)",
  closed: "var(--c-tx3)",
  denied: "var(--c-r)",
};

export default function ShellPage() {
  return (
    <Suspense fallback={<div style={{ padding: "var(--page-pad)" }}><Spinner /></div>}>
      <ShellInner />
    </Suspense>
  );
}

function ShellInner() {
  const t = useT();
  const router = useRouter();
  const params = useSearchParams();
  const target = useMemo(() => targetFromQuery(new URLSearchParams(params.toString())), [params]);
  const [status, setStatus] = useState<TerminalStatus>("connecting");
  const [isFull, setIsFull] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onFs = () => setIsFull(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
    else rootRef.current?.requestFullscreen?.().catch(() => undefined);
  };

  // A friendly title for the toolbar (fetched lazily from the id in the query).
  const title = useTargetTitle(target);

  if (!target) {
    return (
      <div style={{ padding: "var(--page-pad)" }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px", display: "flex", alignItems: "center", gap: 8 }}>
          <TerminalIcon size={20} color="var(--c-a)" /> {t("terminal.title")}
        </h1>
        <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: "0 0 22px" }}>{t("terminal.subtitle")}</p>
        <div style={{ textAlign: "center", margin: "8px 0 20px" }}>
          <div style={{ fontWeight: 600, fontSize: 15 }}>{t("terminal.startTitle")}</div>
          <div style={{ fontSize: 13, color: "var(--c-tx3)", marginTop: 4 }}>{t("terminal.startHint")}</div>
        </div>
        <TerminalTargetPicker onPick={(tg) => router.replace(`/shell?${terminalQuery(tg)}`)} />
      </div>
    );
  }

  const badge = t(`terminal.status${status.charAt(0).toUpperCase()}${status.slice(1)}`);

  return (
    <div ref={rootRef} style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0, background: "#0b0b0c" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderBottom: "1px solid var(--c-bd)" }}>
        <TerminalIcon size={15} style={{ color: "var(--c-tx3)" }} aria-hidden />
        <span className="mono" style={{ fontSize: 12, color: "var(--c-tx2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: STATUS_COLOR[status] }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: STATUS_COLOR[status], flexShrink: 0 }} />{badge}
        </span>
        <span style={{ flex: 1 }} />
        <TBtn onClick={() => router.replace("/shell")} label={t("terminal.changeTarget")}><RefreshCw size={14} /></TBtn>
        <TBtn onClick={toggleFullscreen} label={isFull ? t("terminal.exitFullscreen") : t("terminal.fullscreen")}>
          {isFull ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </TBtn>
      </div>
      <div style={{ flex: 1, minHeight: 0, padding: "10px 8px 10px 12px" }}>
        <TerminalView target={target} onStatus={setStatus} />
      </div>
    </div>
  );
}

function TBtn({ onClick, label, children }: { onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 30, height: 28, background: "transparent", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx2)", cursor: "pointer" }}
    >
      {children}
    </button>
  );
}

/** Resolve the target's display name from its id (best-effort; falls back to the id). */
function useTargetTitle(target: TerminalTarget | null): string {
  const kind = target && ("app" in target ? "app" : "database" in target ? "database" : "server");
  const id = target && ("app" in target ? target.app : "database" in target ? target.database : target.server);
  const { data } = useQuery({
    queryKey: ["shell-title", kind, id],
    enabled: !!target,
    queryFn: async () => {
      if (kind === "server") return (await api.getServer(id!)).name;
      if (kind === "app") return (await api.getApp(id!)).name;
      return (await api.getDatabase(id!)).name;
    },
    staleTime: 60_000,
  });
  return data ?? id ?? "";
}
