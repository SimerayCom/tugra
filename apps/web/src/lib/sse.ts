/** A live build-log event streamed from the hub (mirrors DeployLogHub). */
export type DeployLogEvent =
  | { type: "chunk"; data: string }
  | { type: "done"; status: "SUCCESS" | "FAILED"; exitCode: number; deploymentId: string };

/**
 * Parse complete SSE frames out of a rolling buffer. Frames are separated by a
 * blank line ("\n\n"); we keep only `data:` payloads. Any trailing partial
 * frame is returned as `rest` to be prepended to the next read.
 */
export function parseSseFrames(buffer: string): { events: string[]; rest: string } {
  const events: string[] = [];
  let rest = buffer;
  let sep = rest.indexOf("\n\n");
  while (sep !== -1) {
    const frame = rest.slice(0, sep);
    rest = rest.slice(sep + 2);
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => (line.startsWith("data: ") ? line.slice(6) : line.slice(5)))
      .join("\n");
    if (data) events.push(data);
    sep = rest.indexOf("\n\n");
  }
  return { events, rest };
}

/**
 * Read an SSE response body to completion, decoding frames and invoking onData
 * with each raw `data:` payload. Resolves when the stream ends (completed or
 * aborted). Generic over the payload — callers JSON.parse and interpret.
 */
export async function consumeSseStream(
  body: ReadableStream<Uint8Array>,
  onData: (raw: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseSseFrames(buffer);
      buffer = rest;
      for (const raw of events) onData(raw);
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Read an SSE response body to completion, invoking onEvent for each parsed
 * DeployLogEvent. Resolves when the stream ends (deploy finished, server
 * completed, or aborted).
 */
export async function consumeDeployLogStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: DeployLogEvent) => void,
): Promise<void> {
  await consumeSseStream(body, (raw) => {
    let event: DeployLogEvent;
    try {
      event = JSON.parse(raw) as DeployLogEvent;
    } catch {
      return;
    }
    onEvent(event);
  });
}
