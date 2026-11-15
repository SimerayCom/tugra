"use client";

import { useId, useState } from "react";
import { useT } from "../../i18n/provider";
import { Checkbox, Field, Select, TextInput, Textarea } from "../form";
import { IconBtn } from "../icon-btn";
import { Btn } from "../ui";
import type { LogDrainType } from "../../lib/types";
import {
  ALL_TYPES,
  isNetType,
  isValidContainerEntry,
  TYPE_PROTOS,
  withType,
  type DrainDraft,
  type DrainScopeKind,
  type Proto,
} from "./drain-model";

/** Where the card lives: a server (globs over container names) or one app (compose services, only for a
 *  non-clustered compose app). */
export type DrainScope = { kind: "server"; id: string } | { kind: "app"; id: string; isCompose: boolean; clustered: boolean };

export function scopeKind(scope: DrainScope): DrainScopeKind {
  return scope.kind;
}

/** Is the container filter meaningful here? (App scope: only compose apps that are not swarm-clustered.) */
export function containerFilterApplies(scope: DrainScope): boolean {
  return scope.kind === "server" || (scope.isCompose && !scope.clustered);
}

function ContainerChips({ scope, value, onChange }: { scope: DrainScope; value: string[]; onChange: (v: string[]) => void }) {
  const t = useT();
  const [entry, setEntry] = useState("");
  const [bad, setBad] = useState(false);
  const inputId = useId();
  const add = () => {
    const e = entry.trim();
    if (!e) return;
    if (!isValidContainerEntry(e, scope.kind)) {
      setBad(true);
      return;
    }
    setBad(false);
    if (!value.includes(e)) onChange([...value, e]);
    setEntry("");
  };
  return (
    <Field
      htmlFor={inputId}
      label={t("logdrains.containers")}
      hint={scope.kind === "app" ? t("logdrains.containersHelpApp") : t("logdrains.containersHelpServer")}
      error={bad ? t(scope.kind === "app" ? "logdrains.validation_container_app" : "logdrains.validation_container_server") : undefined}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", gap: 6 }}>
          <TextInput
            id={inputId}
            mono
            value={entry}
            onChange={(e) => setEntry(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
          />
          <Btn variant="ghost" onClick={add} disabled={!entry.trim()}>{t("logdrains.containerAdd")}</Btn>
        </div>
        {value.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {value.map((c) => (
              <span key={c} className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, padding: "2px 4px 2px 8px", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx2)" }}>
                {c}
                <IconBtn label={t("logdrains.containerRemove", { name: c })} onClick={() => onChange(value.filter((x) => x !== c))}>×</IconBtn>
              </span>
            ))}
          </div>
        )}
      </div>
    </Field>
  );
}

/**
 * The type-conditional drain form. http/loki/datadog: URL + bearer. syslog: protocol, host, port, facility,
 * framing, app name (+ CA / server name for TLS). gelf: protocol, host, port, compression (UDP only). fluentd:
 * protocol, host, port, tag, acknowledgement, optional shared key. Container filter per scope; an app-scope
 * "allow private" flag. Every string goes through t().
 */
