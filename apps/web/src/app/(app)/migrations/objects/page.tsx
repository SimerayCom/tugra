"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../../lib/api";
import { useT } from "../../../../i18n/provider";
import { Card, EmptyState, LinkBtn, Spinner } from "../../../../components/ui";
import { ErrorState } from "../../../../components/error-state";
import { PageHeader } from "../../../../components/page-header";
import { statusLabelKey } from "../../../../lib/object-migration-labels";

export default function ObjectMigrationsPage() {
  const t = useT();
  const { data = [], isLoading, isError, refetch } = useQuery({ queryKey: ["object-migrations"], queryFn: () => api.listObjectMigrations() });
  return (
    <div style={{ padding: "var(--page-pad)", maxWidth: 880 }}>
      <PageHeader title={t("objectMigration.title")} actions={<LinkBtn href="/migrations/objects/new">{t("objectMigration.new")}</LinkBtn>} />
      <p style={{ fontSize: 13, color: "var(--c-tx3)", margin: "-8px 0 18px" }}>{t("objectMigration.subtitle")}</p>
      {isError && data.length === 0 ? (
        <ErrorState onRetry={() => refetch()} />
      ) : isLoading ? (
        <Spinner />
      ) : data.length === 0 ? (
        <Card><EmptyState title={t("objectMigration.title")}>{t("objectMigration.list.empty")}</EmptyState></Card>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {data.map((m) => (
            <Link key={m.id} href={`/migrations/objects/${m.id}`} style={{ textDecoration: "none", color: "inherit" }}>
              <Card style={{ padding: 14, display: "flex", flexWrap: "wrap", gap: 10, alignItems: "baseline" }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>{m.name}</span>
                <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t(statusLabelKey(m.status))}</span>
                <span className="mono" style={{ fontSize: 11, color: "var(--c-tx3)", wordBreak: "break-all" }}>{m.srcEndpoint} {"->"} {m.dstEndpoint}</span>
                <span style={{ fontSize: 11, color: "var(--c-tx3)", marginLeft: "auto" }}>{t("objectMigration.list.buckets", { n: m.buckets.filter((b) => b.selected).length })}</span>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
