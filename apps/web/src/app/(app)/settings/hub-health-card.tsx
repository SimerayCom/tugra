"use client";

import type { ReactNode } from "react";
import { useHubHealth, warningText } from "../../../hooks/useHubHealth";
import { useAuth } from "../../../lib/auth";
import { fmtBytes, formatUptime } from "../../../lib/fleet";
import { useT } from "../../../i18n/provider";
import { SectionCard } from "../../../components/ui";
import { Sparkline } from "../../../components/charts";
import type { HubHealth, HubHealthWarning } from "../../../lib/types";

function Row({ label, children, tone }: { label: string; children: ReactNode; tone?: "warn" }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13, padding: "5px 0", borderBottom: "1px solid var(--c-bd)" }}>
      <span style={{ color: "var(--c-tx3)" }}>{label}</span>
      <span style={{ fontWeight: 600, textAlign: "right", color: tone === "warn" ? "var(--c-am)" : undefined, minWidth: 0, overflowWrap: "anywhere" }}>{children}</span>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>{title}</div>
      {children}
    </div>
  );
}

/** Owner-only card: how the hub itself is doing (heap, event loop, restarts, Postgres, Redis, queues). */
export function HubHealthCard() {
  const t = useT();
  const { user } = useAuth();
  const isOwner = !!user?.isInstanceOwner;
  const { data, isError } = useHubHealth(isOwner);
  if (!isOwner) return null;

  const heapWarn = !!data?.warnings.some((w) => w.code === "heap_high");
  const loopWarn = !!data?.warnings.some((w) => w.code === "loop_lag");
  return (
    <SectionCard
      id="hub-health"
      title={t("settings.hubHealthTitle")}
      desc={t("settings.hubHealthHint")}
      right={data ? <span style={{ fontSize: 12, fontWeight: 600, color: data.healthy ? "var(--c-g)" : "var(--c-am)" }}>{data.healthy ? t("settings.hubHealthOk") : t("settings.hubHealthWarn")}</span> : null}
    >
      {isError && !data && <p style={{ fontSize: 13, color: "var(--c-r)", margin: 0 }}>{t("settings.hubHealthLoadFailed")}</p>}
      {data && <HubHealthBody h={data} heapWarn={heapWarn} loopWarn={loopWarn} />}
    </SectionCard>
  );
}

function HubHealthBody({ h, heapWarn, loopWarn }: { h: HubHealth; heapWarn: boolean; loopWarn: boolean }) {
  const t = useT();
  const na = t("settings.hubHealthUnavailable");
  return (
    <div>
      {h.warnings.length > 0 && (
        <ul style={{ margin: "0 0 10px", padding: "0 0 0 18px", fontSize: 13, color: "var(--c-am)" }}>
          {h.warnings.map((w, i) => (
            <li key={`${w.code}-${w.detail ?? i}`}>{warningText(t, w)}</li>
          ))}
        </ul>
      )}
      <Row label={t("settings.hubHealthUptime")}>{formatUptime(h.uptimeSec)}</Row>
      <Row label={t("settings.hubHealthRestarts")}>
        <span title={t("settings.hubHealthRestartsHint")}>{h.restarts.last24h}</span>
      </Row>
      <Row label={t("settings.hubHealthRss")}>{Math.round(h.process.rssMb)} MB</Row>
      <Row label={t("settings.hubHealthHeap")} tone={heapWarn ? "warn" : undefined}>
        {Math.round(h.process.heapUsedMb)} / {Math.round(h.process.heapLimitMb)} MB
        <span style={{ display: "block", fontSize: 11, color: "var(--c-tx3)", fontWeight: 400 }}>{t("settings.hubHealthHeapPct", { pct: Math.round(h.process.heapPct) })}</span>
      </Row>
      <Row label={t("settings.hubHealthLoop")} tone={loopWarn ? "warn" : undefined}>{t("settings.hubHealthLoopVal", { p50: h.eventLoop.p50Ms, p99: h.eventLoop.p99Ms })}</Row>
      <Row label={t("settings.hubHealthGc")}>{t("settings.hubHealthGcVal", { ms: h.process.gcMs })}</Row>
      {h.history.length >= 2 && (
        <div style={{ margin: "8px 0 0" }}>
          <div style={{ fontSize: 11, color: "var(--c-tx3)", marginBottom: 2 }}>{t("settings.hubHealthTrend")}</div>
          <Sparkline data={h.history.map((x) => x.rssMb)} times={h.history.map((x) => x.t)} width={300} height={36} label={t("settings.hubHealthTrend")} />
        </div>
      )}

      <Group title={t("settings.hubHealthPostgres")}>
        {h.postgres ? (
          <>
            <Row label={t("settings.hubHealthPgConn", { used: h.postgres.connectionsUsed, max: h.postgres.connectionsMax })}>{t("settings.hubHealthPgSize", { size: fmtBytes(h.postgres.dbSizeBytes) })}</Row>
            {h.postgres.tables.map((tb) => (
              <Row key={tb.name} label={tb.name}>{fmtBytes(tb.bytes)}</Row>
            ))}
          </>
        ) : (
          <div style={{ fontSize: 13, color: "var(--c-tx3)" }}>{na}</div>
        )}
      </Group>

      <Group title={t("settings.hubHealthRedis")}>
        {h.redis ? (
          <Row label={h.redis.maxMemoryBytes > 0 ? t("settings.hubHealthRedisLimit", { used: fmtBytes(h.redis.usedMemoryBytes), max: fmtBytes(h.redis.maxMemoryBytes) }) : t("settings.hubHealthRedisMem", { used: fmtBytes(h.redis.usedMemoryBytes) })}>
            {t("settings.hubHealthRedisClients", { n: h.redis.connectedClients })}
          </Row>
        ) : (
          <div style={{ fontSize: 13, color: "var(--c-tx3)" }}>{na}</div>
        )}
      </Group>

      <Group title={t("settings.hubHealthQueues")}>
        {h.queues.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--c-tx3)" }}>{t("settings.hubHealthNoQueues")}</div>
        ) : (
          h.queues.map((q) => (
            <Row key={q.name} label={q.name}>
              <span style={{ fontWeight: 500, fontSize: 12 }}>
                {t("settings.hubHealthQueueRow", { waiting: q.waiting, active: q.active, delayed: q.delayed, failed: q.failed })}
                {q.lastDurationMs !== null && <> · {t("settings.hubHealthQueueDur", { ms: q.lastDurationMs })}</>}
              </span>
            </Row>
          ))
        )}
      </Group>
    </div>
  );
}
