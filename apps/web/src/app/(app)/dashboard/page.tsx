"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { statusCounts } from "../../../lib/fleet";
import { Card } from "../../../components/ui";

export default function DashboardPage() {
  const { data: servers = [], isLoading } = useQuery({
    queryKey: ["servers"],
    queryFn: () => api.listServers(),
  });
  const counts = statusCounts(servers);

  const stat = (label: string, value: number | string, color = "var(--c-tx)") => (
    <Card style={{ padding: 18, flex: 1 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, color }}>{value}</div>
    </Card>
  );

  return (
    <div style={{ padding: 28 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>Komuta Merkezi</h1>
      <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: "0 0 22px" }}>
        Tüm takımlarındaki sunucular tek bakışta.
      </p>
      <div style={{ display: "flex", gap: 14, marginBottom: 22, flexWrap: "wrap" }}>
        {stat("Toplam sunucu", isLoading ? "…" : servers.length)}
        {stat("Online", counts.ONLINE, "var(--c-g)")}
        {stat("Pending", counts.PENDING, "var(--c-am)")}
        {stat("Offline", counts.OFFLINE, "var(--c-r)")}
      </div>
      <Link href="/servers" style={{ color: "var(--c-a)", fontSize: 14, fontWeight: 600 }}>
        Filo tablosuna git →
      </Link>
    </div>
  );
}
