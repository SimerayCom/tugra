"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useT } from "../../i18n/provider";
import { Card } from "../ui";
import { ImportVolumeTransfers } from "../import-volume-transfers";
import { CutoverPanel } from "../cutover-panel";
import type { MigrationRunStepKey, MigrationRunView } from "../../lib/types";

const started = (run: MigrationRunView, keys: MigrationRunStepKey[]) => run.steps.some((s) => keys.includes(s.key) && s.status !== "PENDING" && s.status !== "SKIPPED");

function Drawer({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = `drawer-${title.replace(/\W+/g, "-")}`;
  return (
    <Card style={{ padding: 14 }}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", minHeight: 44, background: "transparent", border: "none", color: "inherit", font: "inherit", fontSize: 13, fontWeight: 600, textAlign: "left", cursor: "pointer", padding: 0 }}
      >
        {open ? <ChevronDown size={15} aria-hidden /> : <ChevronRight size={15} aria-hidden />}
        {title}
      </button>
      {open && (
        <div id={id} style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 12 }}>
          <p style={{ margin: 0, fontSize: 12, color: "var(--c-am)", lineHeight: 1.5 }}>{note}</p>
          {children}
        </div>
      )}
    </Card>
  );
}

/** The existing per-operation panels, opened on demand once their steps started: the volume transfers and the
 *  SSL/DNS cutover table for the run's current import operation. They work on the same operation the run drives, so
 *  each carries a note that acting there by hand bypasses the guided flow's gates. */
export function RunDrawers({ run }: { run: MigrationRunView }) {
  const t = useT();
  if (!run.opId) return null;
  const showVolumes = started(run, ["DATA_SEED", "DATA_FINAL"]);
  const showCutover = started(run, ["CUTOVER", "OBSERVE", "FINALIZE"]) || started(run, ["DNS_PREPARE", "TLS_PREISSUE"]);
  if (!showVolumes && !showCutover) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {showVolumes && (
        <Drawer title={t("migrationRun.drawer.volumes")} note={t("migrationRun.drawer.bypass")}>
          <ImportVolumeTransfers opId={run.opId} />
        </Drawer>
      )}
      {showCutover && (
        <Drawer title={t("migrationRun.drawer.cutover")} note={t("migrationRun.drawer.bypass")}>
          <CutoverPanel opId={run.opId} />
        </Drawer>
      )}
    </div>
  );
}
