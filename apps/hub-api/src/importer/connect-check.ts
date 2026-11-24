import { classifyCoolify403 } from "./sources/coolify-http";

/**
 * Why a source refused a connection, as a stable code the wizard can act on (it shows ONE short, relevant line per code and
 * reveals the "Allowed IPs" help only for `allowed-ips`). Derived from the error text the source client already produced
 * (`<Label> API error <status>: "<message>" ...`), so no new request is made and nothing secret is read.
 */
export type ConnectFailureCode =
  | "allowed-ips"
  | "api-disabled"
  | "scoped-token"
  | "exceeds-access"
  | "ability"
  | "forbidden"
  | "unauthorized"
  | "rate-limited"
  | "other";

export function classifyConnectFailure(detail: string | null | undefined): ConnectFailureCode {
  const text = detail ?? "";
  const m = /API error (\d{3})(?::\s*"([^"]*)")?/.exec(text);
  if (!m) return /rate-limited|rate limited/i.test(text) ? "rate-limited" : "other";
  const status = Number(m[1]);
  if (status === 401) return "unauthorized";
  if (status === 429) return "rate-limited";
  if (status === 403) {
    const cause = classifyCoolify403(m[2]);
    return cause === "unknown" ? "forbidden" : cause;
  }
  return "other";
}

/**
 * A suggested "source team label" from a source team's display name: lowercase, letters/digits/dot/dash/underscore only, at
 * most 64 characters, the same shape `ImportConnectSchema.scopeLabel` accepts. Empty when nothing usable is left.
 */
export function suggestScopeLabel(teamName: string | null | undefined): string {
  const slug = (teamName ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 64)
    .replace(/[-._]+$/g, "");
  return slug;
}
