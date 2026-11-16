"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { Btn, SectionCard } from "../ui";
import { Checkbox, Field, Select, TextInput } from "../form";
import { OWNER_INPUT_HINT_KEY, OWNER_INPUT_LABEL_KEY, looksLikeEmail } from "../../lib/migration-run";
import type { MigrationRunInputsRequest, MigrationRunView } from "../../lib/types";
import { INPUTS_ANCHOR } from "./gate-checks";
import { useRunPlumbing } from "./use-run-actions";

const isUnknown = (r: { value: unknown } | undefined) => !r || r.value === "unknown";

/** The owner questions as run inputs. An unanswered one blocks only the step that needs it (the gate says which). */
export function OwnerInputsCard({ run }: { run: MigrationRunView }) {
  const t = useT();
  const { adopt, onError, toast } = useRunPlumbing(run.id);
  const inputs = run.inputs;
  const [email, setEmail] = useState(isUnknown(inputs.acmeEmail) ? "" : String(inputs.acmeEmail!.value));
  const [allowBind, setAllowBind] = useState(inputs.allowBind?.value === true);
  const [probe, setProbe] = useState(inputs.allowLiveShapeProbe?.value === true);
  const [controller, setController] = useState<string>(isUnknown(inputs.sourceController) ? "manual" : String(inputs.sourceController!.value));
  const emailBad = email.trim() !== "" && !looksLikeEmail(email);

  const save = useMutation({
    mutationFn: () => {
      const body: MigrationRunInputsRequest = {
        acmeEmail: email.trim() ? email.trim() : "unknown",
        allowBind,
        allowLiveShapeProbe: probe,
        sourceController: controller as "manual" | "api" | "agent",
      };
      return api.setMigrationRunInputs(run.id, body);
    },
    onSuccess: (v) => {
      adopt(v);
      toast(t("migrationRun.inputs.saved"), "success");
    },
    onError,
  });

  return (
    <div id={INPUTS_ANCHOR}>
      <SectionCard title={t("migrationRun.inputs.title")} desc={t("migrationRun.inputs.desc")}>
        <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))" }}>
          <Field label={t(OWNER_INPUT_LABEL_KEY.acmeEmail)} hint={t(OWNER_INPUT_HINT_KEY.acmeEmail)} error={emailBad ? t("migrationRun.inputs.emailInvalid") : undefined}>
            <TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" style={{ minHeight: 44 }} />
          </Field>
          <Field label={t(OWNER_INPUT_LABEL_KEY.sourceController)} hint={t(OWNER_INPUT_HINT_KEY.sourceController)}>
            <Select
              value={controller}
              onChange={setController}
              options={[
                { value: "manual", label: t("migrationRun.inputs.controller.manual") },
                { value: "api", label: t("migrationRun.inputs.controller.api") },
                { value: "agent", label: t("migrationRun.inputs.controller.agent") },
              ]}
              style={{ minHeight: 44 }}
            />
          </Field>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 14 }}>
          <div>
            <Checkbox checked={allowBind} onChange={setAllowBind} label={t(OWNER_INPUT_LABEL_KEY.allowBind)} />
            <div style={{ fontSize: 11, color: "var(--c-tx3)", margin: "2px 0 0 24px" }}>{t(OWNER_INPUT_HINT_KEY.allowBind)}</div>
          </div>
          <div>
            <Checkbox checked={probe} onChange={setProbe} label={t(OWNER_INPUT_LABEL_KEY.allowLiveShapeProbe)} />
            <div style={{ fontSize: 11, color: "var(--c-tx3)", margin: "2px 0 0 24px" }}>{t(OWNER_INPUT_HINT_KEY.allowLiveShapeProbe)}</div>
          </div>
        </div>
        <div style={{ marginTop: 14 }}>
          <Btn onClick={() => save.mutate()} disabled={!run.allowed.setInputs || emailBad} loading={save.isPending}>{t("migrationRun.inputs.save")}</Btn>
        </div>
      </SectionCard>
    </div>
  );
}
