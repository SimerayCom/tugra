"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Store } from "lucide-react";
import { api } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../i18n/provider";
import { EmptyState } from "../../../components/ui";
import { ErrorState } from "../../../components/error-state";
import { TemplateGrid } from "../../../components/template-grid";
import { InstallModal } from "../../../components/install-modal";
import { AppDetailSheet } from "../../../components/app-detail-sheet";
import { Skeleton, SkeletonText } from "../../../components/skeleton";
import { installedBySlug } from "../../../lib/installed";
import type { Template } from "../../../lib/types";

export default function AppStorePage() {
  const t = useT();
  const router = useRouter();
  const { user } = useAuth();
  const [installing, setInstalling] = useState<Template | null>(null);
  const [detailFor, setDetailFor] = useState<Template | null>(null);
  // Install handoff shared by a card's detail sheet and a direct pick: home deploys inline, fleet hands to the
  // full New-resource wizard with the chosen template preselected.
  const install = (tpl: Template) => (user?.uiMode === "home" ? setInstalling(tpl) : router.push(`/resources/new?template=${tpl.slug}`));
  // Stable identity so a background ['apps'] refetch (window focus) doesn't re-run the detail sheet's Modal
  // effect and yank keyboard focus back to the first element.
  const closeDetail = useCallback(() => setDetailFor(null), []);
  const { data: templates = [], isLoading, isError, refetch } = useQuery({ queryKey: ["templates"], queryFn: () => api.listTemplates() });
  // Same query key as the Home launcher, so an install there reflects here without a refetch. Non-fatal: if the
  // apps list can't load, the store simply shows no installed badges.
  const { data: apps = [] } = useQuery({ queryKey: ["apps"], queryFn: () => api.listApps() });
  const installed = installedBySlug(apps);

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
        <>
          <div style={{ maxWidth: 480, marginBottom: 10 }}>
            <Skeleton height={38} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
            {Array.from({ length: 9 }).map((_, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: 12, borderRadius: "var(--r1)", border: "1px solid var(--c-bd)" }}>
                <Skeleton width={56} height={56} radius={12} style={{ flexShrink: 0 }} />
                <div style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
                  <Skeleton height={14} width="60%" />
                  <SkeletonText lines={2} width="90%" />
                </div>
              </div>
            ))}
          </div>
        </>
      ) : templates.length === 0 ? (
        <EmptyState icon={Store} title={t("resources.storeTitle")}>{t("resources.noMatches")}</EmptyState>
      ) : (
        <TemplateGrid templates={templates} installed={installed} onPick={install} onDetails={setDetailFor} />
      )}
      {detailFor && (
        <AppDetailSheet
          template={detailFor}
          installed={installed.get(detailFor.slug)}
          onInstall={() => { const tpl = detailFor; setDetailFor(null); install(tpl); }}
          onClose={closeDetail}
        />
      )}
      {installing && <InstallModal template={installing} onClose={() => setInstalling(null)} />}
    </div>
  );
}
