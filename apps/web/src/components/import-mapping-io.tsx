"use client";

import { useRef, useState } from "react";
import { Download, Upload } from "lucide-react";
import { useT } from "../i18n/provider";
import { Btn } from "./ui";
import { diffDoc, mappingFileName, parseMappingFile, scopeMismatch, serializeMapping, type DocChange } from "../lib/import-mapping";
import type { ImportMappingDoc, ImportRemoteKind } from "../lib/types";

/** Download the mapping (pre-filled with the identity mapping when nothing is edited yet) and upload one back. An
 *  upload is parsed client-side and shown as a diff against the current document first; a file made for another
 *  source team/token is blocked here, and the hub's strict schema reports unknown keys when it resolves. */
export function ImportMappingIo({
  doc,
  template,
  kind,
  scopeKey,
  onLoad,
}: {
  doc: ImportMappingDoc;
  template: ImportMappingDoc;
  kind: ImportRemoteKind;
  scopeKey: string;
  onLoad: (doc: ImportMappingDoc) => void;
}) {
  const t = useT();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{ doc: ImportMappingDoc; changes: DocChange[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const scope = { sourceKind: kind, ...(scopeKey ? { scopeKey } : {}) };
  const download = () => {
    // The file is the current edits layered over the identity template, scoped to this source.
    const out: ImportMappingDoc = { ...doc, scope, items: { ...template.items, ...doc.items } };
    const url = URL.createObjectURL(new Blob([serializeMapping(out)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = mappingFileName(scopeKey || undefined, kind);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const onFile = async (file: File | undefined) => {
    setError(null);
    setPending(null);
    if (!file) return;
    const parsed = parseMappingFile(await file.text());
    if (!parsed.ok) return setError(parsed.error === "json" ? t("import.review.uploadFailedJson") : t("import.review.uploadFailedShape"));
    if (scopeMismatch(parsed.doc, kind, scopeKey)) return setError(t("import.review.uploadScopeMismatch"));
    setPending({ doc: parsed.doc, changes: diffDoc(doc, parsed.doc) });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Btn variant="ghost" icon={Download} onClick={download}>{t("import.review.download")}</Btn>
        <Btn variant="ghost" icon={Upload} onClick={() => fileRef.current?.click()}>{t("import.review.upload")}</Btn>
        <input ref={fileRef} type="file" accept="application/json,.json" aria-label={t("import.review.upload")} style={{ display: "none" }} onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ""; }} />
      </div>
      {error && <div role="alert" style={{ fontSize: 12, color: "var(--c-r)" }}>{error}</div>}
      {pending && (
        <div style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 10, fontSize: 12 }}>
          <div style={{ marginBottom: 6 }}>{t("import.review.uploadDiff", { count: pending.changes.length })}</div>
          <ul style={{ margin: "0 0 8px", paddingLeft: 16, maxHeight: 160, overflowY: "auto" }}>
            {pending.changes.slice(0, 50).map((c, i) => (
              <li key={i} className="mono" style={{ wordBreak: "break-all" }}>{c.itemRef} · {c.field}: {String(c.from ?? "")} → {String(c.to ?? "")}</li>
            ))}
          </ul>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn onClick={() => { onLoad(pending.doc); setPending(null); }}>{t("import.review.uploadLoad")}</Btn>
            <Btn variant="ghost" onClick={() => setPending(null)}>{t("import.review.uploadCancel")}</Btn>
          </div>
        </div>
      )}
    </div>
  );
}
