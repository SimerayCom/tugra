"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Pencil, Trash2 } from "lucide-react";
import { api } from "../../../lib/api";
import { useT } from "../../../i18n/provider";
import { useIsPro } from "../../../hooks/useIsPro";
import { Badge, Btn, Card, EmptyState, Spinner } from "../../../components/ui";
import { ErrorState } from "../../../components/error-state";
import { IconBtn } from "../../../components/icon-btn";
import { useConfirm } from "../../../components/confirm";
import { Field, Select, TextInput } from "../../../components/form";
import type { SecretProvider } from "../../../lib/types";

export default function SecretProvidersPage() {
  const t = useT();
  const qc = useQueryClient();
  const { ready, isPro } = useIsPro();
  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });
  const { data: providers = [], isLoading, isError, refetch } = useQuery({ queryKey: ["secretProviders"], queryFn: () => api.listSecretProviders() });

  const [teamId, setTeamId] = useState("");
  const activeTeam = teamId || teams.find((tm) => tm.role !== "VIEWER")?.id || teams[0]?.id || "";
  const canCreate = teams.some((tm) => tm.id === activeTeam && tm.role !== "VIEWER");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [token, setToken] = useState("");

  const invalidate = () => qc.invalidateQueries({ queryKey: ["secretProviders"] });
  // Closure mutationFn (NOT mutate(vars)) so the token is never retained in react-query's mutation cache.
  const create = useMutation({
    mutationFn: () => api.createSecretProvider({ teamId: activeTeam, name, kind: "vault", address, token }),
    onSuccess: () => { setName(""); setAddress(""); setToken(""); invalidate(); },
  });

  const httpWarn = address.trim().toLowerCase().startsWith("http://");

  return (
    <div style={{ padding: "var(--page-pad)", maxWidth: 880 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px", display: "flex", alignItems: "center", gap: 8 }}>
        <KeyRound size={20} color="var(--c-a)" /> {t("secretProviders.title")}
        {ready && !isPro && <Badge tone="gold">{t("common.pro")}</Badge>}
      </h1>
      <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: "0 0 22px", lineHeight: 1.5 }}>{t("secretProviders.subtitle")}</p>

      {ready && !isPro && (
        <Card style={{ padding: 14, marginBottom: 20, borderColor: "var(--c-a)" }}>
          <div style={{ fontSize: 13, color: "var(--c-tx2)", lineHeight: 1.5 }}>{t("secretProviders.proHint")}</div>
        </Card>
      )}

      {isError && providers.length === 0 ? (
        <ErrorState onRetry={() => refetch()} />
      ) : isLoading ? (
        <Spinner />
      ) : providers.length === 0 ? (
        <Card style={{ marginBottom: 20 }}><EmptyState icon={KeyRound} title={t("secretProviders.emptyTitle")}>{t("secretProviders.empty")}</EmptyState></Card>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 24 }}>
          {providers.map((p) => (
            <SecretProviderRow key={p.id} provider={p} proReady={ready} isPro={isPro} />
          ))}
        </div>
      )}

      {canCreate && (
        <Card style={{ padding: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 12 }}>{t("secretProviders.create")}</div>
          <form onSubmit={(e) => { e.preventDefault(); if (isPro && name && address && token && activeTeam) create.mutate(); }}>
            <fieldset disabled={!isPro} style={{ border: "none", padding: 0, margin: 0, opacity: isPro ? 1 : 0.55 }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
                <Field label={t("secretProviders.name")} htmlFor="sp-name"><TextInput id="sp-name" value={name} onChange={(e) => setName(e.target.value)} required disabled={!isPro} /></Field>
                <Field label={t("secretProviders.team")}><Select value={activeTeam} onChange={setTeamId} options={teams.map((tm) => ({ value: tm.id, label: tm.name }))} disabled={!isPro} /></Field>
                <Field label={t("secretProviders.kind")}><div style={{ paddingTop: 6 }}><Badge tone="gold">{t("secretProviders.kindVault")}</Badge></div></Field>
                <Field label={t("secretProviders.address")} htmlFor="sp-addr">
                  <TextInput id="sp-addr" type="url" value={address} onChange={(e) => setAddress(e.target.value)} placeholder={t("secretProviders.addressPlaceholder")} required disabled={!isPro} />
                </Field>
                <Field label={t("secretProviders.token")} htmlFor="sp-token" hint={t("secretProviders.tokenHint")}>
                  <TextInput id="sp-token" type="password" autoComplete="new-password" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} required disabled={!isPro} />
                </Field>
              </div>
              {httpWarn && <div style={{ color: "var(--c-am)", fontSize: 12, marginTop: 8 }}>{t("secretProviders.addressHttpWarn")}</div>}
              <div style={{ marginTop: 12 }}>
                <Btn type="submit" disabled={!isPro || create.isPending || !name || !address || !token || !activeTeam}>{create.isPending ? "…" : t("secretProviders.add")}</Btn>
              </div>
            </fieldset>
            {create.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(create.error as Error).message}</div>}
          </form>
        </Card>
      )}
    </div>
  );
}

