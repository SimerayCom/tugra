"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { Btn, SectionCard, Spinner } from "../ui";
import { Field, Select, TextInput } from "../form";
import { hintsClosed, validAppItemRef, validDigest, validImageRef, validPinScope } from "../../lib/migration-run";
import type { MigrationRunSafetyHints, MigrationRunView } from "../../lib/types";
import { runHintsKey as hintsKey, useRunPlumbing } from "./use-run-actions";

function useHints(runId: string, enabled: boolean) {
  return useQuery<MigrationRunSafetyHints>({ queryKey: hintsKey(runId), queryFn: () => api.getMigrationRunSafetyHints(runId), enabled, staleTime: 15_000 });
}

/** The facts only someone with eyes on the source host can give (R11 image digests, R26 job runners), recorded as
 *  attested by the operator. The hub cannot check either, so the card says so; it takes them only while the run can
 *  still use them (before the point of no return). The list loads when the card is opened. */
export function SafetyCard({ run }: { run: MigrationRunView }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const closed = hintsClosed(run);
  const q = useHints(run.id, open);
  return (
    <SectionCard title={t("migrationRun.safety.title")} desc={t("migrationRun.safety.desc")} style={{ marginBottom: 0 }}>
      <details onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600, minHeight: 28 }}>{t("migrationRun.safety.open")}</summary>
        <div style={{ display: "flex", flexDirection: "column", gap: 18, marginTop: 12 }}>
          {closed && <div role="note" style={{ fontSize: 12, color: "var(--c-am)", lineHeight: 1.5 }}>{t("migrationRun.safety.closed")}</div>}
          {open && q.isLoading && <Spinner />}
          {open && q.isError && <div role="alert" style={{ fontSize: 13, color: "var(--c-r)" }}>{t("migrationRun.errors.generic")}</div>}
          {q.data && (
            <>
              <MarksSection runId={run.id} hints={q.data} closed={closed} />
              <PinsSection runId={run.id} hints={q.data} closed={closed} />
            </>
          )}
        </div>
      </details>
    </SectionCard>
  );
}

const heading: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.05em" };
const hint: React.CSSProperties = { margin: "4px 0 0", fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 };

function useSave(runId: string) {
  const qc = useQueryClient();
  const { onError, toast, t } = useRunPlumbing(runId);
  const ok = (next: MigrationRunSafetyHints) => {
    qc.setQueryData(hintsKey(runId), next);
    // the preflight and deploy checks read these facts: refresh the run so a cleared gate shows up at once
    void qc.invalidateQueries({ queryKey: ["migration-run", runId] });
    toast(t("migrationRun.safety.saved"), "success");
  };
  return { ok, onError };
}

function MarksSection({ runId, hints, closed }: { runId: string; hints: MigrationRunSafetyHints; closed: boolean }) {
  const t = useT();
  const { ok, onError } = useSave(runId);
  const [item, setItem] = useState("");
  const [role, setRole] = useState<"job-runner" | "web">("job-runner");
  const itemBad = item.trim() !== "" && !validAppItemRef(item.trim());
  const save = useMutation({ mutationFn: (m: { itemRef: string; role: "job-runner" | "web" | null }) => api.setMigrationRunWorkerMarks(runId, { marks: [m] }), onSuccess: (v) => { ok(v); setItem(""); }, onError });
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div>
        <div style={heading}>{t("migrationRun.safety.marksTitle")}</div>
        <p style={hint}>{t("migrationRun.safety.marksHint")}</p>
      </div>
      {hints.workerMarks.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--c-tx3)" }}>{t("migrationRun.safety.marksEmpty")}</div>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 6 }}>
          {hints.workerMarks.map((m) => (
            <li key={m.itemRef} style={{ display: "flex", gap: "4px 10px", flexWrap: "wrap", alignItems: "center", fontSize: 13, minWidth: 0 }}>
              <span className="mono" style={{ flex: "1 1 200px", minWidth: 0, wordBreak: "break-all" }}>{m.itemRef}</span>
              <span style={{ fontSize: 12, color: "var(--c-tx2)" }}>{t(m.role === "job-runner" ? "migrationRun.safety.roleJobRunner" : "migrationRun.safety.roleWeb")}</span>
              <Btn variant="ghost" disabled={closed} loading={save.isPending} aria-label={t("migrationRun.safety.markRemove", { item: m.itemRef })} onClick={() => save.mutate({ itemRef: m.itemRef, role: null })}>{t("common.remove")}</Btn>
            </li>
          ))}
        </ul>
      )}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <Field label={t("migrationRun.safety.item")} error={itemBad ? t("migrationRun.safety.itemInvalid") : undefined} style={{ flex: "2 1 240px" }}>
          <TextInput value={item} onChange={(e) => setItem(e.target.value)} mono maxLength={340} autoComplete="off" spellCheck={false} disabled={closed} style={{ minHeight: 44 }} />
        </Field>
        <Field label={t("migrationRun.safety.role")} style={{ flex: "1 1 200px" }}>
          <Select
            value={role}
            onChange={(v) => setRole(v as "job-runner" | "web")}
            options={[
              { value: "job-runner", label: t("migrationRun.safety.roleJobRunner") },
              { value: "web", label: t("migrationRun.safety.roleWeb") },
            ]}
            disabled={closed}
            style={{ minHeight: 44 }}
          />
        </Field>
        <Btn variant="ghost" disabled={closed || !validAppItemRef(item.trim())} loading={save.isPending} onClick={() => save.mutate({ itemRef: item.trim(), role })}>{t("migrationRun.safety.markAdd")}</Btn>
      </div>
    </section>
  );
}

