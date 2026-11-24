import type { IncomingMessage, ServerResponse } from "node:http";

type Next = (err?: unknown) => void;
type Req = IncomingMessage & { body?: unknown; _body?: boolean; originalUrl?: string };

/**
 * A JSON body parser with a higher size limit for ONE route family (the framework's default is 100 kB, far too small
 * for a monitoring backup with a few hundred entries). Mounted in main.ts before the framework's parser; it marks the
 * request as already parsed (`_body`), so the default parser skips it and the limit everywhere else is unchanged.
 * Only POST + application/json under `prefix` is touched, and only when the request carries credentials (an
 * Authorization header or a cookie) so an anonymous client never gets the larger pre-auth buffer: it falls through
 * to the default 100 kB parser and the auth guard. The body is read with a hard byte cap (413 beyond it, also when
 * the declared Content-Length already exceeds it).
 */
export function largeJsonBody(prefix: string, maxBytes: number) {
  return (req: Req, res: ServerResponse, next: Next): void => {
    const url = (req.originalUrl ?? req.url ?? "").split("?")[0];
    const type = String(req.headers["content-type"] ?? "").toLowerCase();
    if (req.method !== "POST" || !url.startsWith(prefix) || !type.startsWith("application/json")) return next();
    if (!req.headers.authorization && !req.headers.cookie) return next();
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      res.statusCode = 413;
      res.setHeader("content-type", "application/json");
      res.setHeader("connection", "close");
      res.end(JSON.stringify({ statusCode: 413, message: "request body too large" }), () => req.destroy());
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const fail = (status: number, message: string) => {
      if (done) return;
      done = true;
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.setHeader("connection", "close");
      // Destroy the socket only once the reply is flushed, or the client may never see the 413.
      res.end(JSON.stringify({ statusCode: status, message }), () => req.destroy());
    };
    req.on("data", (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > maxBytes) return fail(413, "request body too large");
      chunks.push(c);
    });
    req.on("error", () => fail(400, "could not read the request body"));
    req.on("end", () => {
      if (done) return;
      done = true;
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        req.body = text.length ? JSON.parse(text) : {};
      } catch {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ statusCode: 400, message: "invalid JSON" }));
        return;
      }
      req._body = true; // body-parser skips a request that already has a parsed body
      next();
    });
  };
}
