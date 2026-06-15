"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { ServerTable } from "../../../components/server-table";
import { Btn, Spinner } from "../../../components/ui";

export default function ServersPage() {
  const { data: servers, isLoading, error } = useQuery({
    queryKey: ["servers"],
    queryFn: () => api.listServers(),
  });

  return (
    <div style={{ padding: 28 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Sunucular</h1>
        <Link href="/servers/new">
          <Btn>+ Sunucu Ekle</Btn>
        </Link>
      </div>
      {isLoading && <Spinner />}
      {error && <div style={{ color: "var(--c-r)" }}>Yüklenemedi: {(error as Error).message}</div>}
      {servers && <ServerTable servers={servers} />}
    </div>
  );
}
