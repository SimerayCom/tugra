"use client";

import { TriangleAlert } from "lucide-react";
import { useT } from "../i18n/provider";

/** Shown in the patching card when the pending updates include the container engine: applying them restarts
 *  dockerd/containerd, which restarts every app (and database) on the server. */
export function RuntimeUpdateWarning({ packages }: { packages: string[] }) {
  const t = useT();
  if (packages.length === 0) return null;
  return (
    <div role="alert" style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12, color: "var(--c-am)", border: "1px solid var(--c-am)", borderRadius: "var(--r1)", padding: "8px 10px", marginBottom: 10 }}>
      <TriangleAlert size={14} aria-hidden style={{ flexShrink: 0, marginTop: 1 }} />
      <span>{t("patching.runtimeRestart", { packages: packages.join(", ") })}</span>
    </div>
  );
}
