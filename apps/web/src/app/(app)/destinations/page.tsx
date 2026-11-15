"use client";

import { useState } from "react";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HardDrive } from "lucide-react";
import { api } from "../../../lib/api";
import type { BackupDestination } from "../../../lib/types";
import { destSummary, destTypeLabel } from "../../../lib/destinations";
import { useT } from "../../../i18n/provider";
import { Btn, Card, EmptyState, Spinner } from "../../../components/ui";
import { ErrorState } from "../../../components/error-state";
import { Modal } from "../../../components/modal";
import { RecoveryKeyDialog } from "./recovery-key-dialog";
import { useToast } from "../../../components/toast";
import { Select } from "../../../components/form";

const BANNER_KEY = "tugra.destinations.legacyBannerDismissed";
const readDismissed = (): boolean => {
  try { return window.localStorage.getItem(BANNER_KEY) === "1"; } catch { return false; }
};
const writeDismissed = () => {
  try { window.localStorage.setItem(BANNER_KEY, "1"); } catch { /* storage unavailable: the banner just returns next visit */ }
};

const field: React.CSSProperties = {
  padding: "8px 10px",
  background: "var(--c-el)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  fontSize: 13,
  fontFamily: "inherit",
};

function EditDestinationForm({ dest, onDone }: { dest: BackupDestination; onDone: () => void }) {
  const t = useT();
  const [name, setName] = useState(dest.name);
  const [region, setRegion] = useState(dest.s3Region ?? "");
  const [accessKey, setAccessKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const save = useMutation({
    mutationFn: () =>
      api.updateDestination(dest.id, {
        name,
        s3Region: region || null,
        // Blank = keep the stored key (rotate only when a new value is typed).
        ...(accessKey ? { s3AccessKey: accessKey } : {}),
        ...(secretKey ? { s3SecretKey: secretKey } : {}),
      }),
    onSuccess: onDone,
  });
  // Bucket / endpoint / prefix / encryption are fixed once a destination exists (existing backups are stored
  // at that location + key); changing them means a new destination. Only name/region/credentials are editable.
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); save.mutate(); }}
      style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", padding: "0 16px 14px" }}
    >
      <input style={{ ...field, width: 130 }} placeholder={t("destinations.name")} aria-label={t("destinations.name")} value={name} onChange={(e) => setName(e.target.value)} required />
      <input style={{ ...field, width: 110 }} placeholder={t("destinations.region")} aria-label={t("destinations.region")} value={region} onChange={(e) => setRegion(e.target.value)} />
      <input style={{ ...field, width: 150 }} placeholder={t("destinations.accessKeyKeep")} aria-label={t("destinations.accessKey")} value={accessKey} onChange={(e) => setAccessKey(e.target.value)} />
      <input style={{ ...field, width: 160 }} type="password" placeholder={t("destinations.secretKeyKeep")} aria-label={t("destinations.secretKey")} value={secretKey} onChange={(e) => setSecretKey(e.target.value)} />
      <button type="submit" disabled={save.isPending} style={{ ...field, background: "var(--c-a)", color: "var(--c-on-a)", fontWeight: 600, cursor: "pointer" }}>
        {save.isPending ? "…" : t("common.save")}
      </button>
      <span style={{ fontSize: 11, color: "var(--c-tx3)", width: "100%" }}>{t("destinations.editHint")}</span>
      {save.isError && <div style={{ color: "var(--c-r)", fontSize: 12, width: "100%" }}>{(save.error as Error).message}</div>}
    </form>
  );
}

/** Delete confirmation. An encrypted destination that still has backups 409s; the message is shown here and the
 *  checkbox re-sends the request with ?discardBackups=true (deleting destroys the key those backups need). */
