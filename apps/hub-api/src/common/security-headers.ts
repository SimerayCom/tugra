/** Baseline response hardening for every hub route (the API is also reachable on the raw hub port).
 *  No CSP here: Swagger UI needs its own inline assets and the icon route sets a stricter one itself. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
};

/** Structural response type (no express types dependency in this package). */
interface HeaderWritable {
  setHeader(name: string, value: string): unknown;
  removeHeader(name: string): unknown;
}

export function securityHeadersMiddleware(_req: unknown, res: HeaderWritable, next: () => void): void {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  res.removeHeader("X-Powered-By");
  next();
}
