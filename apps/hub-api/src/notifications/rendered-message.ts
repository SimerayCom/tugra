/**
 * A provider-agnostic rich message. Firing sites (or, from Dilim 3, typed event templates) build one
 * of these; each notification provider renders it into its native format (Discord embed, Slack
 * attachment, Telegram HTML, ntfy headers, Gotify priority, SMTP HTML, structured webhook).
 */
export type MsgLevel = "success" | "failure" | "warning" | "info";
export interface MsgField {
  label: string;
  value: string;
  inline?: boolean;
}
export interface MsgLink {
  label: string;
  url: string;
}
export interface RenderedMessage {
  level: MsgLevel;
  title: string;
  summary: string; // one-line plain-text fallback for dumb channels
  fields: MsgField[];
  links: MsgLink[];
  critical?: boolean;
  timestamp: string; // ISO-8601
  event: string; // event id, for the structured webhook
}

// Single-source palette (one hex per level). Discord needs the integer form.
const PALETTE: Record<MsgLevel, string> = {
  success: "#57f287",
  failure: "#ff705f",
  warning: "#ffa743",
  info: "#4f545c",
};
export function levelColorHex(level: MsgLevel): string {
  return PALETTE[level];
}
export function levelColorInt(level: MsgLevel): number {
  return parseInt(PALETTE[level].slice(1), 16); // strip '#' — parseInt("#..",16) is NaN
}

const NTFY_TAGS: Record<MsgLevel, string> = {
  success: "white_check_mark",
  failure: "rotating_light",
  warning: "warning",
  info: "information_source",
};
export function levelTag(level: MsgLevel): string {
  return NTFY_TAGS[level];
}

const NTFY_PRIORITY: Record<MsgLevel, number> = { info: 3, success: 3, warning: 4, failure: 5 };
export function levelPriority(level: MsgLevel): number {
  return NTFY_PRIORITY[level];
}

const GOTIFY_PRIORITY: Record<MsgLevel, number> = { info: 3, success: 4, warning: 7, failure: 8 };
export function levelPriorityGotify(level: MsgLevel): number {
  return GOTIFY_PRIORITY[level];
}

// Pushover priority (-2 lowest … 2 emergency). Emergency (2) is intentionally NOT mapped from a level —
// it re-alerts until acknowledged, so it stays opt-in via an explicit config.priority=2.
const PUSHOVER_PRIORITY: Record<MsgLevel, number> = { info: -1, success: 0, warning: 1, failure: 1 };
export function levelPriorityPushover(level: MsgLevel): number {
  return PUSHOVER_PRIORITY[level];
}

/** HTML-escape a value before interpolating it into Telegram (parse_mode HTML) or an SMTP html body. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Strip CR/LF so a value cannot inject extra email headers (used on the SMTP subject). */
export function sanitizeHeader(s: string): string {
  return s.replace(/[\r\n]+/g, " ").trim();
}

/** Printable-ASCII only — ntfy's X-* headers are latin-1 and a non-ASCII value would 400 or mangle. */
export function sanitizeNtfyHeader(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, "").trim();
}

export function fieldsAsLines(fields: MsgField[]): string {
  return fields.map((f) => `${f.label}: ${f.value}`).join("\n");
}

/** Plain-text fallback for dumb channels: title, then summary (if distinct), then label:value lines. */
export function toPlain(msg: RenderedMessage): string {
  const parts = [msg.title];
  if (msg.summary && msg.summary !== msg.title) parts.push(msg.summary);
  const lines = fieldsAsLines(msg.fields);
  if (lines) parts.push(lines);
  return parts.join("\n\n");
}