function SecretProviderRow({ provider, proReady, isPro }: { provider: SecretProvider; proReady: boolean; isPro: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const canWrite = provider.canWrite;
  const [editing, setEditing] = useState(false);
  const [eName, setEName] = useState(provider.name);
  const [eAddr, setEAddr] = useState(provider.address);
  const [eToken, setEToken] = useState("");
  const [editErr, setEditErr] = useState("");

  const invalidate = () => qc.invalidateQueries({ queryKey: ["secretProviders"] });
  const test = useMutation({ mutationFn: () => api.testSecretProvider(provider.id) });
  const update = useMutation({
    // Token is write-only: only send it when the operator typed a new one (blank keeps the current token).
    mutationFn: () => api.updateSecretProvider(provider.id, { name: eName, address: eAddr, ...(eToken ? { token: eToken } : {}) }),
    onSuccess: () => { setEditing(false); setEToken(""); invalidate(); },
  });
  const del = useMutation({ mutationFn: () => api.deleteSecretProvider(provider.id), onSuccess: invalidate });

  const openEdit = () => { setEName(provider.name); setEAddr(provider.address); setEToken(""); setEditErr(""); setEditing(true); };
  const submitEdit = () => {
    // Mirror the hub: changing the store address requires re-supplying the token (never re-send the old one).
    if (eAddr !== provider.address && !eToken) { setEditErr(t("secretProviders.tokenRequiredOnAddressChange")); return; }
    setEditErr("");
    if (eName && eAddr) update.mutate();
  };
  const onDelete = async () => {
    if (provider.refCount > 0) return;
    if (await confirm({ body: t("common.deleteConfirm"), danger: true })) del.mutate();
  };
  const gate = !proReady || !isPro; // Pro actions disabled while loading or on Community

  return (
    <Card style={{ padding: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>{provider.name}</span>
            <Badge tone="gold">{provider.kind}</Badge>
          </div>
          <div style={{ fontSize: 12, color: "var(--c-tx3)", fontFamily: "var(--font-mono, monospace)", overflowWrap: "anywhere", marginTop: 4 }}>{provider.address}</div>
          <div style={{ fontSize: 11, color: "var(--c-tx3)", marginTop: 4, display: "flex", gap: 10, flexWrap: "wrap" }}>
            <span>{provider.lastVerifiedAt ? t("secretProviders.lastVerified", { date: new Date(provider.lastVerifiedAt).toLocaleDateString() }) : t("secretProviders.neverVerified")}</span>
            <span>{t("secretProviders.usedBy", { n: provider.refCount })}</span>
          </div>
        </div>
        {canWrite && (
          <>
            <Btn variant="ghost" onClick={() => test.mutate()} disabled={gate || test.isPending} title={gate ? t("secretProviders.proRequired") : undefined}>{test.isPending ? "…" : t("secretProviders.test")}</Btn>
            <IconBtn label={t("secretProviders.edit")} onClick={() => (editing ? setEditing(false) : openEdit())} disabled={gate}><Pencil size={15} /></IconBtn>
            <IconBtn label={provider.refCount > 0 ? t("secretProviders.deleteBlockedInUse") : t("secretProviders.delete")} danger onClick={onDelete} disabled={provider.refCount > 0}><Trash2 size={15} /></IconBtn>
          </>
        )}
      </div>
      {editing && canWrite && (
        <form onSubmit={(e) => { e.preventDefault(); submitEdit(); }} style={{ marginTop: 12, borderTop: "1px solid var(--c-bd)", paddingTop: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
            <Field label={t("secretProviders.name")}><TextInput value={eName} onChange={(e) => setEName(e.target.value)} required /></Field>
            <Field label={t("secretProviders.address")}><TextInput type="url" value={eAddr} onChange={(e) => setEAddr(e.target.value)} required /></Field>
            <Field label={t("secretProviders.token")} hint={t("secretProviders.tokenKeep")}><TextInput type="password" autoComplete="new-password" spellCheck={false} value={eToken} onChange={(e) => setEToken(e.target.value)} placeholder="••••••" /></Field>
          </div>
          <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
            <Btn type="submit" disabled={update.isPending || !eName || !eAddr}>{update.isPending ? "…" : t("common.save")}</Btn>
            <Btn variant="ghost" onClick={() => setEditing(false)}>{t("common.cancel")}</Btn>
          </div>
          {editErr && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{editErr}</div>}
          {update.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(update.error as Error).message}</div>}
        </form>
      )}
      {test.isSuccess && <div style={{ color: "var(--c-g)", fontSize: 12, marginTop: 8 }}>{t("secretProviders.testOk")}</div>}
      {test.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(test.error as Error).message}</div>}
      {del.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(del.error as Error).message}</div>}
    </Card>
  );
}
