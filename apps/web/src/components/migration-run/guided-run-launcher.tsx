"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Route } from "lucide-react";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { Btn } from "../ui";
import { Modal } from "../modal";
import { Checkbox, Field, NumberInput, Select, TextInput } from "../form";
import { useToast } from "../toast";
import { MODE_HINT_KEY, MODE_KEY, TOPOLOGY_HINT_KEY, TOPOLOGY_KEY, buildLaunchInput, errorText, launchIssues, looksLikeEmail } from "../../lib/migration-run";
import type { ImportApplyExtras, ImportPlan, ImportRemoteKind, MigrationRunMode, MigrationRunTopology } from "../../lib/types";

interface Props {
  plan: ImportPlan;
  kind: ImportRemoteKind;
  sessionId: string;
  servers: Array<{ id: string; name: string; teamId: string }>;
  extras: ImportApplyExtras;
  disabled?: boolean;
}

/** The wizard's "Run guided migration" entry. It sits next to the manual apply, which stays untouched: the guided run
 *  freezes the same reviewed plan (the plan hash plus the acknowledgements and choices made above), then drives the
 *  whole flow with gates and approvals. A dry-run is the default and writes nothing outside the run's own records. */
export function GuidedRunLauncher(props: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--c-bd)" }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{t("migrationRun.launch.title")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 10px", lineHeight: 1.5 }}>{t("migrationRun.launch.desc")}</p>
      <Btn variant="ghost" icon={Route} onClick={() => setOpen(true)} disabled={props.disabled}>{t("migrationRun.launch.button")}</Btn>
      {open && <LaunchDialog {...props} onClose={() => setOpen(false)} />}
    </div>
  );
}

function LaunchDialog({ plan, kind, sessionId, servers, extras, onClose }: Props & { onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const router = useRouter();
  const qc = useQueryClient();
  const [targetServerId, setTarget] = useState(servers[0]?.id ?? "");
  const [dryRun, setDryRun] = useState(true);
  const [mode, setMode] = useState<MigrationRunMode>("copy");
  const [topology, setTopology] = useState<MigrationRunTopology>("two-box");
  const [acmeEmail, setAcmeEmail] = useState("");
  const [controller, setController] = useState<"manual" | "api" | "agent">("manual");
  const [allowBind, setAllowBind] = useState(false);
  const [probe, setProbe] = useState(false);
  const [observe, setObserve] = useState("30");

  const form = { sessionId, sourceKind: kind, targetServerId, planHash: plan.planHash, extras, mode, topology, dryRun, acmeEmail, allowBind, allowLiveShapeProbe: probe, sourceController: controller, observeMinutes: observe };
  const issues = launchIssues(form);
  const create = useMutation({
    mutationFn: () => api.createMigrationRun(buildLaunchInput(form)),
    onSuccess: (run) => {
      void qc.invalidateQueries({ queryKey: ["migration-runs"] });
      router.push(`/import/runs/${run.id}`);
    },
    onError: (e) => toast(errorText(t, e), "error"),
  });

  return (
    <Modal onClose={() => !create.isPending && onClose()} ariaLabel={t("migrationRun.launch.title")} width={560} closeOnBackdrop={false}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (issues.length === 0 && !create.isPending) create.mutate();
        }}
        style={{ display: "flex", flexDirection: "column", gap: 14 }}
      >
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>{t("migrationRun.launch.title")}</h2>
        <p style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 }}>{t("migrationRun.launch.dialogDesc")}</p>

        <Field label={t("migrationRun.launch.target")} hint={t("migrationRun.launch.targetHint")} error={issues.includes("target") ? t("migrationRun.launch.targetMissing") : undefined}>
          <Select value={targetServerId} onChange={setTarget} options={servers.map((s) => ({ value: s.id, label: s.name }))} style={{ minHeight: 44 }} />
        </Field>

        <div>
          <Checkbox checked={dryRun} onChange={setDryRun} label={t("migrationRun.launch.dryRun")} />
          <div style={{ fontSize: 11, color: "var(--c-tx3)", margin: "2px 0 0 24px", lineHeight: 1.5 }}>{t("migrationRun.launch.dryRunHint")}</div>
        </div>

        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))" }}>
          <Field label={t("migrationRun.launch.mode")} hint={t(MODE_HINT_KEY[mode])}>
            <Select value={mode} onChange={(v) => setMode(v as MigrationRunMode)} options={(["copy", "takeover"] as const).map((m) => ({ value: m, label: t(MODE_KEY[m]) }))} style={{ minHeight: 44 }} />
          </Field>
          <Field label={t("migrationRun.launch.topology")} hint={t(TOPOLOGY_HINT_KEY[topology])}>
            <Select value={topology} onChange={(v) => setTopology(v as MigrationRunTopology)} options={(["two-box", "swap-proxy"] as const).map((m) => ({ value: m, label: t(TOPOLOGY_KEY[m]) }))} style={{ minHeight: 44 }} />
          </Field>
        </div>

        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))" }}>
          <Field label={t("migrationRun.inputs.acmeEmail")} hint={t("migrationRun.launch.acmeHint")} error={acmeEmail.trim() && !looksLikeEmail(acmeEmail) ? t("migrationRun.inputs.emailInvalid") : undefined}>
            <TextInput type="email" value={acmeEmail} onChange={(e) => setAcmeEmail(e.target.value)} autoComplete="off" style={{ minHeight: 44 }} />
          </Field>
          <Field label={t("migrationRun.inputs.sourceController")} hint={t("migrationRun.inputs.sourceControllerHint")}>
            <Select
              value={controller}
              onChange={(v) => setController(v as "manual" | "api" | "agent")}
              options={[
                { value: "manual", label: t("migrationRun.inputs.controller.manual") },
                { value: "api", label: t("migrationRun.inputs.controller.api") },
                { value: "agent", label: t("migrationRun.inputs.controller.agent") },
              ]}
              style={{ minHeight: 44 }}
            />
          </Field>
          <Field label={t("migrationRun.launch.observe")} hint={t("migrationRun.launch.observeHint")} error={issues.includes("observe") ? t("migrationRun.launch.observeInvalid") : undefined}>
            <NumberInput min={0} max={4320} value={observe} onChange={(e) => setObserve(e.target.value)} style={{ minHeight: 44 }} />
          </Field>
        </div>

        <Checkbox checked={allowBind} onChange={setAllowBind} label={t("migrationRun.inputs.allowBind")} />
        <Checkbox checked={probe} onChange={setProbe} label={t("migrationRun.inputs.allowLiveShapeProbe")} />

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <Btn variant="ghost" onClick={onClose} disabled={create.isPending}>{t("common.cancel")}</Btn>
          <Btn type="submit" disabled={issues.length > 0 || servers.length === 0} loading={create.isPending}>
            {dryRun ? t("migrationRun.launch.createDry") : t("migrationRun.launch.create")}
          </Btn>
        </div>
      </form>
    </Modal>
  );
}
