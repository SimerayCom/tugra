"use client";

import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { api } from "../../../../../lib/api";
import { useT } from "../../../../../i18n/provider";
import { PageHeader } from "../../../../../components/page-header";
import { useToast } from "../../../../../components/toast";
import { SourceDestinationForm } from "../../../../../components/object-migration/source-destination-form";

export default function NewObjectMigrationPage() {
  const t = useT();
  const router = useRouter();
  const toast = useToast();
  // Create, then run the preflight right away so the next screen already lists the buckets (nothing selected).
  const create = useMutation({
    mutationFn: async (input: Parameters<typeof api.createObjectMigration>[0]) => {
      const m = await api.createObjectMigration(input);
      return m;
    },
    onSuccess: (m) => router.push(`/migrations/objects/${m.id}`),
    onError: (e) => toast((e as Error).message, "error"),
  });
  return (
    <div style={{ padding: "var(--page-pad)", maxWidth: 820 }}>
      <PageHeader breadcrumb={[{ label: t("objectMigration.back"), href: "/migrations/objects" }, { label: t("objectMigration.new") }]} title={t("objectMigration.new")} />
      <SourceDestinationForm busy={create.isPending} onSubmit={(input) => create.mutate(input)} />
    </div>
  );
}
