"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Package, Pencil, Trash2 } from "lucide-react";
import { api } from "../../../lib/api";
import { useT } from "../../../i18n/provider";
import { Badge, Btn, Card, EmptyState, Spinner } from "../../../components/ui";
import { ErrorState } from "../../../components/error-state";
import { IconBtn } from "../../../components/icon-btn";
import { useConfirm } from "../../../components/confirm";
import { Field, Select, TextInput } from "../../../components/form";

const TYPES = ["dockerhub", "ghcr", "gitlab", "generic"];

export default function RegistriesPage() {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });
  const { data: registries = [], isLoading, isError, refetch } = useQuery({ queryKey: ["registries"], queryFn: () => api.listRegistries() });

  const [teamId, setTeamId] = useState("");
  const activeTeam = teamId || teams.find((tm) => tm.role !== "VIEWER")?.id || teams[0]?.id || "";
  const canCreate = teams.some((tm) => tm.id === activeTeam && tm.role !== "VIEWER");
  const [name, setName] = useState("");
  const [type, setType] = useState("generic");
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [imagePrefix, setImagePrefix] = useState("");

  const invalidate = () => qc.invalidateQueries({ queryKey: ["registries"] });
  const create = useMutation({
    mutationFn: () =>
      api.createRegistry({ name, teamId: activeTeam, type, url: url.trim() || null, username, password, imagePrefix: imagePrefix.trim() || null }),
    onSuccess: () => { setName(""); setUrl(""); setUsername(""); setPassword(""); setImagePrefix(""); invalidate(); },
  });
  const del = useMutation({ mutationFn: (id: string) => api.deleteRegistry(id), onSuccess: invalidate });

  return (
    <div style={{ padding: "var(--page-pad)", maxWidth: 880 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px", display: "flex", alignItems: "center", gap: 8 }}>
        <Package size={20} color="var(--c-a)" /> {t("registries.title")}
      </h1>
      <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: "0 0 22px" }}>{t("registries.subtitle")}</p>

      {isError && registries.length === 0 ? (
        <ErrorState onRetry={() => refetch()} />
      ) : isLoading ? (
        <Spinner />
      ) : registries.length === 0 ? (
        <Card style={{ marginBottom: 20 }}><EmptyState icon={Package} title={t("registries.emptyTitle")}>{t("registries.noRegistries")}</EmptyState></Card>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 24 }}>
          {registries.map((r) => (
            <RegistryRow
              key={r.id}
              id={r.id}
              name={r.name}
              type={r.type}
              url={r.url}
              username={r.username}
              imagePrefix={r.imagePrefix}
              canWrite={r.canWrite}
              onDelete={async () => { if (await confirm({ body: t("common.deleteConfirm"), danger: true })) del.mutate(r.id); }}
            />
          ))}
        </div>
      )}

      {canCreate && (
        <Card style={{ padding: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>{t("registries.create")}</div>
          <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("registries.howto")}</p>
          <form onSubmit={(e) => { e.preventDefault(); if (name && username && password && activeTeam) create.mutate(); }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
              <Field label={t("registries.name")} htmlFor="reg-name"><TextInput id="reg-name" value={name} onChange={(e) => setName(e.target.value)} required /></Field>
              <Field label={t("registries.team")}><Select value={activeTeam} onChange={setTeamId} options={teams.map((tm) => ({ value: tm.id, label: tm.name }))} /></Field>
              <Field label={t("registries.type")}><Select value={type} onChange={setType} options={TYPES.map((v) => ({ value: v, label: t(`registries.type_${v}`) }))} /></Field>
              <Field label={t("registries.url")} hint={t("registries.urlHint")}><TextInput value={url} onChange={(e) => setUrl(e.target.value)} placeholder="ghcr.io" /></Field>
              <Field label={t("registries.imagePrefix")} hint={t("registries.imagePrefixHint")}><TextInput value={imagePrefix} onChange={(e) => setImagePrefix(e.target.value)} placeholder="my-org" /></Field>
              <Field label={t("registries.username")}><TextInput value={username} onChange={(e) => setUsername(e.target.value)} required /></Field>
              <Field label={t("registries.password")}><TextInput type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
            </div>
            <div style={{ marginTop: 12 }}>
              <Btn type="submit" disabled={create.isPending || !name || !username || !password || !activeTeam}>{create.isPending ? "…" : t("registries.add")}</Btn>
            </div>
            {create.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(create.error as Error).message}</div>}
          </form>
        </Card>
      )}
    </div>
  );
}

