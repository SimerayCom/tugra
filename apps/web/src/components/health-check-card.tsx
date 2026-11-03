"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import { ConfigCard, Field, NumberInput, TextInput, fieldStyle, useSaveFeedback } from "./form";

/**
 * Container health check (auto / none / HTTP / CMD) and its timings. The HTTP path/port and the
 * command were placeholder-only (no accessible name); every field is now a labelled Field, and
 * Save is gated until something changes.
 */
const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

export function HealthCheckCard({ id, healthCheckType, healthCheckPath, healthCheckPort, healthCheckMethod, healthCheckScheme, healthCheckResponseText, healthCmd, timings }: {
  id: string;
  healthCheckType: string | null;
  healthCheckPath: string | null;
  healthCheckPort: number | null;
  healthCheckMethod: string | null;
  healthCheckScheme: string | null;
  healthCheckResponseText: string | null;
  healthCmd: string | null;
  timings: { interval: number | null; timeout: number | null; retries: number | null; startPeriod: number | null; expectedStatus: number | null };
}) {
  const t = useT();
  const qc = useQueryClient();
  const feedback = useSaveFeedback("apps.saved");
  const num = (n: number | null) => (n != null ? String(n) : "");
  // "" = auto (send null). A legacy app with a command but no saved type shows as CMD so its
  // command stays visible/editable instead of being hidden.
  const initType = healthCheckType ?? (healthCmd ? "CMD" : "");
  const [type, setType] = useState(initType);
  const [path, setPath] = useState(healthCheckPath ?? "");
  const [port, setPort] = useState(num(healthCheckPort));
  // "" = default (GET / http). Stored values are a fixed allow-list, so the raw string round-trips.
  const [method, setMethod] = useState(healthCheckMethod ?? "");
  const [scheme, setScheme] = useState(healthCheckScheme ?? "");
  const [responseText, setResponseText] = useState(healthCheckResponseText ?? "");
  const [cmd, setCmd] = useState(healthCmd ?? "");
  const [interval, setInterval] = useState(num(timings.interval));
  const [timeout, setTimeout] = useState(num(timings.timeout));
  const [retries, setRetries] = useState(num(timings.retries));
  const [startPeriod, setStartPeriod] = useState(num(timings.startPeriod));
  const [expectedStatus, setExpectedStatus] = useState(num(timings.expectedStatus));
  const toNum = (s: string) => (s.trim() ? Number(s) : null); // empty → reset to default

  const dirty =
    type !== initType ||
    path.trim() !== (healthCheckPath ?? "") ||
    port !== num(healthCheckPort) ||
    method !== (healthCheckMethod ?? "") ||
    scheme !== (healthCheckScheme ?? "") ||
    responseText.trim() !== (healthCheckResponseText ?? "") ||
    cmd.trim() !== (healthCmd ?? "") ||
    interval !== num(timings.interval) ||
    timeout !== num(timings.timeout) ||
    retries !== num(timings.retries) ||
    startPeriod !== num(timings.startPeriod) ||
    expectedStatus !== num(timings.expectedStatus);

  const save = useMutation({
    mutationFn: () =>
      api.setAppHealthCheck(id, {
        type: type || null,
        path: type === "HTTP" ? path.trim() || null : null,
        port: type === "HTTP" && port ? Number(port) : null,
        method: type === "HTTP" ? method || null : null,
        scheme: type === "HTTP" ? scheme || null : null,
        responseText: type === "HTTP" ? responseText.trim() || null : null,
        command: type === "CMD" ? cmd.trim() || null : null,
        interval: toNum(interval),
        timeout: toNum(timeout),
        retries: toNum(retries),
        startPeriod: toNum(startPeriod),
        expectedStatus: type === "HTTP" ? toNum(expectedStatus) : null,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", id] }),
    ...feedback,
  });

  const item = { flex: "1 1 150px", minWidth: 0 } as const;

  return (
    <ConfigCard title={t("apps.healthCheck")} desc={t("apps.healthCheckDesc")} dirty={dirty} saving={save.isPending} onSave={() => save.mutate()}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
        <Field label={t("apps.healthCheckType")} style={{ flex: "1 1 200px", minWidth: 0 }}>
          <select style={fieldStyle} value={type} onChange={(e) => setType(e.target.value)}>
            {["", "NONE", "HTTP", "CMD"].map((v) => (
              <option key={v || "auto"} value={v}>{t(`apps.healthCheckType_${v || "auto"}`)}</option>
            ))}
          </select>
        </Field>
        {type === "HTTP" && (
          <>
            <Field label={t("apps.healthCheckScheme")} style={item}>
              <select style={fieldStyle} value={scheme} onChange={(e) => setScheme(e.target.value)}>
                {["", "http", "https"].map((v) => (
                  <option key={v || "default"} value={v}>{t(`apps.healthCheckScheme_${v || "default"}`)}</option>
                ))}
              </select>
            </Field>
            <Field label={t("apps.healthCheckMethod")} style={item}>
              <select style={fieldStyle} value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="">{t("apps.healthCheckMethod_default")}</option>
                {HTTP_METHODS.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            </Field>
            <Field label={t("apps.healthCheckPath")} style={{ flex: "2 1 200px", minWidth: 0 }}>
              <TextInput value={path} onChange={(e) => setPath(e.target.value)} spellCheck={false} autoComplete="off" />
            </Field>
            <Field label={t("apps.healthCheckPort")} style={item}>
              <NumberInput min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} />
            </Field>
            <Field label={t("apps.healthCheckResponseText")} hint={t("apps.healthCheckResponseTextHint")} style={{ flex: "1 1 100%", minWidth: 0 }}>
              <TextInput value={responseText} onChange={(e) => setResponseText(e.target.value)} spellCheck={false} autoComplete="off" placeholder={t("apps.healthCheckResponseTextPlaceholder")} />
            </Field>
          </>
        )}
        {type === "CMD" && (
          <Field label={t("apps.healthCmd")} style={{ flex: "1 1 100%", minWidth: 0 }}>
            <TextInput mono value={cmd} onChange={(e) => setCmd(e.target.value)} spellCheck={false} autoComplete="off" />
          </Field>
        )}
      </div>
      {type !== "NONE" && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>{t("apps.healthTimings")}</div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <Field label={t("apps.healthInterval")} style={item}><NumberInput min={0} value={interval} onChange={(e) => setInterval(e.target.value)} /></Field>
            <Field label={t("apps.healthTimeout")} style={item}><NumberInput min={0} value={timeout} onChange={(e) => setTimeout(e.target.value)} /></Field>
            <Field label={t("apps.healthRetries")} style={item}><NumberInput min={0} value={retries} onChange={(e) => setRetries(e.target.value)} /></Field>
            <Field label={t("apps.healthStartPeriod")} style={item}><NumberInput min={0} value={startPeriod} onChange={(e) => setStartPeriod(e.target.value)} /></Field>
            {type === "HTTP" && <Field label={t("apps.healthExpectedStatus")} style={item}><NumberInput min={100} max={599} value={expectedStatus} onChange={(e) => setExpectedStatus(e.target.value)} /></Field>}
          </div>
          <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "8px 0 0" }}>{t("apps.healthTimingsHint")}</p>
        </div>
      )}
    </ConfigCard>
  );
}
