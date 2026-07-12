// Minimal ANSI SGR parser for the log viewer — no dependency. Splits a line into styled segments,
// mapping the basic 8/16 foreground colors + bold to theme tokens. Unknown/extended codes (256-color,
// backgrounds) are stripped. A malformed/truncated escape is left as literal text (never throws).

export interface AnsiSegment {
  text: string;
  color?: string;
  bold?: boolean;
}

// Basic + bright foreground SGR codes → theme colors. Codes not listed (black/white/default) fall
// back to the default text color.
const FG: Record<number, string> = {
  31: "var(--c-r)", 91: "var(--c-r)", // red
  32: "var(--c-g)", 92: "var(--c-g)", // green
  33: "var(--c-am)", 93: "var(--c-am)", // yellow
  34: "var(--c-lapis)", 94: "var(--c-lapis)", // blue
  36: "var(--c-lapis)", 96: "var(--c-lapis)", // cyan
  35: "var(--c-a)", 95: "var(--c-a)", // magenta → accent
};

// eslint-disable-next-line no-control-regex
const SGR = /\x1b\[([0-9;]*)m/g;

/** Parse a single log line into styled segments. A plain line yields one segment. */
export function parseAnsi(line: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  let color: string | undefined;
  let bold = false;
  let last = 0;
  const push = (text: string) => {
    if (!text) return;
    const seg: AnsiSegment = { text };
    if (color) seg.color = color;
    if (bold) seg.bold = true;
    segments.push(seg);
  };

  SGR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SGR.exec(line)) !== null) {
    push(line.slice(last, m.index));
    last = SGR.lastIndex;
    const codes = m[1] === "" ? [0] : m[1].split(";").map((n) => Number(n) || 0);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 38 || c === 48) {
        // extended color: 38;5;n (256) or 38;2;r;g;b (truecolor) — consume + ignore the payload
        i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0;
      } else if (c === 0) {
        color = undefined;
        bold = false;
      } else if (c === 1) {
        bold = true;
      } else if (c === 22) {
        bold = false;
      } else if (c === 39) {
        color = undefined;
      } else if (FG[c]) {
        color = FG[c];
      }
      // any other code (backgrounds, italics, etc.) is stripped
    }
  }
  push(line.slice(last));
  if (segments.length === 0) segments.push({ text: line }); // empty or all-stripped line
  return segments;
}
