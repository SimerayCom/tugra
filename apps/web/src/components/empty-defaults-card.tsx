"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import { useToast } from "./toast";
import { useConfirm } from "./confirm";
import { Btn, Card } from "./ui";
import { readEmptyDefaultsDismissed, writeEmptyDefaultsDismissed } from "../lib/empty-defaults";

/**
 * One-time suggestion for owners: older installs got an automatic, empty "Default" project in every team. This offers
 * to remove the ones that are truly empty (the hub only lists untouched, resource-free ones in teams the caller owns).
 * Nothing is removed without the confirmation; "Not now" hides it for good on this browser.
 */
export function EmptyDefaultsCard() {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [dismissed, setDismissed] = useState(true); // read after mount so SSR/hydration markup stays stable
  useEffect(() => setDismissed(readEmptyDefaultsDismissed()), []);

  const { data: candidates = [] } = useQuery({
    queryKey: ["emptyDefaultProjects"],
    queryFn: () => api.listEmptyDefaultProjects(),
    enabled: !dismissed,
    retry: false,
  });
  const remove = useMutation({
    mutationFn: (ids: string[]) => api.removeEmptyDefaultProjects(ids),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["emptyDefaultProjects"] });
      toast(t("projects.cleanupDone", { n: res.removed.length }), "success");
    },
    onError: (e) => toast(e instanceof Error && e.message ? e.message : t("projects.cleanupFailed"), "error"),
  });

  if (dismissed || candidates.length === 0) return null;

  const run = async () => {
    const ok = await confirm({
      title: t("projects.cleanupTitle"),
      body: t("projects.cleanupConfirm", { n: candidates.length }),
      confirmLabel: t("projects.cleanupRemove"),
      danger: true,
    });
    if (ok) remove.mutate(candidates.map((c) => c.id));
  };
  const later = () => {
    writeEmptyDefaultsDismissed();
    setDismissed(true);
  };

  return (
    <section aria-label={t("projects.cleanupTitle")}>
    <Card style={{ padding: 16, marginBottom: 20 }}>
      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>{t("projects.cleanupTitle")}</div>
      <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--c-tx3)" }}>{t("projects.cleanupBody", { n: candidates.length })}</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Btn variant="danger" onClick={() => void run()} loading={remove.isPending} style={{ minHeight: 44 }}>{t("projects.cleanupRemove")}</Btn>
        <Btn variant="ghost" onClick={later} disabled={remove.isPending} style={{ minHeight: 44 }}>{t("projects.cleanupLater")}</Btn>
      </div>
    </Card>
    </section>
  );
}
