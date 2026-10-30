"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import { Modal } from "./modal";
import { Btn } from "./ui";
import { fieldStyle } from "./form";

/**
 * Clone an app into a new one (same server + environment). Only the name is operator-settable; the domain,
 * TLS cert, webhook and host ports are reset server-side and volumes start empty — the dialog says so.
 */
export function CloneAppModal({ appId, defaultName, onClose }: { appId: string; defaultName: string; onClose: () => void }) {
  const t = useT();
  const router = useRouter();
  const [name, setName] = useState(defaultName);
  const clone = useMutation({
    mutationFn: () => api.cloneApp(appId, { name: name.trim() || undefined }),
    onSuccess: (res) => { onClose(); router.push(`/apps/${res.app.id}`); },
  });

  return (
    <Modal onClose={onClose} width={440} ariaLabel={t("apps.cloneTitle")}>
      <h3 style={{ margin: "0 0 8px", fontSize: 15 }}>{t("apps.cloneTitle")}</h3>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px", lineHeight: 1.5 }}>{t("apps.cloneHint")}</p>
      <label style={{ display: "block", marginBottom: 12 }}>
        <span style={{ display: "block", fontSize: 12, color: "var(--c-tx2)", marginBottom: 6 }}>{t("apps.cloneName")}</span>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && name.trim() && !clone.isPending) clone.mutate(); }}
          aria-label={t("apps.cloneName")}
          style={{ ...fieldStyle, width: "100%" }}
        />
      </label>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <Btn variant="ghost" onClick={onClose} disabled={clone.isPending}>{t("common.cancel")}</Btn>
        <Btn onClick={() => clone.mutate()} disabled={clone.isPending || !name.trim()}>{clone.isPending ? "…" : t("apps.clone")}</Btn>
      </div>
      {clone.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(clone.error as Error).message}</div>}
    </Modal>
  );
}