export function DrainForm({
  scope,
  draft,
  onChange,
  hasToken = false,
  mode,
}: {
  scope: DrainScope;
  draft: DrainDraft;
  onChange: (d: DrainDraft) => void;
  hasToken?: boolean;
  mode: "create" | "edit";
}) {
  const t = useT();
  const set = <K extends keyof DrainDraft>(k: K, v: DrainDraft[K]) => onChange({ ...draft, [k]: v });
  const net = isNetType(draft.type);
  const protos: readonly Proto[] = net ? TYPE_PROTOS[draft.type as "syslog" | "gelf" | "fluentd"] : [];
  const sharedKey = draft.type === "fluentd";
  const uid = `${mode}-${scope.kind}-${scope.id}`;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, alignItems: "start" }}>
      <Field label={t("logdrains.name")}><TextInput value={draft.name} onChange={(e) => set("name", e.target.value)} /></Field>
      <Field label={t("logdrains.type")}>
        <Select
          ariaLabel={t("logdrains.type")}
          value={draft.type}
          onChange={(v) => onChange(withType(draft, v as LogDrainType))}
          options={ALL_TYPES.map((o) => ({ value: o, label: t(`logdrains.type_${o}`) }))}
        />
      </Field>

      {!net && (
        <>
          <Field label={t("logdrains.endpoint")} style={{ gridColumn: "1 / -1" }}>
            <TextInput mono value={draft.endpoint} onChange={(e) => set("endpoint", e.target.value)} />
          </Field>
          <Field label={t("logdrains.token")}>
            <TextInput type="password" autoComplete="off" placeholder={hasToken ? t("logdrains.tokenKeep") : undefined} value={draft.token} onChange={(e) => set("token", e.target.value)} />
          </Field>
        </>
      )}

      {net && (
        <>
          <Field label={t("logdrains.proto")}>
            <Select
              ariaLabel={t("logdrains.proto")}
              value={draft.proto}
              onChange={(v) => set("proto", v as Proto)}
              options={protos.map((p) => ({ value: p, label: t(`logdrains.proto_${p}`) }))}
            />
          </Field>
          <Field label={t("logdrains.endpointHostPort")}><TextInput mono value={draft.host} onChange={(e) => set("host", e.target.value)} /></Field>
          <Field label={t("logdrains.port")}><TextInput mono inputMode="numeric" value={draft.port} onChange={(e) => set("port", e.target.value)} /></Field>
        </>
      )}

      {draft.type === "syslog" && (
        <>
          <Field label={t("logdrains.facility")}><TextInput inputMode="numeric" value={draft.facility} onChange={(e) => set("facility", e.target.value)} /></Field>
          {draft.proto !== "udp" && (
            <Field label={t("logdrains.framing")}>
              <Select
                ariaLabel={t("logdrains.framing")}
                value={draft.framing || (draft.proto === "tls" ? "octet" : "newline")}
                onChange={(v) => set("framing", v as DrainDraft["framing"])}
                options={[
                  { value: "octet", label: t("logdrains.framing_octet") },
                  { value: "newline", label: t("logdrains.framing_newline") },
                ]}
              />
            </Field>
          )}
          <Field label={t("logdrains.appName")}><TextInput mono value={draft.appName} onChange={(e) => set("appName", e.target.value)} /></Field>
        </>
      )}

      {draft.type === "gelf" && draft.proto === "udp" && (
        <Field label={t("logdrains.compress")}>
          <Select
            ariaLabel={t("logdrains.compress")}
            value={draft.compress}
            onChange={(v) => set("compress", v as DrainDraft["compress"])}
            options={(["none", "gzip", "zlib"] as const).map((c) => ({ value: c, label: t(`logdrains.compress_${c}`) }))}
          />
        </Field>
      )}

      {draft.type === "fluentd" && (
        <>
          <Field label={t("logdrains.tag")}><TextInput mono value={draft.tag} onChange={(e) => set("tag", e.target.value)} /></Field>
          <Field label={t("logdrains.sharedKey")}>
            <TextInput type="password" autoComplete="off" placeholder={hasToken && sharedKey ? t("logdrains.sharedKeyKeep") : undefined} value={draft.token} onChange={(e) => set("token", e.target.value)} />
          </Field>
          <div style={{ alignSelf: "end", paddingBottom: 8 }}>
            <Checkbox checked={draft.requireAck} onChange={(v) => set("requireAck", v)} label={t("logdrains.requireAck")} id={`ack-${uid}`} />
          </div>
        </>
      )}

      {net && draft.proto === "tls" && (
        <>
          <Field label={t("logdrains.serverName")}><TextInput mono value={draft.serverName} onChange={(e) => set("serverName", e.target.value)} /></Field>
          <Field label={t("logdrains.caCert")} hint={t("logdrains.caCertHelp")} style={{ gridColumn: "1 / -1" }}>
            <Textarea mono rows={3} value={draft.caCert} onChange={(e) => set("caCert", e.target.value)} />
          </Field>
        </>
      )}

      {net && draft.proto === "udp" && (
        <div role="note" style={{ gridColumn: "1 / -1", fontSize: 12, color: "var(--c-am)" }}>{t("logdrains.udpWarn")}</div>
      )}

      <div style={{ gridColumn: "1 / -1" }}>
        {containerFilterApplies(scope) ? (
          <ContainerChips scope={scope} value={draft.containers} onChange={(v) => set("containers", v)} />
        ) : (
          <div role="note" style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("logdrains.containersNotApplicable")}</div>
        )}
      </div>

      {scope.kind === "app" && (
        <div style={{ gridColumn: "1 / -1", display: "flex", flexDirection: "column", gap: 4 }}>
          <Checkbox checked={draft.allowPrivate} onChange={(v) => set("allowPrivate", v)} label={t("logdrains.allowPrivate")} id={`priv-${uid}`} />
          <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{t("logdrains.allowPrivateHelp")}</span>
        </div>
      )}
    </div>
  );
}
