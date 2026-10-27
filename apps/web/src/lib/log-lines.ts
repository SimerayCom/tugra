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

// Control lines the agent's deploy script echoes for the hub to parse — not meant for a human reader.
// `TUGRA_DIGEST=…` feeds digest-pinning (shown separately as the lock chip); `TUGRA_ROLLOUT: <state>`
// reports post-deploy health; a lone 64-hex line is the container/image id a `docker run`/`build` prints.
const DIGEST_MARKER = /^TUGRA_DIGEST=/;
const ROLLOUT_MARKER = /^TUGRA_ROLLOUT:\s*(\S+)/;
const BARE_ID = /^[0-9a-f]{64}$/;

export type DeployLogSummary = {
  /** Rollout state the agent reported (`healthy`, `converged`, `rolled_back`, …), or null if none. */
  rollout: string | null;
  /** The log with internal control lines removed and surrounding blank lines trimmed — human-readable. */
  body: string;
  /** True when at least one control line was stripped, so the UI can still offer the raw log. */
  stripped: boolean;
};

/**
 * Turn a captured deploy log into something a person can read: collapse progress frames, lift the rollout
 * state out of its marker, and drop the internal control lines (digest echo, rollout marker, bare container
 * id) that otherwise show up as a confusing raw dump. Pure + deterministic. For an image-pull deploy whose
 * log is nothing but control lines, `body` comes back empty and `stripped` is true.
 */
export function summarizeDeployLog(raw: string): DeployLogSummary {
  const collapsed = collapseCarriageReturns(raw ?? "");
  let rollout: string | null = null;
  let stripped = false;
  const kept: string[] = [];
  for (const line of collapsed.split("\n")) {
    const trimmed = line.trim();
    const m = trimmed.match(ROLLOUT_MARKER);
    if (m) {
      rollout = m[1];
      stripped = true;
      continue;
    }
    if (DIGEST_MARKER.test(trimmed) || BARE_ID.test(trimmed)) {
      stripped = true;
      continue;
    }
    kept.push(line);
  }
  const body = kept.join("\n").replace(/^\s*\n+/, "").replace(/\n+\s*$/, "");
  return { rollout, body, stripped };
}
