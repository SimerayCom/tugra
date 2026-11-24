"use client";

import React, { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ensureHubPublicUrl, hubPublicUrl } from "../../../lib/api";
import { copyText } from "../../../lib/clipboard";
import { claudeMcpAddCommand } from "../../../lib/mcp-command";
import { useT } from "../../../i18n/provider";
import { useToast } from "../../../components/toast";
import { useConfirm } from "../../../components/confirm";
import { Btn } from "../../../components/ui";

/**
 * The one-time reveal of a fresh secret. It stays on screen until the user confirms; closing without having
 * copied asks first, because the hub never shows the token again. For the MCP preset it also offers the
 * ready-to-run `claude mcp add` command (which embeds the token, so copying it counts as saving it).
 */
export function ApiTokenReveal({ token, mcp, onDone }: { token: string; mcp: boolean; onDone: () => void }) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [copied, setCopied] = useState<"token" | "command" | null>(null);
  const [saved, setSaved] = useState(false);
  // The hub's public origin (the SPA's own origin can differ in the two-port quick start).
  const { data: origin } = useQuery({ queryKey: ["hubPublicUrl"], queryFn: () => ensureHubPublicUrl(), enabled: mcp, staleTime: Infinity });
  const command = claudeMcpAddCommand(origin ?? hubPublicUrl(), token);

  useEffect(() => {
    setCopied(null);
    setSaved(false);
  }, [token]);

  const copy = async (what: "token" | "command") => {
    const ok = await copyText(what === "token" ? token : command);
    toast(ok ? t("common.copied") : t("common.copyFailed"), ok ? "success" : "error");
    if (ok) {
      setCopied(what);
      setSaved(true);
    }
  };

  const done = async () => {
    if (!saved && !(await confirm({ title: t("settings.tokenCloseTitle"), body: t("settings.tokenCloseBody"), confirmLabel: t("settings.tokenCloseConfirm"), danger: true }))) return;
    onDone();
  };

  const box: React.CSSProperties = { display: "flex", gap: 8, alignItems: "stretch", flexWrap: "wrap" };
  const code: React.CSSProperties = { flex: "1 1 220px", minWidth: 0, fontSize: 12, wordBreak: "break-all", background: "var(--c-bg)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "8px 10px" };

  return (
    <section aria-label={t("settings.tokenRevealTitle")} style={{ marginTop: 12, padding: 14, background: "var(--c-el)", border: "1px solid var(--c-a)", borderRadius: "var(--r2)", display: "flex", flexDirection: "column", gap: 10 }}>
      <div>
        <div style={{ fontWeight: 600 }}>{t("settings.tokenRevealTitle")}</div>
        <div style={{ fontSize: 12, color: "var(--c-am)" }}>{t("settings.tokenRevealHint")}</div>
      </div>

      <div style={box}>
        <code className="mono" aria-label={t("settings.tokenRevealValue")} style={code}>{token}</code>
        <Btn variant={copied === "token" ? "ghost" : "primary"} onClick={() => void copy("token")} style={{ minHeight: 44 }}>
          {copied === "token" ? t("settings.tokenCopied") : t("settings.tokenCopy")}
        </Btn>
      </div>

      {mcp && (
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{t("settings.tokenMcpCommandTitle")}</div>
          <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 6 }}>{t("settings.tokenMcpCommandHint")}</div>
          <div style={box}>
            <code className="mono" aria-label={t("settings.tokenMcpCommandLabel")} style={code}>{command}</code>
            <Btn variant={copied === "command" ? "ghost" : "primary"} onClick={() => void copy("command")} style={{ minHeight: 44 }}>
              {copied === "command" ? t("settings.tokenCopied") : t("settings.tokenCopyCommand")}
            </Btn>
          </div>
        </div>
      )}

      <div>
        <Btn variant="ghost" onClick={() => void done()} style={{ minHeight: 44 }}>{t("settings.tokenDone")}</Btn>
      </div>
    </section>
  );
}