function RegistryRow({
  id, name, type, url, username, imagePrefix, canWrite, onDelete,
}: { id: string; name: string; type: string; url: string | null; username: string; imagePrefix: string | null; canWrite: boolean; onDelete: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const test = useMutation({ mutationFn: () => api.testRegistry(id) });
  const [editing, setEditing] = useState(false);
  const [eName, setEName] = useState(name);
  const [eType, setEType] = useState(type);
  const [eUrl, setEUrl] = useState(url ?? "");
  const [eUser, setEUser] = useState(username);
  const [ePass, setEPass] = useState("");
  const [ePrefix, setEPrefix] = useState(imagePrefix ?? "");
  const openEdit = () => {
    setEName(name); setEType(type); setEUrl(url ?? ""); setEUser(username); setEPass(""); setEPrefix(imagePrefix ?? "");
    setEditing(true);
  };
  const update = useMutation({
    // password is write-only: only send it when the operator typed a new one (blank keeps the current creds).
    mutationFn: () =>
      api.updateRegistry(id, {
        name: eName, type: eType, url: eUrl.trim() || null, username: eUser,
        imagePrefix: ePrefix.trim() || null, ...(ePass ? { password: ePass } : {}),
      }),
    onSuccess: () => { setEditing(false); setEPass(""); qc.invalidateQueries({ queryKey: ["registries"] }); },
  });
  return (
    <Card style={{ padding: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>{name}</span>
            <Badge tone="gold">{t(`registries.type_${type}`)}</Badge>
          </div>
          <div className="mono" style={{ fontSize: 11, color: "var(--c-tx3)", marginTop: 3 }}>
            {url || "docker.io"}{imagePrefix ? `/${imagePrefix}` : ""} · {username}
          </div>
        </div>
        {canWrite && (
          <>
            <Btn variant="ghost" onClick={() => test.mutate()} disabled={test.isPending}>{test.isPending ? "…" : t("registries.test")}</Btn>
            <IconBtn label={t("registries.edit")} onClick={() => (editing ? setEditing(false) : openEdit())}><Pencil size={15} /></IconBtn>
            <IconBtn label={t("registries.delete")} danger onClick={onDelete}><Trash2 size={15} /></IconBtn>
          </>
        )}
      </div>
      {editing && canWrite && (
        <form
          onSubmit={(e) => { e.preventDefault(); if (eName && eUser) update.mutate(); }}
          style={{ marginTop: 12, borderTop: "1px solid var(--c-bd)", paddingTop: 12 }}
        >
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
            <Field label={t("registries.name")}><TextInput value={eName} onChange={(e) => setEName(e.target.value)} required /></Field>
            <Field label={t("registries.type")}><Select value={eType} onChange={setEType} options={TYPES.map((v) => ({ value: v, label: t(`registries.type_${v}`) }))} /></Field>
            <Field label={t("registries.url")}><TextInput value={eUrl} onChange={(e) => setEUrl(e.target.value)} placeholder="ghcr.io" /></Field>
            <Field label={t("registries.imagePrefix")}><TextInput value={ePrefix} onChange={(e) => setEPrefix(e.target.value)} placeholder="my-org" /></Field>
            <Field label={t("registries.username")}><TextInput value={eUser} onChange={(e) => setEUser(e.target.value)} required /></Field>
            <Field label={t("registries.password")} hint={t("registries.passwordKeep")}><TextInput type="password" value={ePass} onChange={(e) => setEPass(e.target.value)} placeholder="••••••" /></Field>
          </div>
          <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
            <Btn type="submit" disabled={update.isPending || !eName || !eUser}>{update.isPending ? "…" : t("common.save")}</Btn>
            <Btn variant="ghost" onClick={() => setEditing(false)}>{t("common.cancel")}</Btn>
          </div>
          {update.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(update.error as Error).message}</div>}
        </form>
      )}
      {test.isSuccess && <div style={{ color: "var(--c-g)", fontSize: 12, marginTop: 8 }}>{t("registries.testOk")}</div>}
      {test.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(test.error as Error).message}</div>}
    </Card>
  );
}