function DeleteDestinationModal({ dest, onClose, onDeleted }: { dest: BackupDestination; onClose: () => void; onDeleted: () => void }) {
  const t = useT();
  const [discard, setDiscard] = useState(false);
  const del = useMutation({
    mutationFn: () => api.deleteDestination(dest.id, { discardBackups: discard }),
    onSuccess: onDeleted,
  });
  return (
    <Modal onClose={onClose} width={460} ariaLabel={t("destinations.delete")}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontWeight: 700 }}>{t("destinations.delete_confirm", { name: dest.name })}</div>
        {dest.encryptionEnabled && (
          <>
            <div style={{ fontSize: 13, color: "var(--c-am)", lineHeight: 1.5 }}>{t("destinations.delete_keyLoss")}</div>
            <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13 }}>
              <input type="checkbox" checked={discard} onChange={(e) => setDiscard(e.target.checked)} style={{ marginTop: 2 }} />
              {t("destinations.delete_discardAck")}
            </label>
          </>
        )}
        {del.isError && <div role="alert" style={{ color: "var(--c-r)", fontSize: 12 }}>{(del.error as Error).message}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Btn variant="ghost" onClick={onClose}>{t("common.cancel")}</Btn>
          <Btn variant="danger" onClick={() => del.mutate()} disabled={del.isPending}>{t("destinations.delete")}</Btn>
        </div>
      </div>
    </Modal>
  );
}

