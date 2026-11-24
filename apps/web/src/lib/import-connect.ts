import type { ImportConnectFailureCode, ImportTestResult } from "./types";

/** Whether a pasted URL + token are worth testing: an http(s) address with a dotted host (not a half-typed name) and a token that is not a stub. Pure. */
export function readyToTest(baseUrl: string, token: string): boolean {
  const url = baseUrl.trim();
  if (!/^https?:\/\/[^\s/]+/i.test(url)) return false;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  if (!/^(\[.+\]|[^.]+(\.[^.]+)*\.[a-z0-9-]{2,}|\d{1,3}(\.\d{1,3}){3})$/i.test(host)) return false;
  return token.trim().length >= 8;
}

/** The i18n key of the single sentence a refusal gets. Anything the hub did not name falls back to the generic one. */
export function failureKey(code: ImportConnectFailureCode | string | undefined): string {
  switch (code) {
    case "allowed-ips":
    case "api-disabled":
    case "scoped-token":
    case "exceeds-access":
    case "ability":
    case "forbidden":
    case "unauthorized":
    case "rate-limited":
      return `import.test.fail.${code}`;
    default:
      return "import.test.fail.other";
  }
}

export type TestFacts = Extract<ImportTestResult, { ok: true }>;

/** The "✓ <team>, 19 apps, 10 databases · read:sensitive" line, as ordered parts so the copy stays in the locale file. Pure. */
export function testLineParts(r: TestFacts): { hasTeam: boolean; counts: { key: "apps" | "databases" | "services"; n: number }[]; sensitive: boolean | null } {
  const counts: { key: "apps" | "databases" | "services"; n: number }[] = [];
  if (r.apps !== null) counts.push({ key: "apps", n: r.apps });
  if (r.databases !== null) counts.push({ key: "databases", n: r.databases });
  if (r.services !== null && r.services > 0) counts.push({ key: "services", n: r.services });
  return { hasTeam: !!r.team, counts, sensitive: r.sensitive };
}
