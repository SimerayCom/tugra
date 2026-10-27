"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../../lib/api";
import { useT } from "../../../../i18n/provider";
import { BackLink, Btn } from "../../../../components/ui";
import { Field, Select, TextInput, fieldStyle } from "../../../../components/form";
import { CopyBtn } from "../../../../components/copy-row";
import type { ServerView } from "../../../../lib/types";
import { HETZNER_LOCATIONS, HETZNER_SERVER_TYPES } from "../../../../lib/hetzner-catalog";

export default function NewServerPage() {
  const t = useT();
  const [mode, setMode] = useState<"manual" | "bulk" | "cloud">("manual");
  const wide = mode === "bulk";

  return (
    <div style={{ padding: "var(--page-pad)", maxWidth: wide ? 640 : 480 }}>
      <BackLink href="/servers" label={t("common.backTo", { target: t("nav.servers") })} />
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 16px" }}>{t("servers.newTitle")}</h1>

      <div role="tablist" style={{ display: "flex", gap: 6, marginBottom: 18, flexWrap: "wrap" }}>
        <TabBtn active={mode === "manual"} onClick={() => setMode("manual")}>{t("servers.manualTab")}</TabBtn>
        <TabBtn active={mode === "bulk"} onClick={() => setMode("bulk")}>{t("servers.bulkTab")}</TabBtn>
        <TabBtn active={mode === "cloud"} onClick={() => setMode("cloud")}>{t("servers.provisionTab")}</TabBtn>
      </div>

      {mode === "manual" ? <ManualForm /> : mode === "bulk" ? <BulkForm /> : <CloudForm />}
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{
        padding: "6px 12px", fontSize: 13, fontFamily: "inherit", cursor: "pointer", borderRadius: "var(--r1)",
        border: "1px solid var(--c-bd)", background: active ? "var(--c-a)" : "transparent", color: active ? "#fff" : "var(--c-tx2)",
      }}
    >
      {children}
    </button>
  );
}

function ManualForm() {
  const t = useT();
  const router = useRouter();
  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });
  const [name, setName] = useState("");
  const [teamId, setTeamId] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const res = await api.createServer(name, teamId);
      router.replace(`/servers/${res.server.id}`); // stable, refresh-safe install URL
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("servers.createFailed"));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Field label={t("servers.name")} htmlFor="srv-name">
        <TextInput id="srv-name" value={name} onChange={(e) => setName(e.target.value)} required />
      </Field>
      <Field label={t("common.team")}>
        <Select value={teamId} onChange={setTeamId} autoSelectFirst required placeholder={t("common.pickTeam")}
          options={teams.map((tm) => ({ value: tm.id, label: `${tm.name} (${tm.role})` }))} />
      </Field>
      {err && <div style={{ color: "var(--c-r)", fontSize: 13 }}>{err}</div>}
      <div><Btn type="submit" disabled={busy}>{busy ? "…" : t("servers.create")}</Btn></div>
    </form>
  );
}

