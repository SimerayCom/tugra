"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { API_BASE } from "../lib/api";
import { parseAnsi } from "../lib/ansi";
import { useDebounce } from "../hooks/useDebounce";
import { useContainerLogStream } from "../hooks/useContainerLogStream";
import { useT } from "../i18n/provider";
import { Btn, Card, Spinner } from "./ui";
import { TextInput, Select } from "./form";

/**
 * Live `docker logs --follow` viewer, shared by apps, databases and server containers. `basePath`
 * is the resource's API prefix (`/apps/:id`, `/databases/:id`, `/servers/:id/containers`); the hook
 * reads `${basePath}/logs/stream` and the download button reads `${basePath}/logs/download`.
 *
 * `container` pins a specific container (a compose service, or a named server container). `active`
 * gates the stream — a compose app with no container chosen yet passes `active=false` and renders
 * `emptyHint` instead. `headerExtra` lets the caller drop a control (e.g. a container picker) into
 * the toolbar. The viewer owns follow/pause/search/since/tail state; it never shows secrets of its
 * own — the log text itself may contain them, which is why the endpoints are writer-only.
 */
export function LiveLogsCard({
  basePath,
  container,
  active = true,
  title,
  headerExtra,
  emptyHint,
}: {
  basePath: string;
  container?: string;
  active?: boolean;
  title?: string;
  headerExtra?: ReactNode;
  emptyHint?: ReactNode;
}) {
  const t = useT();
  const [following, setFollowing] = useState(true);
  const [paused, setPaused] = useState(false);
  const [since, setSince] = useState("all"); // "all" | "5m" | "1h" — the hub maps "all" → no --since
  const [tail, setTail] = useState(200);
  const [searchInput, setSearchInput] = useState("");
  const search = useDebounce(searchInput, 400); // each keystroke shouldn't restart the SSE stream
  const ref = useRef<HTMLDivElement>(null);
  const { lines, connected, ended } = useContainerLogStream(basePath, { container, follow: following, active, since, search, tail });

  // Auto-scroll to the newest line unless the user paused or turned off follow.
  useEffect(() => {
    const el = ref.current;
    if (el && following && !paused) el.scrollTop = el.scrollHeight;
  }, [lines, following, paused]);

  const download = async () => {
    const params = new URLSearchParams({ tail: "2000" });
    if (container) params.set("container", container);
    if (since) params.set("since", since);
    const res = await fetch(`${API_BASE}${basePath}/logs/download?${params.toString()}`, { credentials: "include" });
    if (!res.ok) return;
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = "container.log";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 600 }}>{title ?? t("apps.liveLogs")}</div>
        {headerExtra}
        <div style={{ flex: 1 }} />
        <TextInput
          placeholder={t("apps.logSearch")}
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          style={{ width: 160, fontSize: 12 }}
        />
        <Select
          value={since}
          onChange={setSince}
          style={{ fontSize: 12 }}
          options={[
            { value: "all", label: t("apps.sinceAll") },
            { value: "5m", label: t("apps.since5m") },
            { value: "1h", label: t("apps.since1h") },
          ]}
        />
        <Select
          value={String(tail)}
          onChange={(v) => setTail(Number(v))}
          style={{ fontSize: 12 }}
          options={[
            { value: "100", label: "100" },
            { value: "200", label: "200" },
            { value: "500", label: "500" },
            { value: "2000", label: "2000" },
          ]}
        />
        <Btn variant="ghost" onClick={() => setPaused((p) => !p)}>{paused ? t("apps.resume") : t("apps.pause")}</Btn>
        <Btn variant="ghost" onClick={() => void download()}>{t("apps.download")}</Btn>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--c-tx2)" }}>
          <input type="checkbox" checked={following} onChange={(e) => setFollowing(e.target.checked)} />
          {t("apps.follow")}
        </label>
      </div>
      {!active ? (
        <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{emptyHint}</div>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, fontSize: 12, color: "var(--c-tx3)" }}>
            {connected && <Spinner />}
            <span>{connected ? (paused ? t("apps.logStreamPaused") : t("apps.streamingLogs")) : ended ? t("apps.logStreamEnded") : t("apps.logStreamConnecting")}</span>
          </div>
          <div
            ref={ref}
            className="mono"
            style={{ margin: 0, fontSize: 11, color: "var(--c-tx2)", whiteSpace: "pre", maxHeight: 360, overflowY: "auto", overflowX: "auto", background: "var(--c-el)", padding: 10, borderRadius: "var(--r1)" }}
          >
            {lines.length
              ? lines.map((line, i) => (
                  <div key={i}>
                    {parseAnsi(line).map((seg, j) => (
                      <span key={j} style={seg.color || seg.bold ? { color: seg.color, fontWeight: seg.bold ? 600 : undefined } : undefined}>
                        {seg.text}
                      </span>
                    ))}
                  </div>
                ))
              : t("apps.logsEmpty")}
          </div>
        </>
      )}
    </Card>
  );
}