export default function DestinationsPage() {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const { data: destinations = [], isLoading, isError, refetch } = useQuery({
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
  // The one-time recovery key lives in component state only (never the query/mutation cache or storage).
  const [recovery, setRecovery] = useState<{ name: string; key: string } | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState<boolean>(() => (typeof window === "undefined" ? true : readDismissed()));

  const create = useMutation({
    mutationFn: async () => {
      const created = await api.createDestination({
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
      });
      // Strip the key before it can sit in the mutation cache; hand it to the dialog state instead.
      const { recoveryKey, ...dest } = created;
      if (recoveryKey) setRecovery({ name: dest.name, key: recoveryKey });
      return dest;
    },
    onSuccess: () => {
      setName(""); setBucket(""); setRegion(""); setEndpoint(""); setAccessKey(""); setSecretKey(""); setPrefix("");
      qc.invalidateQueries({ queryKey: ["destinations"] });
    },
  });
  const [editId, setEditId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<BackupDestination | null>(null);
  const test = useMutation({
    mutationFn: (id: string) => api.testDestination(id),
    onSuccess: (r) => {
      let msg = r.message;
      if (r.encryption === "OK") msg += ` ${t("destinations.test_encryptionOk")}`;
      else if (r.encryption === "FAILED") msg = /gpg is not installed/i.test(r.message) ? t("destinations.test_gpgMissing") : t("destinations.test_encryptionFail", { message: r.message });
      toast(msg, r.ok ? "success" : "error");
    },
  });
  const hasUnencrypted = destinations.some((d) => !d.encryptionEnabled);

  return (
    <div style={{ padding: "var(--page-pad)" }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>{t("destinations.title")}</h1>
      <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: "0 0 22px" }}>{t("destinations.subtitle")}</p>

      {recovery && <RecoveryKeyDialog name={recovery.name} recoveryKey={recovery.key} onClose={() => setRecovery(null)} />}
      {deleting && (
        <DeleteDestinationModal
          dest={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => { setDeleting(null); qc.invalidateQueries({ queryKey: ["destinations"] }); }}
        />
      )}
      {hasUnencrypted && !bannerDismissed && (
        <div role="note" style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap", padding: "10px 14px", marginBottom: 16, background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r2)" }}>
          <ShieldAlert size={16} style={{ color: "var(--c-am)", marginTop: 2 }} />
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>{t("destinations.legacyBanner_title")}</div>
            <div style={{ fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 }}>{t("destinations.legacyBanner_body")}</div>
          </div>
          <Btn variant="ghost" onClick={() => { writeDismissed(); setBannerDismissed(true); }}>{t("destinations.legacyBanner_dismiss")}</Btn>
        </div>
      )}

      <Card style={{ padding: 16, marginBottom: 20 }}>
        <form
          onSubmit={(e) => { e.preventDefault(); create.mutate(); }}
          style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}
        >
          <Select value={teamId} onChange={setTeamId} autoSelectFirst required placeholder={t("common.pickTeam")}
            style={{ width: "auto", minWidth: 130 }}
            options={teams.map((tm) => ({ value: tm.id, label: tm.name }))} />
          <input style={{ ...field, width: 130 }} placeholder={t("destinations.name")} aria-label={t("destinations.name")} value={name} onChange={(e) => setName(e.target.value)} required />
          <input style={{ ...field, width: 140 }} placeholder={t("destinations.bucket")} aria-label={t("destinations.bucket")} value={bucket} onChange={(e) => setBucket(e.target.value)} required />
          <input style={{ ...field, width: 150 }} placeholder={t("destinations.endpoint")} aria-label={t("destinations.endpoint")} value={endpoint} onChange={(e) => setEndpoint(e.target.value)} required />
          <input style={{ ...field, width: 100 }} placeholder={t("destinations.region")} aria-label={t("destinations.region")} value={region} onChange={(e) => setRegion(e.target.value)} />
          <input style={{ ...field, width: 130 }} placeholder={t("destinations.accessKey")} aria-label={t("destinations.accessKey")} value={accessKey} onChange={(e) => setAccessKey(e.target.value)} required />
          <input style={{ ...field, width: 150 }} type="password" placeholder={t("destinations.secretKey")} aria-label={t("destinations.secretKey")} value={secretKey} onChange={(e) => setSecretKey(e.target.value)} required />
          <input style={{ ...field, width: 100 }} placeholder={t("destinations.prefix")} aria-label={t("destinations.prefix")} value={prefix} onChange={(e) => setPrefix(e.target.value)} />
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--c-tx2)" }}>
            <input type="checkbox" checked={encrypt} onChange={(e) => setEncrypt(e.target.checked)} />
            {t("destinations.encrypt")}
          </label>
          <button type="submit" disabled={create.isPending} style={{ ...field, background: "var(--c-a)", color: "var(--c-on-a)", fontWeight: 600, cursor: "pointer" }}>
            {create.isPending ? "…" : t("destinations.create")}
          </button>
        </form>
        <div style={{ fontSize: 11, color: "var(--c-tx3)", marginTop: 8 }}>{t("destinations.encryptHint")}</div>
        {!encrypt && <div role="alert" style={{ fontSize: 12, color: "var(--c-am)", marginTop: 6 }}>{t("destinations.optOutWarning")}</div>}
        {create.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(create.error as Error).message}</div>}
      </Card>

      {isError && destinations.length === 0 ? (
        <ErrorState onRetry={() => refetch()} />
      ) : isLoading ? (
        <Spinner />
      ) : (
        <div style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r2)", overflow: "hidden" }}>
          {destinations.map((d) => (
            <div key={d.id} style={{ borderTop: "1px solid var(--c-bd)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px" }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 14, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span>{d.name} <span style={{ fontSize: 11, color: "var(--c-tx3)", fontWeight: 400 }}>· {destTypeLabel(d.type)}</span></span>
                    <span data-testid={`enc-${d.id}`} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 600, color: d.encryptionEnabled ? "var(--c-g)" : "var(--c-am)" }}>
                      {d.encryptionEnabled ? <ShieldCheck size={12} /> : <ShieldAlert size={12} />}
                      {d.encryptionEnabled ? t("destinations.state_encrypted") : t("destinations.state_unencrypted")}
                    </span>
                  </div>
                  <div className="mono" style={{ fontSize: 11, color: "var(--c-tx3)" }}>{destSummary(d)}</div>
                </div>
                {d.canWrite && d.type === "S3" && <Btn variant="ghost" onClick={() => setEditId(editId === d.id ? null : d.id)}>{editId === d.id ? t("common.cancel") : t("destinations.edit")}</Btn>}
                {d.canWrite && <Btn variant="ghost" onClick={() => test.mutate(d.id)} disabled={test.isPending}>{test.isPending ? "…" : t("destinations.test")}</Btn>}
                {d.canWrite && <Btn variant="danger" onClick={() => setDeleting(d)}>{t("destinations.delete")}</Btn>}
              </div>
              {editId === d.id && <EditDestinationForm dest={d} onDone={() => { setEditId(null); qc.invalidateQueries({ queryKey: ["destinations"] }); }} />}
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
