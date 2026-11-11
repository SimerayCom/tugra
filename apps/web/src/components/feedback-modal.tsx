"use client";

import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useT } from "../i18n/provider";
import {
  formatReportBody,
  formatReportFile,
  githubIssueUrl,
  reportFilename,
  sanitizeRoutePath,
  willTruncateIssueUrl,
  type FeedbackCategory,
  type FeedbackDiagnostics,
} from "../lib/feedback";
import { Modal } from "./modal";
import { Btn } from "./ui";
import { Field, Select, Textarea } from "./form";

// The public repository that receives issues. A prefilled issue opens here in the user's own browser.
const REPO = "SimerayCom/tugra";

/**
 * Opt-in "Report a problem / Feedback" dialog. Trust wedge: it NEVER posts anything on its own and there is
 * no Tugra backend. The user writes a note, optionally attaches a non-sensitive diagnostics snapshot (shown
 * IN FULL in the live preview), then EITHER opens a prefilled GitHub issue in their browser (the prefilled
 * text reaches github.com when the tab opens; they review and submit it there) OR downloads the report as a
 * file to send however they like. Diagnostics carry no secrets; the free-text message is the user's own, so
 * the UI warns that GitHub issues are public.
 */
export function FeedbackModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const titleId = useId();
  const previewId = useId();
  const { user } = useAuth();
  const isOwner = !!user?.isInstanceOwner;
  const { data: status } = useQuery({ queryKey: ["instanceStatus"], queryFn: () => api.getInstanceStatus(), staleTime: 60_000 });
  // Version is only known to owners (via the update check); non-owners omit it rather than expose a guess.
  const { data: update } = useQuery({ queryKey: ["instanceUpdate"], queryFn: () => api.getInstanceUpdate(), enabled: isOwner });

  const [category, setCategory] = useState<FeedbackCategory>("bug");
  const [message, setMessage] = useState("");
  const [includeDiag, setIncludeDiag] = useState(true);
  const [showPreview, setShowPreview] = useState(true);

  // Built fresh each time it's needed (for the live preview and again at click), so capturedAt, viewport
  // and route are current and a late-resolving owner version is never silently dropped.
  const makeDiag = (): FeedbackDiagnostics => ({
    edition: status?.edition,
    version: isOwner ? update?.current : undefined,
    browser: typeof navigator !== "undefined" ? navigator.userAgent : "",
    language: typeof navigator !== "undefined" ? navigator.language : "",
    viewport: typeof window !== "undefined" ? `${window.innerWidth}×${window.innerHeight}` : "",
    route: typeof window !== "undefined" ? sanitizeRoutePath(window.location.pathname) : "",
    capturedAt: new Date().toISOString(),
  });

  const ready = message.trim().length > 0;
  const previewBody = formatReportBody(message, includeDiag ? makeDiag() : undefined);
  const willTruncate = ready && willTruncateIssueUrl(REPO, category, message, includeDiag ? makeDiag() : undefined);

  const openIssue = () => {
    if (!ready) return;
    window.open(githubIssueUrl(REPO, category, message, includeDiag ? makeDiag() : undefined), "_blank", "noopener,noreferrer");
  };

  const downloadReport = () => {
    if (!ready) return;
    const blob = new Blob([formatReportFile(category, message, includeDiag ? makeDiag() : undefined)], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = reportFilename();
    a.style.display = "none";
    document.body.appendChild(a); // some browsers require the anchor in the DOM to trigger a download
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000); // revoke after the download has started (Safari/Firefox)
  };

  return (
    <Modal onClose={onClose} labelledBy={titleId} closeOnBackdrop={false}>
      <h2 id={titleId} style={{ fontSize: 16, fontWeight: 700, margin: "0 0 4px" }}>{t("feedback.title")}</h2>
      <p style={{ fontSize: 13, color: "var(--c-tx2)", margin: "0 0 14px", lineHeight: 1.5 }}>{t("feedback.intro")}</p>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label={t("feedback.category")} htmlFor="fb-cat">
          <Select
            id="fb-cat"
            value={category}
            onChange={(v) => setCategory(v as FeedbackCategory)}
            options={[
              { value: "bug", label: t("feedback.catBug") },
              { value: "idea", label: t("feedback.catIdea") },
              { value: "question", label: t("feedback.catQuestion") },
            ]}
          />
        </Field>

        {/* No htmlFor → Field auto-wires id + aria-describedby (the hint) onto the Textarea. */}
        <Field label={t("feedback.message")} hint={t("feedback.messageHint")}>
          <Textarea required value={message} onChange={(e) => setMessage(e.target.value)} rows={5} placeholder={t("feedback.messagePlaceholder")} />
        </Field>

        <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, color: "var(--c-tx2)", cursor: "pointer", lineHeight: 1.5 }}>
          <input type="checkbox" checked={includeDiag} onChange={(e) => setIncludeDiag(e.target.checked)} style={{ marginTop: 2, accentColor: "var(--c-a)", flexShrink: 0 }} />
          <span>{t("feedback.includeDiagnostics")}</span>
        </label>

        <div>
          <button
            type="button"
            onClick={() => setShowPreview((s) => !s)}
            aria-expanded={showPreview}
            aria-controls={previewId}
            style={{ background: "transparent", border: "none", color: "var(--c-a)", fontSize: 12, cursor: "pointer", padding: "4px 0", minHeight: 24, fontFamily: "inherit" }}
          >
            {showPreview ? t("feedback.hidePreview") : t("feedback.showPreview")}
          </button>
          {showPreview && (
            <pre
              id={previewId}
              className="mono"
              role="region"
              tabIndex={0}
              aria-label={t("feedback.previewLabel")}
              style={{ margin: "6px 0 0", padding: 10, fontSize: 11, color: "var(--c-tx2)", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 200, overflowY: "auto" }}
            >
              {previewBody}
            </pre>
          )}
        </div>

        <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: 0, lineHeight: 1.5 }}>{t("feedback.privacyNote")}</p>
        {willTruncate && (
          <p role="status" style={{ fontSize: 12, color: "var(--c-am)", margin: 0, lineHeight: 1.5 }}>{t("feedback.truncateWarn")}</p>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap", marginTop: 16 }}>
        <Btn variant="ghost" onClick={onClose}>{t("common.cancel")}</Btn>
        <Btn variant="ghost" disabled={!ready} onClick={downloadReport}>{t("feedback.download")}</Btn>
        <Btn disabled={!ready} onClick={openIssue} title={t("feedback.openIssueHint")} aria-label={`${t("feedback.openIssue")} — ${t("feedback.openIssueHint")}`}>
          {t("feedback.openIssue")}
        </Btn>
      </div>
    </Modal>
  );
}
