"use client";

import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../../lib/api";
import { pct } from "../../../../lib/fleet";
import { MetricChart } from "../../../../components/charts";
import { Badge, Card, Spinner, StatusDot } from "../../../../components/ui";

export default function ServerDetailPage() {
  const params = useParams();
  const id = String(params.id);

  const { data: server, isLoading } = useQuery({
    queryKey: ["server", id],
    queryFn: () => api.getServer(id),
    refetchInterval: 5000,
  });
  const { data: metrics = [] } = useQuery({
    queryKey: ["metrics", id],
    queryFn: () => api.getMetrics(id, 60),
    refetchInterval: 5000,
  });

  if (isLoading || !server) return <div style={{ padding: 28 }}><Spinner /></div>;

  const cpu = metrics.map((m) => m.cpu);
  const ram = metrics.map((m) => pct(m.memUsed, m.memTotal));

  return (
    <div style={{ padding: 28 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
        <StatusDot status={server.status} />
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>{server.name}</h1>
        <Badge tone={server.canWrite ? "gold" : "muted"}>{server.role}</Badge>
      </div>
      <p className="mono" style={{ color: "var(--c-tx3)", fontSize: 13, margin: "0 0 20px" }}>
        {server.hostname ?? "—"} · {server.status}
      </p>

      <Card style={{ padding: 16, marginBottom: 20, display: "flex", gap: 28, flexWrap: "wrap" }}>
        <Info label="Durum" value={server.status} />
        <Info label="Takım" value={server.teamId.slice(0, 8)} />
        <Info label="🏛️ Tuğra (seal)" value={server.seal ? "✓ damgalandı" : "—"} />
        <Info label="Son görülme" value={server.lastSeenAt ? new Date(server.lastSeenAt).toLocaleTimeString() : "—"} />
      </Card>

      {metrics.length === 0 ? (
        <Card style={{ padding: 24, color: "var(--c-tx3)" }}>
          Henüz metrik yok — agent bağlanınca canlı akış başlar.
        </Card>
      ) : (
        <div style={{ display: "grid", gap: 16, gridTemplateColumns: "1fr 1fr" }}>
          <MetricChart data={cpu} label="CPU" unit="%" color="var(--c-a)" />
          <MetricChart data={ram} label="RAM" unit="%" color="var(--c-lapis)" />
        </div>
      )}
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--c-tx3)", marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 600 }}>{value}</div>
    </div>
  );
}
