"use client";

import { useT } from "../i18n/provider";
import { useToast } from "./toast";
import { Btn } from "./ui";

/** Copy-to-clipboard button with visible feedback (toast). */
export function CopyBtn({ text, label }: { text: string; label?: string }) {
  const t = useT();
  const toast = useToast();
  const text_ = label ?? t("common.copy");
  return (
    <Btn
      variant="ghost"
      aria-label={text_}
      onClick={() => {
        navigator.clipboard?.writeText(text);
        toast(t("common.copied"), "success");
      }}
    >
      {text_}
    </Btn>
  );
}

/** Labeled, copyable value row (was forked between apps and databases detail). */
export function CopyRow({ label, value, copy, secret }: { label: string; value: string; copy?: string; secret?: boolean }) {
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
        {secret ? "•".repeat(Math.min(value.length, 40)) : value}
      </code>
      <CopyBtn text={value} label={copy} />
    </div>
  );
}
