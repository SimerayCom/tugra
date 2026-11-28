"use client";

import { useT } from "../../i18n/provider";
import { Checkbox, Field, NumberInput, Select, TextInput } from "../form";
import { OWNER_INPUT_HINT_KEY, OWNER_INPUT_LABEL_KEY, OWNER_POLICY_CHOICES, OWNER_POLICY_CHOICE_KEY, type LaunchIssue, type LaunchPolicies, type OwnerPolicyKey, type HostLoopForm } from "../../lib/migration-run";
import type { MigrationRunLargeDbMode, MigrationRunOptions, MigrationRunServiceStart, MigrationRunSourceRunner } from "../../lib/types";

export interface AdvancedState {
  campaign: string;
  sourceRunner: MigrationRunSourceRunner;
  hostLoop: HostLoopForm;
  deployWaves: MigrationRunOptions["deployWaves"];
  deployConcurrency: string;
  largeDbMode: MigrationRunLargeDbMode;
  serviceStart: MigrationRunServiceStart;
  stopSource: boolean;
  policies: LaunchPolicies;
}

const UNSET = "default";
const POLICY_KEYS: OwnerPolicyKey[] = ["minioPolicy", "workerPolicy", "unlistedDbPolicy", "orphanVolumePolicy"];

/** A policy owner input as a select whose first choice leaves it unanswered (the hub's fail-closed default applies). */
export function PolicySelect({ policy, value, onChange }: { policy: OwnerPolicyKey; value: string; onChange: (v: string) => void }) {
  const t = useT();
  const options = [{ value: UNSET, label: t("migrationRun.inputs.decideLater") }, ...OWNER_POLICY_CHOICES[policy].map((c) => ({ value: c, label: t(OWNER_POLICY_CHOICE_KEY[policy][c]) }))];
  return (
    <Field label={t(OWNER_INPUT_LABEL_KEY[policy])} hint={t(OWNER_INPUT_HINT_KEY[policy])}>
      <Select value={value || UNSET} onChange={(v) => onChange(v === UNSET ? "" : v)} options={options} style={{ minHeight: 44 }} />
    </Field>
  );
}

/** The launch form's "Advanced options": campaign, who runs the migrator (with the host-loop tuning), build timing and
 *  concurrency, large databases and the fleet policy answers. Every default is the hub's safe one. */
