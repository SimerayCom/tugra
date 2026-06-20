"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { useT } from "../../../i18n/provider";
import { ServerTable } from "../../../components/server-table";
import { TagFilter } from "../../../components/tags";
import { Btn, Spinner } from "../../../components/ui";

export default function ServersPage() {
  const t = useT();
  const { data: servers, isLoading, error } = useQuery({
    queryKey: ["servers"],
    queryFn: () => api.listServers(),
  });
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const allTags = [...new Set((servers ?? []).flatMap((s) => s.tags))].sort();
  const visible = (servers ?? []).filter((s) => selectedTags.every((tag) => s.tags.includes(tag)));

  return (
    <div style={{ padding: 28 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>{t("servers.title")}</h1>
        <Link href="/servers/new">
          <Btn>{t("servers.add")}</Btn>
        </Link>
      </div>
      {isLoading && <Spinner />}
      {error && <div style={{ color: "var(--c-r)" }}>{t("servers.loadFailed", { msg: (error as Error).message })}</div>}
      {servers && (
        <>
          <TagFilter all={allTags} selected={selectedTags} onChange={setSelectedTags} />
          <ServerTable servers={visible} />
        </>
      )}
    </div>
  );
}
