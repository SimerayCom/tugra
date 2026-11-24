"use client";

import { useRef, useState } from "react";
import { FileKey, X } from "lucide-react";
import { useT } from "../../i18n/provider";
import { Btn } from "../ui";
import { fieldStyle } from "../form";
import { looksLikePrivateKey } from "../../lib/github-manifest";

/** Drop (or choose) the App's .pem private key; the text is read in the browser and handed up, never shown. A paste
 *  box is available behind a link for people who copied the key instead. Max 64 KiB: a PEM key is about 2 KiB. */
export function PemDrop({ value, onChange, id }: { value: string; onChange: (pem: string) => void; id: string }) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState(false);
  const [over, setOver] = useState(false);
  const [paste, setPaste] = useState(false);

  async function take(file: File | undefined) {
    if (!file) return;
    const text = file.size <= 65536 ? await file.text() : "";
    if (!looksLikePrivateKey(text)) {
      setError(true);
      return;
    }
    setError(false);
    setName(file.name);
    onChange(text);
  }
  const clear = () => { setName(""); setError(false); onChange(""); if (input.current) input.current.value = ""; };

  if (value && !paste) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, ...fieldStyle }}>
        <FileKey size={16} aria-hidden color="var(--c-g)" />
        <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere", fontSize: 13 }}>{name ? t("sources.pemLoaded", { name }) : t("sources.pemLoadedPasted")}</span>
        <button type="button" aria-label={t("sources.pemRemove")} onClick={clear} className="tg-iconbtn" style={{ background: "transparent", border: "none", color: "var(--c-tx3)", cursor: "pointer", display: "inline-flex" }}>
          <X size={16} aria-hidden />
        </button>
      </div>
    );
  }
  return (
    <div>
      {paste ? (
        <textarea
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t("sources.pemPastePlaceholder")}
          aria-label={t("sources.privateKey")}
          style={{ ...fieldStyle, minHeight: 120, fontFamily: "var(--font-mono, monospace)", fontSize: 12, resize: "vertical" }}
        />
      ) : (
        <div
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); void take(e.dataTransfer.files?.[0]); }}
          style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: 16, textAlign: "center", borderRadius: "var(--r1)", border: `1px dashed ${over ? "var(--c-a)" : "var(--c-bd)"}`, background: over ? "var(--c-ad)" : "var(--c-el)", color: "var(--c-tx2)", fontSize: 13 }}
        >
          <FileKey size={20} aria-hidden color="var(--c-tx3)" />
          <span>{t("sources.pemDrop")}</span>
          <Btn variant="ghost" onClick={() => input.current?.click()}>{t("sources.pemChoose")}</Btn>
          <input
            ref={input}
            id={id}
            type="file"
            accept=".pem,.key,text/plain"
            aria-label={t("sources.privateKey")}
            onChange={(e) => void take(e.target.files?.[0])}
            style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
            tabIndex={-1}
          />
        </div>
      )}
      {error && <div role="alert" style={{ color: "var(--c-r)", fontSize: 12, marginTop: 6 }}>{t("sources.pemInvalid")}</div>}
      {!paste && (
        <button type="button" onClick={() => setPaste(true)} style={{ background: "none", border: "none", padding: "10px 0 0", color: "var(--c-tx3)", fontSize: 12, textDecoration: "underline", cursor: "pointer", minHeight: 32 }}>
          {t("sources.pemPaste")}
        </button>
      )}
    </div>
  );
}
