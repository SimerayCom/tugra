"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useT } from "../i18n/provider";

export interface CommandDest {
  labelKey: string;
  href: string;
}

export function CommandPalette({
  dests,
  onClose,
}: {
  dests: CommandDest[];
  onClose: () => void;
}) {
  const router = useRouter();
  const t = useT();
  const [q, setQ] = useState("");
  const items = dests.map((d) => ({ ...d, label: t(d.labelKey) }));
  const filtered = items.filter((d) =>
    d.label.toLowerCase().includes(q.toLowerCase()),
  );
  const go = (href: string) => {
    onClose();
    router.push(href);
  };
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9000,
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(3px)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "12vh",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 520, maxWidth: "90vw", background: "var(--c-sb)", border: "1px solid var(--c-bd)", borderRadius: "var(--r2)", overflow: "hidden", boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}
      >
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && filtered[0]) go(filtered[0].href);
          }}
          placeholder={t("nav.search")}
          style={{ width: "100%", padding: "14px 16px", background: "transparent", border: "none", borderBottom: "1px solid var(--c-bd)", color: "var(--c-tx)", fontSize: 15, outline: "none", fontFamily: "inherit" }}
        />
        <div style={{ maxHeight: 320, overflowY: "auto", padding: 6 }}>
          {filtered.map((d) => (
            <button
              key={d.labelKey}
              onClick={() => go(d.href)}
              style={{ display: "block", width: "100%", textAlign: "left", padding: "9px 12px", background: "transparent", border: "none", borderRadius: "var(--r1)", color: "var(--c-tx2)", fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--c-el)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
