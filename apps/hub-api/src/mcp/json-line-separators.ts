/**
 * U+2028 / U+2029 are legal inside a JSON string, but JSON.stringify emits them as raw bytes. Some MCP clients
 * (and the line splitters in front of them) treat them as line terminators and truncate the payload, so the
 * request hangs until it times out. `\u2028` / `\u2029` parse to the same string, so escape them on the wire.
 */
const LINE_SEPARATORS = /[\u2028\u2029]/g;

export function escapeLineSeparators(json: string): string {
  return json.replace(LINE_SEPARATORS, (c) => (c === "\u2028" ? "\\u2028" : "\\u2029"));
}

/** Structural request/response types (no express types dependency in this package). */
interface JsonResponse {
  send(body?: unknown): unknown;
  getHeader(name: string): unknown;
}

/**
 * Route middleware: Express serializes a returned object with res.json, which ends in res.send(string) with
 * the JSON content type already set. Escape the separators in that string; anything else passes through.
 */
export function escapeJsonLineSeparators(_req: unknown, res: JsonResponse, next: () => void): void {
  const send = res.send.bind(res);
  res.send = (body?: unknown) => {
    const type = res.getHeader("Content-Type");
    return send(typeof body === "string" && typeof type === "string" && type.includes("json") ? escapeLineSeparators(body) : body);
  };
  next();
}
