/**
 * Pure helpers for the opt-in Feedback / Report-a-problem flow. The guiding constraint is the trust wedge:
 * NOTHING is sent automatically. We only ever build text the user then chooses to carry somewhere — a
 * GitHub issue prefilled in THEIR browser (which they review before submitting) or a file they download.
 *
 * The optional diagnostics block carries only non-sensitive context (edition, version, the user's own
 * browser string, viewport, the current route path — query string stripped and dynamic ids collapsed to
 * ":id" — and a timestamp). It never contains tokens, secrets, IPs, emails or request bodies. It is on by
 * default because it helps reproduce bugs, but it is shown IN FULL in the dialog before anything is shared
 * and the user can remove it. The free-text message, by contrast, is the user's own words (not scrubbed) —
 * the UI warns not to paste secrets, because the destination (a GitHub issue) is public.
 */
export type FeedbackCategory = "bug" | "idea" | "question";

export interface FeedbackDiagnostics {
  /** Running edition, e.g. "community" (from the public instance status). */
  edition?: string;
  /** Running Tugra version, when the client knows it (owners do via the update check); omitted otherwise. */
  version?: string;
  /** The reporter's own browser user-agent string. */
  browser: string;
  /** The reporter's UI language. */
  language: string;
  /** Viewport size, e.g. "1440×900". */
  viewport: string;
  /** The current route PATH only (never the query string, which can carry one-off values). */
  route: string;
  /** ISO timestamp the snapshot was taken. */
  capturedAt: string;
}

const TITLE_PREFIX: Record<FeedbackCategory, string> = {
  bug: "[Bug]",
  idea: "[Idea]",
  question: "[Question]",
};

// GitHub rejects or truncates very long "new issue" URLs (~8KB); non-ASCII expands ~3x once encoded. Keep
// the whole prefilled URL under this so "Open a GitHub issue" never lands on an error or a silently cut body.
const MAX_ISSUE_URL = 7000;

/** A short issue title: the category tag plus the first line of the message, trimmed to a sane length. */
export function issueTitle(category: FeedbackCategory, message: string): string {
  const firstLine = message.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  const chars = Array.from(firstLine); // split by code point, so truncation never cuts an emoji/surrogate pair
  const snippet = chars.length > 80 ? `${chars.slice(0, 77).join("")}…` : firstLine;
  return snippet ? `${TITLE_PREFIX[category]} ${snippet}` : TITLE_PREFIX[category];
}

/**
 * Collapse dynamic path segments (resource ids, invite tokens) to ":id" so the current-page context never
 * leaks an internal id or an opaque token into a public report — even if this flow is later opened from a
 * resource page. The query string is dropped by the caller (we only ever pass a pathname). Pure.
 */
export function sanitizeRoutePath(path: string): string {
  const clean = (path || "").split("?")[0].split("#")[0];
  if (!clean) return "";
  return clean
    .split("/")
    .map((seg) => {
      if (!seg) return seg;
      if (/^\d+$/.test(seg)) return ":id"; // numeric id
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ":id"; // uuid
      if (seg.length >= 16 && /^[A-Za-z0-9_-]+$/.test(seg) && /\d/.test(seg)) return ":id"; // cuid / long opaque token
      return seg;
    })
    .join("/");
}

/** Render the diagnostics block exactly as it will appear in the report, so the preview is truthful. The
 *  labels here are deliberately English: this block is the maintainer-facing report format, read on the
 *  GitHub issue / in the downloaded file, not localized UI chrome. */
export function formatDiagnostics(diag: FeedbackDiagnostics): string {
  const idLine = diag.version
    ? `- Tugra: ${diag.version}${diag.edition ? ` (${diag.edition})` : ""}`
    : diag.edition
      ? `- Edition: ${diag.edition}`
      : null;
  return [
    "Diagnostics (shared by the reporter):",
    idLine,
    `- Browser: ${diag.browser}`,
    `- Language: ${diag.language}`,
    `- Viewport: ${diag.viewport}`,
    `- Page: ${diag.route}`,
    `- Captured: ${diag.capturedAt}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The report body: the user's message, plus the diagnostics block ONLY when provided. Pure + deterministic. */
export function formatReportBody(message: string, diag?: FeedbackDiagnostics): string {
  const msg = message.trim() || "(no description provided)";
  if (!diag) return msg;
  return `${msg}\n\n---\n${formatDiagnostics(diag)}`;
}

/** A GitHub "new issue" URL with the title + body prefilled. The user lands on GitHub and reviews/edits
 *  before submitting — we never post on their behalf. `repo` is "owner/name". */
export function githubIssueUrl(repo: string, category: FeedbackCategory, message: string, diag?: FeedbackDiagnostics): string {
  const base = `https://github.com/${repo}/issues/new?`;
  const build = (msg: string) => base + new URLSearchParams({ title: issueTitle(category, msg), body: formatReportBody(msg, diag) }).toString();
  const full = build(message);
  if (full.length <= MAX_ISSUE_URL) return full;
  // Too long for a GET URL: shrink the message (by code point) until it fits, with a note pointing at Download
  // so the user never submits a silently cut-off report.
  const note = ' … (truncated — use "Download report" for the full text)';
  let chars = Array.from(message);
  while (chars.length > 0) {
    chars = chars.slice(0, Math.max(0, Math.floor(chars.length * 0.9) - 1));
    const url = build(chars.join("") + note);
    if (url.length <= MAX_ISSUE_URL) return url;
  }
  return build(note.trim());
}

/** Whether the prefilled GitHub-issue URL for this input would exceed the safe length and be truncated.
 *  The modal uses this to warn the user (and nudge them to Download for the full report). Pure. */
export function willTruncateIssueUrl(repo: string, category: FeedbackCategory, message: string, diag?: FeedbackDiagnostics): boolean {
  const base = `https://github.com/${repo}/issues/new?`;
  return (base + new URLSearchParams({ title: issueTitle(category, message), body: formatReportBody(message, diag) }).toString()).length > MAX_ISSUE_URL;
}

/** Filename for the downloadable report. */
export function reportFilename(): string {
  return "tugra-feedback.md";
}

/** The downloadable report file contents (Markdown): a title line + the same body as the issue. */
export function formatReportFile(category: FeedbackCategory, message: string, diag?: FeedbackDiagnostics): string {
  return `# ${issueTitle(category, message)}\n\n${formatReportBody(message, diag)}\n`;
}
