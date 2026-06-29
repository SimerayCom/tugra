"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HardDrive } from "lucide-react";
import { api } from "../../../lib/api";
import { destSummary, destTypeLabel } from "../../../lib/destinations";
import { useT } from "../../../i18n/provider";
import { Btn, Card, EmptyState, Spinner } from "../../../components/ui";
import { useConfirm } from "../../../components/confirm";
import { useToast } from "../../../components/toast";
import { Select } from "../../../components/form";

const field: React.CSSProperties = {
  padding: "8px 10px",
  background: "var(--c-el)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  fontSize: 13,
  fontFamily: "inherit",
};

export default function DestinationsPage() {
  const t = useT();
  const confirm = useConfirm();
  const toast = useToast();
  const qc = useQueryClient();
  const { data: destinations = [], isLoading } = useQuery({
    queryKey: ["destinations"],
    queryFn: () => api.listDestinations(),
    refetchInterval: 10000,
  });
  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });

  const [teamId, setTeamId] = useState("");
  const [name, setName] = useState("");
  const [bucket, setBucket] = useState("");
  const [region, setRegion] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [prefix, setPrefix] = useState("");
  const [encrypt, setEncrypt] = useState(true);

  const create = useMutation({
    mutationFn: () =>
      api.createDestination({
        teamId: teamId || teams[0]?.id,
        name,
        type: "S3",
        s3Bucket: bucket,
        s3Region: region || undefined,
        s3Endpoint: endpoint,
        s3AccessKey: accessKey,
        s3SecretKey: secretKey,
        s3Prefix: prefix || undefined,
        encryptionEnabled: encrypt,
      }),
    onSuccess: () => {
      setName(""); setBucket(""); setRegion(""); setEndpoint(""); setAccessKey(""); setSecretKey(""); setPrefix("");
      qc.invalidateQueries({ queryKey: ["destinations"] });
    },
  });
  const del = useMutation({
    mutationFn: (id: string) => api.deleteDestination(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["destinations"] }),
  });
  const test = useMutation({
    mutationFn: (id: string) => api.testDestination(id),
    onSuccess: (r) => toast(r.message, r.ok ? "success" : "error"),
  });

  return (
    <div style={{ padding: "var(--page-pad)" }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>{t("destinations.title")}</h1>
      <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: "0 0 22px" }}>{t("destinations.subtitle")}</p>

      <Card style={{ padding: 16, marginBottom: 20 }}>
        <form
          onSubmit={(e) => { e.preventDefault(); create.mutate(); }}
          style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}
        >
          <Select value={teamId} onChange={setTeamId} autoSelectFirst required placeholder={t("common.pickTeam")}
            style={{ width: "auto", minWidth: 130 }}
            options={teams.map((tm) => ({ value: tm.id, label: tm.name }))} />
          <input style={{ ...field, width: 130 }} placeholder={t("destinations.name")} value={name} onChange={(e) => setName(e.target.value)} required />
          <input style={{ ...field, width: 140 }} placeholder={t("destinations.bucket")} value={bucket} onChange={(e) => setBucket(e.target.value)} required />
          <input style={{ ...field, width: 150 }} placeholder={t("destinations.endpoint")} value={endpoint} onChange={(e) => setEndpoint(e.target.value)} required />
          <input style={{ ...field, width: 100 }} placeholder={t("destinations.region")} value={region} onChange={(e) => setRegion(e.target.value)} />
          <input style={{ ...field, width: 130 }} placeholder={t("destinations.accessKey")} value={accessKey} onChange={(e) => setAccessKey(e.target.value)} required />
          <input style={{ ...field, width: 150 }} type="password" placeholder={t("destinations.secretKey")} value={secretKey} onChange={(e) => setSecretKey(e.target.value)} required />
          <input style={{ ...field, width: 100 }} placeholder={t("destinations.prefix")} value={prefix} onChange={(e) => setPrefix(e.target.value)} />
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--c-tx2)" }}>
            <input type="checkbox" checked={encrypt} onChange={(e) => setEncrypt(e.target.checked)} />
            {t("destinations.encrypt")}
          </label>
          <button type="submit" disabled={create.isPending} style={{ ...field, background: "var(--c-a)", color: "#0d0d11", fontWeight: 600, cursor: "pointer" }}>
            {create.isPending ? "…" : t("destinations.create")}
          </button>
        </form>
        {create.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(create.error as Error).message}</div>}
      </Card>

      {isLoading ? (
        <Spinner />
      ) : (
        <div style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r2)", overflow: "hidden" }}>
          {destinations.map((d) => (
            <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderTop: "1px solid var(--c-bd)" }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{d.name} <span style={{ fontSize: 11, color: "var(--c-tx3)", fontWeight: 400 }}>· {destTypeLabel(d.type)}</span></div>
                <div className="mono" style={{ fontSize: 11, color: "var(--c-tx3)" }}>{destSummary(d)}</div>
              </div>
              {d.canWrite && <Btn variant="ghost" onClick={() => test.mutate(d.id)} disabled={test.isPending}>{test.isPending ? "…" : t("destinations.test")}</Btn>}
              {d.canWrite && <Btn variant="danger" onClick={async () => { if (await confirm({ body: t("common.deleteConfirm"), danger: true })) del.mutate(d.id); }}>{t("destinations.delete")}</Btn>}
            </div>
          ))}
          {destinations.length === 0 && (
            <EmptyState icon={HardDrive} title={t("destinations.emptyTitle")}>{t("destinations.empty")}</EmptyState>
          )}
        </div>
      )}
    </div>
  );
}