function PinsSection({ runId, hints, closed }: { runId: string; hints: MigrationRunSafetyHints; closed: boolean }) {
  const t = useT();
  const { ok, onError } = useSave(runId);
  const [image, setImage] = useState("");
  const [scope, setScope] = useState("");
  const [digest, setDigest] = useState("");
  const [evidence, setEvidence] = useState<"operator-attested" | "host-loop-reported">("operator-attested");
  const imageBad = image.trim() !== "" && !validImageRef(image.trim());
  const digestBad = digest.trim() !== "" && !validDigest(digest);
  const scopeBad = !validPinScope(scope.trim());
  const save = useMutation({
    mutationFn: (p: { image: string; scope: string; digest: string | null; evidence?: "operator-attested" | "host-loop-reported" }) => api.setMigrationRunImagePins(runId, { pins: [p] }),
    onSuccess: (v) => {
      ok(v);
      setDigest("");
    },
    onError,
  });
  const ready = validImageRef(image.trim()) && validDigest(digest) && !scopeBad;
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div>
        <div style={heading}>{t("migrationRun.safety.pinsTitle")}</div>
        <p style={hint}>{t("migrationRun.safety.pinsHint")}</p>
      </div>
      {hints.imagePins.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--c-tx3)" }}>{t("migrationRun.safety.pinsEmpty")}</div>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 6 }}>
          {hints.imagePins.map((p) => (
            <li key={`${p.image}|${p.scope}`} style={{ display: "flex", gap: "4px 10px", flexWrap: "wrap", alignItems: "center", fontSize: 13, minWidth: 0 }}>
              <span className="mono" style={{ flex: "1 1 200px", minWidth: 0, wordBreak: "break-all" }}>{p.image}{p.scope ? ` @ ${p.scope}` : ""}</span>
              <span className="mono" style={{ fontSize: 11, color: "var(--c-tx3)", wordBreak: "break-all" }}>{p.digest.slice(0, 19)}</span>
              <Btn variant="ghost" disabled={closed} loading={save.isPending} aria-label={t("migrationRun.safety.pinRemove", { image: p.image })} onClick={() => save.mutate({ image: p.image, scope: p.scope, digest: null })}>{t("common.remove")}</Btn>
            </li>
          ))}
        </ul>
      )}
      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))" }}>
        <Field label={t("migrationRun.safety.image")} error={imageBad ? t("migrationRun.safety.imageInvalid") : undefined}>
          <TextInput value={image} onChange={(e) => setImage(e.target.value)} mono maxLength={300} autoComplete="off" spellCheck={false} disabled={closed} style={{ minHeight: 44 }} />
        </Field>
        <Field label={t("migrationRun.safety.scope")} hint={t("migrationRun.safety.scopeHint")}>
          <TextInput value={scope} onChange={(e) => setScope(e.target.value)} mono maxLength={200} autoComplete="off" spellCheck={false} disabled={closed} style={{ minHeight: 44 }} />
        </Field>
        <Field label={t("migrationRun.safety.digest")} error={digestBad ? t("migrationRun.safety.digestInvalid") : undefined}>
          <TextInput value={digest} onChange={(e) => setDigest(e.target.value)} mono maxLength={71} autoComplete="off" spellCheck={false} disabled={closed} style={{ minHeight: 44 }} />
        </Field>
        <Field label={t("migrationRun.safety.evidence")}>
          <Select
            value={evidence}
            onChange={(v) => setEvidence(v as "operator-attested" | "host-loop-reported")}
            options={[
              { value: "operator-attested", label: t("migrationRun.safety.evidenceOperator") },
              { value: "host-loop-reported", label: t("migrationRun.safety.evidenceHostLoop") },
            ]}
            disabled={closed}
            style={{ minHeight: 44 }}
          />
        </Field>
      </div>
      <div>
        <Btn variant="ghost" disabled={closed || !ready} loading={save.isPending} onClick={() => save.mutate({ image: image.trim(), scope: scope.trim(), digest: digest.trim(), evidence })}>{t("migrationRun.safety.pinAdd")}</Btn>
      </div>
    </section>
  );
}
