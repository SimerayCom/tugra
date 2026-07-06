"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Store } from "lucide-react";
import { api } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../i18n/provider";
import { EmptyState, Spinner } from "../../../components/ui";
import { ErrorState } from "../../../components/error-state";
import { TemplateGrid } from "../../../components/template-grid";
import { InstallModal } from "../../../components/install-modal";
import type { Template } from "../../../lib/types";

export default function AppStorePage() {
  const t = useT();
  const router = useRouter();
  const { user } = useAuth();
  const [installing, setInstalling] = useState<Template | null>(null);
  const { data: templates = [], isLoading, isError, refetch } = useQuery({ queryKey: ["templates"], queryFn: () => api.listTemplates() });

  return (
    <div style={{ padding: "var(--page-pad)", maxWidth: 1040 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px", display: "flex", alignItems: "center", gap: 8 }}>
        <Store size={20} color="var(--c-a)" /> {t("resources.storeTitle")}
        {templates.length > 0 && <span style={{ fontSize: 13, fontWeight: 500, color: "var(--c-tx3)" }}>· {templates.length}</span>}
      </h1>
      <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: "0 0 22px" }}>{t("resources.storeSubtitle")}</p>

      {isError && templates.length === 0 ? (
        <ErrorState onRetry={() => refetch()} />
      ) : isLoading ? (
        <Spinner />
      ) : templates.length === 0 ? (
        <EmptyState icon={Store} title={t("resources.storeTitle")}>{t("resources.noMatches")}</EmptyState>
      ) : (
        <TemplateGrid
          templates={templates}
          onPick={(tpl) =>
            user?.uiMode === "home"
              ? setInstalling(tpl)
              : router.push(`/resources/new?template=${tpl.slug}`)
          }
        />
      )}
      {installing && <InstallModal template={installing} onClose={() => setInstalling(null)} />}
    </div>
  );
}
