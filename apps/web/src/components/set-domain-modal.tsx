"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { cleanDomain } from "../lib/domain";
import { useT } from "../i18n/provider";
import { Btn } from "./ui";
import { Field, TextInput } from "./form";
import { Modal } from "./modal";
import { useToast } from "./toast";

/** Assign/change a domain to an app (Home launcher affordance). */
export function SetDomainModal({
  appId,
  current,
  onClose,
}: {
  appId: string;
  current?: string | null;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const [domain, setDomain] = useState(current ?? "");

  const save = useMutation({
    mutationFn: () => api.setAppDomain(appId, cleanDomain(domain) || null),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["apps"] });
      toast(t("apps.domainSaved"), "success");
      onClose();
    },
  });

  return (
    <Modal onClose={onClose}>
      <div style={{ fontWeight: 700, marginBottom: 10 }}>{t("home.setDomainTitle")}</div>
      <Field label={t("apps.setDomain")} htmlFor="set-domain">
        <TextInput
          id="set-domain"
          value={domain}
          placeholder={t("apps.domainPlaceholder")}
          onChange={(e) => setDomain(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && cleanDomain(domain)) save.mutate(); }}
        />
      </Field>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "8px 0 0" }}>{t("apps.domainRedeployNote")}</p>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
        <Btn variant="ghost" onClick={onClose}>{t("common.cancel")}</Btn>
        <Btn onClick={() => save.mutate()} disabled={save.isPending || !cleanDomain(domain)}>{t("apps.domainSave")}</Btn>
      </div>
    </Modal>
  );
}
