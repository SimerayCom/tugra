"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { Btn, SectionCard } from "../ui";
import { Checkbox, Field, Select, TextInput } from "../form";
import type { CreateObjectMigrationInput } from "../../lib/types";

/** A same-host MinIO is reached through host.docker.internal; the hub refuses loopback / link-local / userinfo / paths. */
const looksLikeEndpoint = (v: string): boolean => /^https?:\/\/[^\s/@]+$/i.test(v.trim());

/**
 * Source + destination credentials form. Presentation only: it hands the validated-looking values to `onSubmit` and
 * never keeps them past submit (the secret fields are cleared by the parent unmounting the form).
 */
export function SourceDestinationForm({ busy, onSubmit }: { busy: boolean; onSubmit: (input: CreateObjectMigrationInput) => void }) {
  const t = useT();
  const { data: servers = [] } = useQuery({ queryKey: ["servers"], queryFn: () => api.listServers() });
  const [name, setName] = useState("");
  const [serverId, setServerId] = useState("");
  const [preserve, setPreserve] = useState(true);
  const [src, setSrc] = useState({ endpoint: "", accessKey: "", secretKey: "" });
  const [dst, setDst] = useState({ endpoint: "http://host.docker.internal:9100", accessKey: "", secretKey: "" });
  const target = serverId || servers[0]?.id || "";
  const ready = !!name.trim() && !!target && looksLikeEndpoint(src.endpoint) && looksLikeEndpoint(dst.endpoint) && !!src.accessKey && !!src.secretKey && !!dst.accessKey && !!dst.secretKey;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onSubmit({ name: name.trim(), targetServerId: target, preserve, source: { ...src, endpoint: src.endpoint.trim() }, destination: { ...dst, endpoint: dst.endpoint.trim() } });
      }}
      style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 720 }}
    >
      <SectionCard title={t("objectMigration.new")} style={{ padding: 20, marginBottom: 0 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
          <Field label={t("objectMigration.name")} htmlFor="om-name"><TextInput id="om-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required /></Field>
          <Field label={t("objectMigration.targetServer")} hint={servers.length === 0 ? t("objectMigration.noServers") : t("objectMigration.targetServerHint")}>
            <Select value={target} onChange={setServerId} options={servers.map((s) => ({ value: s.id, label: s.name }))} />
          </Field>
        </div>
        <div style={{ marginTop: 12 }}>
          <Checkbox checked={preserve} onChange={setPreserve} label={t("objectMigration.preserve")} />
        </div>
      </SectionCard>

      <SectionCard title={t("objectMigration.source.title")} desc={t("objectMigration.source.readOnlyHint")} style={{ padding: 20, marginBottom: 0 }}>
        <Fields prefix="src" value={src} onChange={setSrc} labels={{ endpoint: t("objectMigration.source.endpoint"), accessKey: t("objectMigration.source.accessKey"), secretKey: t("objectMigration.source.secretKey") }} endpointHint={t("objectMigration.endpointHint")} credsHint={t("objectMigration.credsHint")} />
      </SectionCard>

      <SectionCard title={t("objectMigration.destination.title")} desc={t("objectMigration.destination.sameHostHint")} style={{ padding: 20, marginBottom: 0 }}>
        <Fields prefix="dst" value={dst} onChange={setDst} labels={{ endpoint: t("objectMigration.destination.endpoint"), accessKey: t("objectMigration.destination.accessKey"), secretKey: t("objectMigration.destination.secretKey") }} endpointHint={t("objectMigration.endpointHint")} credsHint={t("objectMigration.credsHint")} />
      </SectionCard>

      <div>
        <Btn type="submit" disabled={busy || !ready}>{busy ? t("objectMigration.creating") : t("objectMigration.create")}</Btn>
      </div>
    </form>
  );
}

function Fields({ prefix, value, onChange, labels, endpointHint, credsHint }: { prefix: string; value: { endpoint: string; accessKey: string; secretKey: string }; onChange: (v: { endpoint: string; accessKey: string; secretKey: string }) => void; labels: { endpoint: string; accessKey: string; secretKey: string }; endpointHint: string; credsHint: string }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
      <Field label={labels.endpoint} htmlFor={`om-${prefix}-endpoint`} hint={endpointHint} style={{ gridColumn: "1 / -1" }}>
        <TextInput id={`om-${prefix}-endpoint`} mono value={value.endpoint} onChange={(e) => onChange({ ...value, endpoint: e.target.value })} inputMode="url" autoComplete="off" spellCheck={false} required />
      </Field>
      <Field label={labels.accessKey} htmlFor={`om-${prefix}-ak`}>
        <TextInput id={`om-${prefix}-ak`} mono value={value.accessKey} onChange={(e) => onChange({ ...value, accessKey: e.target.value })} autoComplete="off" spellCheck={false} required />
      </Field>
      <Field label={labels.secretKey} htmlFor={`om-${prefix}-sk`} hint={credsHint}>
        <TextInput id={`om-${prefix}-sk`} type="password" value={value.secretKey} onChange={(e) => onChange({ ...value, secretKey: e.target.value })} autoComplete="new-password" required />
      </Field>
    </div>
  );
}