export function AdvancedFields({ value, onChange, issues, hideCampaign = false }: { value: AdvancedState; onChange: (next: AdvancedState) => void; issues: LaunchIssue[]; /** The campaign name is asked at the top of the page. */ hideCampaign?: boolean }) {
  const t = useT();
  const set = <K extends keyof AdvancedState>(k: K, v: AdvancedState[K]) => onChange({ ...value, [k]: v });
  const setLoop = (k: keyof HostLoopForm, v: string) => set("hostLoop", { ...value.hostLoop, [k]: v });
  const setPolicy = (k: keyof LaunchPolicies, v: string) => set("policies", { ...value.policies, [k]: v });
  const grid = { display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))" } as const;
  return (
    <details style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "10px 12px" }}>
      <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600, minHeight: 28 }}>{t("migrationRun.launch.advanced.title")}</summary>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 12 }}>
        <p style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 }}>{t("migrationRun.launch.advanced.desc")}</p>

        {!hideCampaign && (
          <Field label={t("migrationRun.launch.advanced.campaign")} hint={t("migrationRun.launch.advanced.campaignHint")} error={issues.includes("campaign") ? t("migrationRun.launch.advanced.campaignInvalid") : undefined}>
            <TextInput value={value.campaign} onChange={(e) => set("campaign", e.target.value)} maxLength={80} autoComplete="off" style={{ minHeight: 44 }} />
          </Field>
        )}

        <Field label={t("migrationRun.launch.advanced.runner")} hint={t("migrationRun.launch.advanced.runnerHint")}>
          <Select
            value={value.sourceRunner}
            onChange={(v) => set("sourceRunner", v as MigrationRunSourceRunner)}
            options={[
              { value: "operator", label: t("migrationRun.launch.advanced.runnerChoice.operator") },
              { value: "agent", label: t("migrationRun.launch.advanced.runnerChoice.agent") },
              { value: "coolify-host-loop", label: t("migrationRun.launch.advanced.runnerChoice.coolify-host-loop") },
            ]}
            style={{ minHeight: 44 }}
          />
        </Field>

        {value.sourceRunner === "coolify-host-loop" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Field label={t("migrationRun.launch.advanced.hostLoop.keyDir")} hint={t("migrationRun.launch.advanced.hostLoop.keyDirHint")}>
              <TextInput value={value.hostLoop.keyDir} onChange={(e) => setLoop("keyDir", e.target.value)} mono autoComplete="off" spellCheck={false} maxLength={201} style={{ minHeight: 44 }} />
            </Field>
            <div style={grid}>
              <Field label={t("migrationRun.launch.advanced.hostLoop.parallel")}>
                <NumberInput min={1} max={8} value={value.hostLoop.parallel} onChange={(e) => setLoop("parallel", e.target.value)} style={{ minHeight: 44 }} />
              </Field>
              <Field label={t("migrationRun.launch.advanced.hostLoop.connectTimeout")}>
                <NumberInput min={5} max={120} value={value.hostLoop.connectTimeoutSec} onChange={(e) => setLoop("connectTimeoutSec", e.target.value)} style={{ minHeight: 44 }} />
              </Field>
              <Field label={t("migrationRun.launch.advanced.hostLoop.retries")}>
                <NumberInput min={0} max={5} value={value.hostLoop.retries} onChange={(e) => setLoop("retries", e.target.value)} style={{ minHeight: 44 }} />
              </Field>
            </div>
            {issues.includes("hostLoop") && <div role="alert" style={{ fontSize: 12, color: "var(--c-r)", lineHeight: 1.5 }}>{t("migrationRun.launch.advanced.hostLoop.invalid")}</div>}
          </div>
        )}

        <div style={grid}>
          <Field label={t("migrationRun.launch.advanced.deployWaves")} hint={t("migrationRun.launch.advanced.deployWavesHint")}>
            <Select
              value={value.deployWaves}
              onChange={(v) => set("deployWaves", v as MigrationRunOptions["deployWaves"])}
              options={[
                { value: "single", label: t("migrationRun.launch.advanced.deployWavesChoice.single") },
                { value: "earlyStateless", label: t("migrationRun.launch.advanced.deployWavesChoice.earlyStateless") },
                { value: "earlyBuild", label: t("migrationRun.launch.advanced.deployWavesChoice.earlyBuild") },
              ]}
              style={{ minHeight: 44 }}
            />
          </Field>
          <Field label={t("migrationRun.launch.advanced.deployConcurrency")} hint={t("migrationRun.launch.advanced.deployConcurrencyHint")} error={issues.includes("concurrency") ? t("migrationRun.launch.advanced.deployConcurrencyInvalid") : undefined}>
            <NumberInput min={1} max={8} value={value.deployConcurrency} onChange={(e) => set("deployConcurrency", e.target.value)} style={{ minHeight: 44 }} />
          </Field>
          <Field label={t("migrationRun.launch.advanced.serviceStart")} hint={t("migrationRun.launch.advanced.serviceStartHint")}>
            <Select
              value={value.serviceStart}
              onChange={(v) => set("serviceStart", v as MigrationRunServiceStart)}
              options={[
                { value: "dependencies", label: t("migrationRun.launch.advanced.serviceStartChoice.dependencies") },
                { value: "none", label: t("migrationRun.launch.advanced.serviceStartChoice.none") },
                { value: "all", label: t("migrationRun.launch.advanced.serviceStartChoice.all") },
              ]}
              style={{ minHeight: 44 }}
            />
          </Field>
          <Field
            label={t("migrationRun.launch.advanced.largeDbMode")}
            hint={`${t("migrationRun.launch.advanced.largeDbModeHint")} ${t(value.largeDbMode === "stream-logical" ? "migrationRun.launch.advanced.largeDbHintStream" : "migrationRun.launch.advanced.largeDbHintRefuse")}`}
          >
            <Select
              value={value.largeDbMode}
              onChange={(v) => set("largeDbMode", v as MigrationRunLargeDbMode)}
              options={[
                { value: "refuse", label: t("migrationRun.launch.advanced.largeDbChoice.refuse") },
                { value: "stream-logical", label: t("migrationRun.launch.advanced.largeDbChoice.stream-logical") },
              ]}
              style={{ minHeight: 44 }}
            />
          </Field>
        </div>

        <div>
          <Checkbox checked={value.stopSource} onChange={(c) => set("stopSource", c)} label={t("migrationRun.launch.advanced.stopSource")} />
          <div style={{ fontSize: 11, color: "var(--c-tx3)", margin: "2px 0 0 24px", lineHeight: 1.5 }}>{t("migrationRun.launch.advanced.stopSourceHint")}</div>
        </div>

        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("migrationRun.inputs.policiesTitle")}</div>
        <p style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 }}>{t("migrationRun.inputs.policiesDesc")}</p>
        <div style={grid}>
          {POLICY_KEYS.map((k) => (
            <PolicySelect key={k} policy={k} value={value.policies[k]} onChange={(v) => setPolicy(k, v)} />
          ))}
        </div>
      </div>
    </details>
  );
}
