"use client";

import type { CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { ContainerCrashEvent, ContainerRuntimeState } from "../lib/types";
import { useT } from "../i18n/provider";
import { Badge, EmptyState, Spinner } from "./ui";
import { relativeTime } from "../lib/fleet";
import { containerBadges } from "../lib/container-badges";

// Frozen pre-crash log tail. Mirrors page.tsx's TERMINAL_PRE_STYLE (not exported there); kept local so
// this card never imports the 2.5k-line app page. Bounded height — the tail is already clamped server-side.
const LOG_PRE_STYLE: CSSProperties = {
  margin: "8px 0 0",
  padding: "10px 12px",
  fontSize: 11,
  lineHeight: 1.5,
  color: "#cdd3de",
  background: "#0b0e14",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  borderRadius: "var(--r1)",
  overflow: "auto",
  maxHeight: 280,
};

/** Strip the `tugra_<id>` project prefix so a container reads as its compose service ("wordpress", "db")
 *  instead of the raw `tugra_<cuid>-wordpress-1`. Handles the compose replica form, the swarm task form
 *  (`tugra_<id>[-<svc>].<slot>.<taskid>`), and the bare single-container form. */
function friendlyContainer(name: string): string {
  const swarm = /^tugra_[a-z0-9]+(?:-(.+?))?\.\d+\.[a-z0-9]+$/i.exec(name);
  if (swarm) return swarm[1] ?? "container";
  const m = /^tugra_[a-z0-9]+-(.+)-\d+$/i.exec(name);
  if (m) return m[1];
  if (/^tugra_[a-z0-9]+$/i.test(name)) return "container";
  return name;
}

/** "Crash timeline" card: why this app's containers died — exit code, OOM kills, restart deltas and the
 *  log lines frozen at crash time. Read-level, DB-only (no live agent needed); the raw log tail is
 *  redacted server-side for callers without read:secrets + apps:config. */
export function AppCrashTimelineCard({ id }: { id: string }) {
  const t = useT();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["appRuntimeState", id],
    queryFn: () => api.getAppRuntimeState(id),
    refetchInterval: 10000,
  });
  const containers = data?.containers ?? [];
  const events = data?.events ?? [];

  // Keep showing the last good data on a failed refetch; only surface the error when we have nothing to
  // show. "Couldn't load" must stay distinct from "no crashes" — this card's whole job is diagnosis, so a
  // failed fetch must never read as a clean bill of health. (The card is mounted inside a SectionCard,
  // which supplies the surrounding Card + padding, so every branch here returns bare content.)
  if (isError && !data) {
    return <EmptyState>{t("apps.crash.error")}</EmptyState>;
  }
  if (isLoading && !data) {
    return <div style={{ display: "flex", justifyContent: "center", padding: 8 }}><Spinner /></div>;
  }
  if (containers.length === 0 && events.length === 0) {
    return <EmptyState>{t("apps.crash.empty")}</EmptyState>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {containers.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {containers.map((c) => (
            <ContainerSummary key={c.containerName} c={c} />
          ))}
        </div>
      )}
      {events.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
            {t("apps.crash.timeline")}
          </div>
          {events.map((e) => (
            <CrashRow key={e.id} e={e} />
          ))}
        </div>
      )}
    </div>
  );
}

function ContainerSummary({ c }: { c: ContainerRuntimeState }) {
  const t = useT();
  const running = c.status.toLowerCase() === "running";
  const badges = containerBadges(c);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <span style={{ fontWeight: 600, wordBreak: "break-all" }} title={c.containerName}>{friendlyContainer(c.containerName)}</span>
      <Badge tone={running ? "ok" : "danger"}>{c.status}</Badge>
      {badges.map((b) => (
        <Badge key={b.key} tone={b.tone}>{t(`apps.crash.badge_${b.key}`, b.vars)}</Badge>
      ))}
      {c.finishedAt && !running && (
        <span style={{ fontSize: 12, color: "var(--c-tx3)" }} title={c.finishedAt}>
          {t("apps.crash.finished")} {relativeTime(c.finishedAt)}
        </span>
      )}
    </div>
  );
}

function CrashRow({ e }: { e: ContainerCrashEvent }) {
  const t = useT();
  const kindLabel = e.kind === "oom" ? t("apps.crash.kind_oom") : t("apps.crash.kind_crash");
  return (
    <div style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "10px 12px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Badge tone="danger">{kindLabel}</Badge>
        <span style={{ fontWeight: 600, wordBreak: "break-all" }} title={e.containerName}>{friendlyContainer(e.containerName)}</span>
        {e.exitCode !== 0 && <Badge tone="danger">{t("apps.crash.badge_exit", { code: e.exitCode })}</Badge>}
        {e.restartDelta > 0 && <Badge tone="warn">{t("apps.crash.restartDelta", { n: e.restartDelta })}</Badge>}
        <span style={{ fontSize: 12, color: "var(--c-tx3)", marginLeft: "auto" }} title={e.ts}>{relativeTime(e.ts)}</span>
      </div>
      {e.reason && <div style={{ fontSize: 13, color: "var(--c-tx)", marginTop: 6 }}>{e.reason}</div>}
      {e.logTail ? (
        <details style={{ marginTop: 6 }}>
          <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--c-lapis)" }}>{t("apps.crash.showLog")}</summary>
          {/* tabIndex+role: the tail scrolls, so keyboard-only users must be able to focus it (WCAG 2.1.1). */}
          <pre className="mono" tabIndex={0} role="region" aria-label={t("apps.crash.logRegion")} style={LOG_PRE_STYLE}>{e.logTail}</pre>
        </details>
      ) : e.logRedacted ? (
        <div style={{ fontSize: 12, color: "var(--c-tx3)", marginTop: 6 }}>{t("apps.crash.logRedacted")}</div>
      ) : null}
    </div>
  );
}