function BulkForm() {
  const t = useT();
  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });
  const [names, setNames] = useState("");
  const [teamId, setTeamId] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ server: ServerView; installCommand: string }[] | null>(null);

  // One name per line; trim, drop blanks, de-dupe (the server also does this — we mirror it for the live count).
  const unique = [...new Set(names.split("\n").map((n) => n.trim()).filter(Boolean))];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const res = await api.createServersBulk(unique, teamId);
      setCreated(res.servers);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("servers.createFailed"));
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    const allCmds = created.map((c) => c.installCommand).join("\n");
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{t("servers.bulkCreated", { n: created.length })}</div>
        <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: 0, lineHeight: 1.5 }}>{t("servers.bulkCreatedHint")}</p>
        <div><CopyBtn text={allCmds} label={t("servers.bulkCopyAll")} /></div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {created.map((c) => (
            <div key={c.server.id} style={{ border: "1px solid var(--c-bd)", borderRadius: 8, padding: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <Link href={`/servers/${c.server.id}`} style={{ fontWeight: 600, fontSize: 13, color: "var(--c-lapis)" }}>{c.server.name}</Link>
                <CopyBtn text={c.installCommand} />
              </div>
              <code className="mono" style={{ display: "block", fontSize: 11, color: "var(--c-tx3)", wordBreak: "break-all", marginTop: 6 }}>{c.installCommand}</code>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Field label={t("servers.bulkNames")} htmlFor="bulk-names">
        <textarea
          id="bulk-names"
          value={names}
          onChange={(e) => setNames(e.target.value)}
          rows={6}
          placeholder={"web-1\nweb-2\ndb-1"}
          style={{ ...fieldStyle, minHeight: 120, fontFamily: "var(--font-mono, monospace)", resize: "vertical" }}
        />
      </Field>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginTop: -6 }}>{t("servers.bulkNamesHint", { n: unique.length })}</div>
      <Field label={t("common.team")}>
        <Select value={teamId} onChange={setTeamId} autoSelectFirst required placeholder={t("common.pickTeam")}
          options={teams.map((tm) => ({ value: tm.id, label: `${tm.name} (${tm.role})` }))} />
      </Field>
      {err && <div style={{ color: "var(--c-r)", fontSize: 13 }}>{err}</div>}
      <div><Btn type="submit" disabled={busy || unique.length === 0 || !teamId}>{busy ? "…" : t("servers.bulkCreate", { n: unique.length })}</Btn></div>
    </form>
  );
}

function CloudForm() {
  const t = useT();
  const router = useRouter();
  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });
  const { data: creds = [] } = useQuery({ queryKey: ["cloudCredentials"], queryFn: () => api.listCloudCredentials() });
  const [name, setName] = useState("");
  const [teamId, setTeamId] = useState("");
  const [credentialId, setCredentialId] = useState("");
  const [location, setLocation] = useState(HETZNER_LOCATIONS[0].value);
  const [serverType, setServerType] = useState(HETZNER_SERVER_TYPES[0].value);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  // Only Hetzner credentials for the caller's chosen team can provision.
  const teamCreds = creds.filter((c) => c.provider === "hetzner" && c.teamId === teamId);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const server = await api.provisionServer({ teamId, name, cloudCredentialId: credentialId, provider: "hetzner", location, serverType });
      router.replace(`/servers/${server.id}`); // falls straight into the PENDING→ONLINE poll
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("servers.provisionFailed"));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Field label={t("servers.name")} htmlFor="cloud-name">
        <TextInput id="cloud-name" value={name} onChange={(e) => setName(e.target.value)} required />
      </Field>
      <Field label={t("common.team")}>
        <Select value={teamId} onChange={(v) => { setTeamId(v); setCredentialId(""); }} autoSelectFirst required placeholder={t("common.pickTeam")}
          options={teams.map((tm) => ({ value: tm.id, label: `${tm.name} (${tm.role})` }))} />
      </Field>
      {teamCreds.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--c-tx3)" }}>
          {t("servers.noCloudCredential")} <a href="/cloud-credentials" style={{ color: "var(--c-lapis)" }}>{t("servers.addCloudCredential")}</a>
        </div>
      ) : (
        <>
          <Field label={t("servers.credential")}>
            <Select value={credentialId} onChange={setCredentialId} autoSelectFirst required placeholder={t("servers.pickCredential")}
              options={teamCreds.map((c) => ({ value: c.id, label: c.name }))} />
          </Field>
          <Field label={t("servers.location")}>
            <Select value={location} onChange={setLocation} options={HETZNER_LOCATIONS} />
          </Field>
          <Field label={t("servers.serverType")}>
            <Select value={serverType} onChange={setServerType} options={HETZNER_SERVER_TYPES} />
          </Field>
          {err && <div style={{ color: "var(--c-r)", fontSize: 13 }}>{err}</div>}
          <div><Btn type="submit" disabled={busy || !credentialId}>{busy ? "…" : t("servers.provision")}</Btn></div>
        </>
      )}
    </form>
  );
}
