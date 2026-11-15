"use client";

import { useT } from "../i18n/provider";
import { Card, EmptyState } from "./ui";
import { formatBytes, formatDuration, downtimeEstimate, GATE_KEY } from "../lib/import";
import type { VolumeTransferView, VxGate } from "../lib/types";

const gateColor: Record<VxGate["status"], string> = { pass: "var(--c-g)", fail: "var(--c-r)", unknown: "var(--c-am)" };
const gateMark: Record<VxGate["status"], string> = { pass: "✓", fail: "✕", unknown: "?" };

/** The detail number the hub's disk verdict carries (free space is the smaller of staging and docker root on one filesystem). */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Postgres physical-copy checklist: each gate with its status mark AND the hub's own sentence (the evidence or the exact reason). */
export function VxGateList({ gates }: { gates: VxGate[] }) {
  const t = useT();
  return (
    <div role="group" aria-label={t("import.vx.gate.title")} style={{ marginTop: 8 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("import.vx.gate.title")}</div>
      <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 3 }}>
        {gates.map((g) => (
          <li key={g.id} style={{ fontSize: 12, display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
            <span aria-hidden style={{ color: gateColor[g.status], fontWeight: 700, width: 14 }}>{gateMark[g.status]}</span>
            <span style={{ fontWeight: 600 }}>{t(GATE_KEY[g.id])}</span>
            <span className="sr-only">{t(`import.vx.gate.${g.status}`)}</span>
            <span style={{ color: g.status === "pass" ? "var(--c-tx3)" : gateColor[g.status], flexBasis: "100%", paddingLeft: 22 }}>{g.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PreflightCard({ v }: { v: VolumeTransferView }) {
  const t = useT();
  const inv = v.inventory;
  const disk = v.diskVerdict;
  const free = disk ? Math.min(num(disk.details.targetStagingFreeBytes) ?? Infinity, num(disk.details.targetDockerFreeBytes) ?? Infinity) : null;
  const need = disk ? num(disk.details.totalBytes) : null;
  const est = inv?.found ? downtimeEstimate(inv.rawBytes, v.bps != null ? (v.bps * 8) / 1e6 : null) : null;
  const sameDisk = disk != null && num(disk.details.targetStagingFreeBytes) != null && disk.details.targetSameDevice === true;
  return (
    <Card style={{ padding: 14 }} aria-label={t("import.vx.a11y.row", { name: v.resourceName ?? v.itemRef })}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "baseline" }}>
        <span className="mono" style={{ fontWeight: 600, fontSize: 13, wordBreak: "break-all" }}>{v.resourceName ?? v.itemRef}</span>
        <span className="mono" style={{ fontSize: 11, color: "var(--c-tx3)" }}>{v.mountPath}</span>
        <span style={{ fontSize: 11, color: "var(--c-tx3)", marginLeft: "auto" }}>{t("import.vx.evidence.reportedByMigrator")}</span>
      </div>
      {!inv ? (
        <p style={{ fontSize: 12, color: "var(--c-am)", margin: "8px 0 0" }}>{t("import.vx.preflight.noInventory")}</p>
      ) : !inv.found ? (
        <p style={{ fontSize: 12, color: "var(--c-r)", margin: "8px 0 0" }}>{t("import.vx.preflight.notFound")}</p>
      ) : (
        <ul style={{ margin: "8px 0 0", paddingLeft: 16, fontSize: 12, display: "flex", flexDirection: "column", gap: 2 }}>
          <li>{t("import.vx.preflight.found")}: {t("import.vx.preflight.size", { size: formatBytes(inv.rawBytes), entries: inv.entries })}</li>
          <li style={{ color: inv.running ? "var(--c-r)" : "var(--c-g)" }}>
            {inv.running ? t("import.vx.preflight.running") : t("import.vx.preflight.stopped")}
            {!inv.running && inv.exitCode !== undefined ? ` (${t("import.vx.preflight.exitCode", { code: inv.exitCode })})` : ""}
          </li>
          {inv.mountType === "bind" && <li style={{ color: "var(--c-am)" }}>{t("import.vx.preflight.bind")}</li>}
          {inv.specials.sockets > 0 && <li style={{ color: "var(--c-tx3)" }}>{t("import.vx.preflight.sockets", { count: inv.specials.sockets })}</li>}
          {inv.specials.devices > 0 && <li style={{ color: "var(--c-r)" }}>{t("import.vx.preflight.devices", { count: inv.specials.devices })}</li>}
          {v.destType === "db-data" && inv.image && <li className="mono">{t("import.vx.preflight.image", { image: inv.image })}</li>}
          {v.destType === "db-data" && inv.pgMajor && <li>{t("import.vx.preflight.major", { major: inv.pgMajor })}</li>}
          {v.destType === "db-data" && inv.pgLayout && <li>{t("import.vx.preflight.layout", { layout: inv.pgLayout })}</li>}
          {v.destType === "db-data" && inv.mountDest && <li className="mono">{t("import.vx.preflight.mount", { path: inv.mountDest })}</li>}
        </ul>
      )}
      {disk && (
        <p style={{ fontSize: 12, margin: "8px 0 0", color: disk.unknown ? "var(--c-am)" : disk.ok ? "var(--c-g)" : "var(--c-r)" }}>
          {disk.unknown
            ? t("import.vx.preflight.diskUnknown")
            : t(disk.ok ? "import.vx.preflight.diskOk" : "import.vx.preflight.diskShort", {
                free: free != null && Number.isFinite(free) ? formatBytes(free) : "?",
                // the same sizing rule and rounding the hub states: 2.05 x data + 1 GiB, rounded up (one filesystem)
                need: need != null ? `${Math.ceil((need * 2.05 + 1024 ** 3) / 1024 ** 3)} GiB` : "?",
              })}
          {sameDisk ? ` ${t("import.vx.preflight.diskSameDevice")}` : ""}
        </p>
      )}
      {inv?.found && (
        <p style={{ fontSize: 12, margin: "8px 0 0", color: "var(--c-tx3)" }}>
          {est
            ? t("import.vx.preflight.downtimeEstimate", { low: formatDuration(est.low) ?? "?", high: formatDuration(est.high) ?? "?" })
            : `${t("import.vx.preflight.downtimeEstimate", { low: t("import.vx.downtime.never"), high: t("import.vx.downtime.never") })}`}
          {" "}
          <span title={t("import.vx.downtime.formula")}>({t("import.vx.downtime.formula")})</span> {t("import.vx.warn.estimate")}
        </p>
      )}
      {v.gates && v.gates.length > 0 && <VxGateList gates={v.gates} />}
    </Card>
  );
}

/** The dry-run inventory as the owner reads it BEFORE choosing a window: what is there, whether it is stopped, whether the
 *  target has room, and (Postgres) every physical-copy gate. Everything the source reported is labelled as such. */
export function ImportVxPreflight({ volumes }: { volumes: VolumeTransferView[] }) {
  const t = useT();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontWeight: 600, fontSize: 13 }}>{t("import.vx.preflight.title")}</div>
      <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: 0 }}>{t("import.vx.evidence.note")}</p>
      {volumes.length === 0 ? <EmptyState>{t("import.vx.empty")}</EmptyState> : volumes.map((v) => <PreflightCard key={v.itemRef} v={v} />)}
    </div>
  );
}
