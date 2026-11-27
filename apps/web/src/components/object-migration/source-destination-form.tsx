"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { Btn, SectionCard } from "../ui";
import { Checkbox, Field, Select, TextInput } from "../form";
import { BlockedNote } from "../cta-parts";
import { blockTag, serverBlock } from "../../lib/cta-readiness";
import { takeObjectMigrationContext, type ObjectMigrationContext } from "../../lib/object-migration-context";
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
  // Where the user came from (an import's service, a run's attach step): the server it lands on and a way back. Read once.
  const [ctx, setCtx] = useState<ObjectMigrationContext | null>(null);
  useEffect(() => {
    const c = takeObjectMigrationContext();
    if (!c) return;
    setCtx(c);
    if (c.targetServerId) setServerId((cur) => cur || (c.targetServerId as string));
    if (c.serviceName) setName((cur) => cur || c.serviceName as string);
  }, []);
  const [preserve, setPreserve] = useState(true);
  const [src, setSrc] = useState({ endpoint: "", accessKey: "", secretKey: "" });
  // The destination starts empty: nothing says a MinIO already runs on the target.
  const [dst, setDst] = useState({ endpoint: "", accessKey: "", secretKey: "" });
  // Never the first server by default: the copy runs on the one that was chosen, or the one the import puts the service on.
  const target = serverId;
  // Only servers of the import's team when it is known, else every server you can write to; one that cannot run the copy is listed off.
  const teamId = servers.find((s) => s.id === ctx?.targetServerId)?.teamId;
  const choices = servers.filter((s) => s.canWrite && (!teamId || s.teamId === teamId));
  const chosen = servers.find((s) => s.id === target);
  // The copy runs on the target's agent with the backup capability.
  const block = chosen ? serverBlock(chosen, ["backup"]) : null;
  const ready = !block && !!name.trim() && !!target && looksLikeEndpoint(src.endpoint) && looksLikeEndpoint(dst.endpoint) && !!src.accessKey && !!src.secretKey && !!dst.accessKey && !!dst.secretKey;
  return (
    <>
    {ctx?.serviceName && <p role="note" style={{ margin: "0 0 12px", fontSize: 12, color: "var(--c-tx2)", maxWidth: 720 }}>{t("objectMigration.fromImport", { service: ctx.serviceName })}{ctx.backHref && <> <Link href={ctx.backHref} style={{ color: "var(--c-lapis)" }}>{t("objectMigration.backToImport")}</Link></>}</p>}
    {!ctx?.serviceName && ctx?.backHref && <p style={{ margin: "0 0 12px", fontSize: 12, maxWidth: 720 }}><Link href={ctx.backHref} style={{ color: "var(--c-lapis)" }}>{t("objectMigration.backToImport")}</Link></p>}
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
          <Field label={t("objectMigration.targetServer")} hint={choices.length === 0 ? t("objectMigration.noServers") : t("objectMigration.targetServerHint")}>
            <Select
              value={target}
              onChange={setServerId}
              placeholder={t("objectMigration.pickServer")}
              options={choices.map((s) => {
                const b = serverBlock(s, ["backup"]);
                return { value: s.id, label: b ? `${s.name} (${blockTag(t, b)})` : s.name, disabled: !!b };
              })}
            />
          </Field>
        </div>
        {block && <BlockedNote block={block} serverId={target} style={{ display: "block", marginTop: 8 }} />}
        {choices.length === 0 && <p style={{ margin: "8px 0 0", fontSize: 12 }}><Link href="/servers/new" style={{ color: "var(--c-lapis)" }}>{t("servers.cta.addServer")}</Link></p>}
        <ul data-testid="om-needs" style={{ margin: "12px 0 0", paddingLeft: 18, fontSize: 12, color: "var(--c-tx2)", display: "grid", gap: 2 }}>
          <li>{t("objectMigration.needs.agent")}</li>
          <li>{t("objectMigration.needs.destination")}</li>
          <li>{t("objectMigration.needs.keys")}</li>
        </ul>
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
        <Btn type="submit" disabled={!ready} loading={busy}>{busy ? t("objectMigration.creating") : t("objectMigration.create")}</Btn>
      </div>
    </form>
    </>
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
