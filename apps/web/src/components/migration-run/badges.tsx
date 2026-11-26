"use client";

import { CheckCircle2, CircleDashed, Clock, MinusCircle, UserRound, XCircle, ShieldCheck, Undo2 } from "lucide-react";
import { useT } from "../../i18n/provider";
import { ActivitySpinner, Badge, StatusPill } from "../ui";
import {
  EVIDENCE_HINT_KEY,
  EVIDENCE_KEY,
  MODE_KEY,
  RUN_STATUS_KEY,
  STEP_STATUS_KEY,
  TOPOLOGY_KEY,
  evidenceTone,
  runStatusColor,
  stepStatusColor,
} from "../../lib/migration-run";
import type { MigrationRunEvidenceKind, MigrationRunMode, MigrationRunStatus, MigrationRunStepStatus, MigrationRunTopology } from "../../lib/types";

export function RunStatusPill({ status }: { status: MigrationRunStatus }) {
  const t = useT();
  return <StatusPill label={t(RUN_STATUS_KEY[status])} color={runStatusColor(status)} />;
}

/** Icon + text label (never colour alone) for a step's status. */
export function StepStatusMark({ status, size = 16 }: { status: MigrationRunStepStatus; size?: number }) {
  const color = stepStatusColor(status);
  const common = { size, color, "aria-hidden": true as const, style: { flexShrink: 0 } };
  switch (status) {
    case "PASSED":
      return <CheckCircle2 {...common} />;
    case "FAILED":
      return <XCircle {...common} />;
    case "RUNNING":
      return (
        <span style={{ color, display: "inline-flex" }}>
          <ActivitySpinner size={size - 2} />
        </span>
      );
    case "WAITING_OPERATOR":
      return <UserRound {...common} />;
    case "WAITING_APPROVAL":
      return <ShieldCheck {...common} />;
    case "WAITING_TIMER":
      return <Clock {...common} />;
    case "SKIPPED":
      return <MinusCircle {...common} />;
    case "COMPENSATED":
      return <Undo2 {...common} />;
    case "PENDING":
      return <CircleDashed {...common} />;
  }
}

export function StepStatusBadge({ status }: { status: MigrationRunStepStatus }) {
  const t = useT();
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: stepStatusColor(status) }}>
      <StepStatusMark status={status} size={14} />
      {t(STEP_STATUS_KEY[status])}
    </span>
  );
}

/** How trustworthy a result is. Always shown with words: a migrator-reported pass is never drawn like a hub-verified one. */
export function EvidenceBadge({ kind }: { kind: MigrationRunEvidenceKind }) {
  const t = useT();
  const tone = evidenceTone(kind);
  return (
    <span title={t(EVIDENCE_HINT_KEY[kind])}>
      <Badge tone={tone === "ok" ? "ok" : tone === "warn" ? "warn" : "muted"}>{t(EVIDENCE_KEY[kind])}</Badge>
    </span>
  );
}

/** The mark of a run that takes a server over in place (same machine, no data copy). Words, with the explanation as its tooltip. */
export function InPlaceBadge() {
  const t = useT();
  return (
    <span title={t("inPlaceRun.badgeHint")} data-testid="in-place-badge">
      <Badge tone="ok">{t("inPlaceRun.badge")}</Badge>
    </span>
  );
}

export function ModeBadges({ mode, topology, dryRun, inPlace = false }: { mode: MigrationRunMode; topology: MigrationRunTopology; dryRun: boolean; inPlace?: boolean }) {
  const t = useT();
  return (
    <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
      {dryRun && <Badge tone="lapis">{t("migrationRun.dryRun")}</Badge>}
      {inPlace && <InPlaceBadge />}
      <Badge tone={mode === "takeover" ? "warn" : "muted"}>{t(MODE_KEY[mode])}</Badge>
      <Badge>{t(TOPOLOGY_KEY[topology])}</Badge>
    </span>
  );
}

