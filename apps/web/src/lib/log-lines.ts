/**
 * Collapse carriage-return progress frames in a captured log so a log view shows the FINAL state of each
 * line instead of every intermediate frame. Tools like `git clone` ("Receiving objects: 42%\rReceiving
 * objects: 100%, done.") and image pulls overwrite a line in place with `\r`; a renderer that keeps the raw
 * bytes shows a stack of half-frames. For each `\n`-delimited line we keep only the text after its last
 * `\r` — what a terminal would leave visible. A trailing `\r` is treated as a CRLF line ending (stripped),
 * never as an overwrite-to-empty, so CRLF logs are not blanked. Pure + deterministic.
 */
export function collapseCarriageReturns(raw: string): string {
  if (!raw.includes("\r")) return raw; // fast path: the overwhelmingly common case
  return raw
    .split("\n")
    .map((line) => {
      const l = line.endsWith("\r") ? line.slice(0, -1) : line; // CRLF line ending, not a progress overwrite
      const i = l.lastIndexOf("\r");
      return i === -1 ? l : l.slice(i + 1);
    })
    .join("\n");
}
