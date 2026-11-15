"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { useT } from "../../../i18n/provider";
import { Btn } from "../../../components/ui";
import { Modal } from "../../../components/modal";

const MIN_LEN = 12;

function b64ToBlob(b64: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: "application/octet-stream" });
}

/**
 * Owner-only: export every encrypted destination's data key as a sealed (openssl-compatible) file. The passphrase is
 * typed twice, min 12 chars, sent once and dropped; the file is saved client-side from the response.
 */
export function KeysExportModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [pass, setPass] = useState("");
  const [again, setAgain] = useState("");
  const [touched, setTouched] = useState(false);
  const [result, setResult] = useState<{ filename: string; count: number; undecryptable: string[] } | null>(null);

  const exp = useMutation({
    mutationFn: () => api.exportDestinationKeys(pass),
    onSuccess: (r) => {
      const url = URL.createObjectURL(b64ToBlob(r.contentBase64));
      const a = document.createElement("a");
      a.href = url;
      a.download = r.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setPass("");
      setAgain("");
      setResult({ filename: r.filename, count: r.destinationCount, undecryptable: r.undecryptable });
    },
  });

  const tooShort = pass.length < MIN_LEN;
  const mismatch = pass !== again;
  const submit = () => {
    setTouched(true);
    if (tooShort || mismatch) return;
    exp.mutate();
  };
  const field = { padding: "8px 10px", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx)", fontSize: 13, fontFamily: "inherit", width: "100%" } as const;

  return (
    <Modal onClose={onClose} width={480} ariaLabel={t("settings.keysExport_title")}>
      <form onSubmit={(e) => { e.preventDefault(); submit(); }} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontWeight: 700 }}>{t("settings.keysExport_title")}</div>
        <div style={{ fontSize: 12, color: "var(--c-am)", lineHeight: 1.5 }}>{t("settings.keysExport_warning")}</div>
        {result ? (
          <>
            <div role="status" style={{ fontSize: 13 }}>{t("settings.keysExport_done", { name: result.filename, count: result.count })}</div>
            {result.undecryptable.length > 0 && (
              <div role="alert" style={{ fontSize: 12, color: "var(--c-r)" }}>
                {t("settings.keysExport_undecryptable", { count: result.undecryptable.length, ids: result.undecryptable.join(", ") })}
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end" }}><Btn onClick={onClose}>{t("settings.keysExport_close")}</Btn></div>
          </>
        ) : (
          <>
            <label style={{ fontSize: 12, color: "var(--c-tx3)", display: "flex", flexDirection: "column", gap: 4 }}>
              {t("settings.keysExport_passphrase")}
              <input style={field} type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} />
            </label>
            <label style={{ fontSize: 12, color: "var(--c-tx3)", display: "flex", flexDirection: "column", gap: 4 }}>
              {t("settings.keysExport_confirm")}
              <input style={field} type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
            </label>
            {touched && tooShort && <div role="alert" style={{ fontSize: 12, color: "var(--c-r)" }}>{t("settings.keysExport_minLength")}</div>}
            {touched && !tooShort && mismatch && <div role="alert" style={{ fontSize: 12, color: "var(--c-r)" }}>{t("settings.keysExport_mismatch")}</div>}
            {exp.isError && <div role="alert" style={{ fontSize: 12, color: "var(--c-r)" }}>{(exp.error as Error).message || t("settings.keysExport_failed")}</div>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
              <Btn variant="ghost" onClick={onClose}>{t("common.cancel")}</Btn>
              <Btn type="submit" disabled={exp.isPending}>{t("settings.keysExport_download")}</Btn>
            </div>
          </>
        )}
      </form>
    </Modal>
  );
}
