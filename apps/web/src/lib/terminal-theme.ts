import type { CSSProperties } from "react";

/**
 * Terminal / log surface colours — intentionally dark in BOTH themes (a console reads as a console,
 * like Coolify/Dokploy). These resolved hexes are the single JS source, mirrored by the CSS tokens
 * --c-term-bg / --c-term-fg / --c-term-mute / --c-term-sel in globals.css. xterm's ITheme and some
 * canvases need concrete values rather than CSS vars, so the two must be kept in sync by hand.
 */
export const TERM_BG = "#0b0e14";
export const TERM_FG = "#cdd3de";
export const TERM_MUTE = "#8089a0"; // placeholder / empty text on the terminal surface (AA on TERM_BG)
export const TERM_SEL = "#33343b";

/**
 * Full 16-colour ANSI theme for the interactive xterm shell so `ls --color`, prompts and TUIs render
 * like a real terminal; cursor in Tugra gold, surfaces matched to the dark panel.
 */
export const XTERM_THEME = {
  background: TERM_BG,
  foreground: "#e4e4e7",
  cursor: "#d4af6a",
  cursorAccent: TERM_BG,
  selectionBackground: TERM_SEL,
  black: "#2b2b2b",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#fbbf24",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#e4e4e7",
  brightBlack: "#6b7280",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#fde68a",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#ffffff",
} as const;

/**
 * The static build/deploy log terminal look. Shared by the deployment drill-in, the Logs tab's
 * last-deploy log, the live build-log stream and the pre-crash log tail so the viewers can't drift.
 */
export const TERMINAL_PRE_STYLE: CSSProperties = {
  margin: 0,
  padding: "12px 14px",
  fontSize: 12,
  lineHeight: 1.55,
  color: TERM_FG,
  background: TERM_BG,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  borderRadius: "var(--r1)",
  overflow: "auto",
};
