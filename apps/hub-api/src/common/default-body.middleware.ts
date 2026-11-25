/**
 * A request that carries no body reaches a handler with `req.body === {}`, as it did under Express 4. Express 5's body
 * parser leaves `req.body` undefined, which would turn a body-less `POST /apps/:id/deploy` (every field optional) into
 * a validation error. Runs after the framework's parsers (a module middleware), before guards and handlers.
 */
export function defaultEmptyBody(req: { body?: unknown }, _res: unknown, next: (err?: unknown) => void): void {
  if (req.body === undefined) req.body = {};
  next();
}
