"use client";

import { useEffect, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useT } from "../i18n/provider";
import { useToast } from "./toast";
import { copyText } from "../lib/clipboard";
import { Btn } from "./ui";

/** Copy-to-clipboard button with visible feedback (toast). Reports the TRUE result — on an insecure
 *  http origin (the bare-IP quick-start) the async Clipboard API is unavailable, so it falls back and
 *  only toasts success when the copy actually happened. */
export function CopyBtn({ text, label }: { text: string; label?: string }) {
  const t = useT();
  const toast = useToast();
  const text_ = label ?? t("common.copy");
  return (
    <Btn
      variant="ghost"
      aria-label={text_}
      onClick={async () => {
        const ok = await copyText(text);
        toast(ok ? t("common.copied") : t("common.copyFailed"), ok ? "success" : "error");
      }}
    >
      {text_}
    </Btn>
  );
}

/** Labeled, copyable value row (was forked between apps and databases detail). */
export function CopyRow({ label, value, copy, secret }: { label: string; value: string; copy?: string; secret?: boolean }) {
  const t = useT();
  const [shown, setShown] = useState(false);
  // Auto-re-mask after 30s and whenever the tab is hidden.
  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => setShown(false), 30_000);
    const onVis = () => { if (document.visibilityState === "hidden") setShown(false); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", onVis); };
  }, [shown]);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontSize: 11, color: "var(--c-tx3)", width: 110, flexShrink: 0 }}>{label}</span>
      <code
        className="mono"
        style={{
          flex: 1,
          fontSize: 12,
          background: "var(--c-el)",
          border: "1px solid var(--c-bd)",
          borderRadius: "var(--r1)",
          padding: "6px 10px",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {secret && !shown ? "•".repeat(Math.min(value.length, 40)) : value}
      </code>
      {secret && (
        <Btn
          variant="ghost"
          aria-label={shown ? t("common.hide") : t("common.reveal")}
          aria-pressed={shown}
          onClick={() => setShown((s) => !s)}
        >
          {shown ? <EyeOff size={14} /> : <Eye size={14} />}
        </Btn>
      )}
      <CopyBtn text={value} label={copy} />
    </div>
  );
}
