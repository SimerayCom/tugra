"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { cleanDomain } from "../lib/domain";
import { useT } from "../i18n/provider";
import { Btn, SectionCard } from "./ui";
import { Field, TextInput, useSaveFeedback } from "./form";

/**
 * Set or clear the app's primary domain. The hostname input was placeholder-only (no accessible
 * name); it is now a labelled Field. Save stays disabled until the hostname is a valid, changed
 * value; Clear shows only when a domain is set.
 */
export function DomainCard({ id, domain, https }: { id: string; domain: string | null; https: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const feedback = useSaveFeedback("apps.saved");
  const [value, setValue] = useState(domain ?? "");
  const invalidate = () => qc.invalidateQueries({ queryKey: ["app", id] });
  const save = useMutation({
    mutationFn: () => api.setAppDomain(id, cleanDomain(value) || null),
    onSuccess: invalidate,
    ...feedback,
  });
  const clear = useMutation({
    mutationFn: () => api.setAppDomain(id, null),
    onSuccess: () => { setValue(""); invalidate(); },
    ...feedback,
  });
  const pending = save.isPending || clear.isPending;
  const cleaned = cleanDomain(value);
  const canSave = !!cleaned && cleaned !== (domain ?? "");

  return (
    <SectionCard
      title={t("apps.setDomain")}
      desc={t("apps.domainRedeployNote")}
      footer={
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <div style={{ flex: 1 }} />
          {domain && <Btn variant="ghost" onClick={() => clear.mutate()} disabled={pending}>{t("apps.domainClear")}</Btn>}
          <Btn onClick={() => save.mutate()} disabled={pending || !canSave}>{t("apps.domainSave")}</Btn>
        </div>
      }
    >
      <Field label={t("apps.domainLabel")}>
        <TextInput value={value} placeholder={t("apps.domainPlaceholder")} onChange={(e) => setValue(e.target.value)} spellCheck={false} autoComplete="off" inputMode="url" />
      </Field>
      {https && cleaned && (
        <div className="mono" style={{ fontSize: 12, color: "var(--c-tx3)", marginTop: 10 }}>https://{cleaned}</div>
      )}
    </SectionCard>
  );
}
