import { isArm, type HostSize } from "./cost-estimate";

/** The slice of a Server row the cost code reads. */
export interface SizedServer {
  cpuCores: number | null;
  memTotalBytes: bigint | null;
  arch: string | null;
}

/** Host size for a price estimate / size advice; disk is the latest measured total from the metrics rollups. */
export function hostSize(s: SizedServer, diskBytes: number | null): HostSize {
  return { cores: s.cpuCores, memBytes: s.memTotalBytes === null ? null : Number(s.memTotalBytes), diskBytes, arch: s.arch };
}

/** Where a provider hint came from: linked / provisioned by Tugra, reported by the host's own agent, or guessed from the host name. */
export type ProviderHint = "linked" | "agent" | "hostname";

/**
 * Provider slug from a host name, ONLY for patterns no other provider uses: Contabo names its VPS "vmi" + 6-9 digits
 * (vmi2419591), and a few providers' own domains show up in a fully-qualified host name. Anything else is no hint
 * (a name an operator chose says nothing). Lower-cases first; pure.
 */
export function providerFromHostname(hostname: string | null | undefined): string | null {
  const h = (hostname ?? "").trim().toLowerCase();
  if (!h || h.length > 253) return null;
  if (/^vmi\d{6,9}(\.|$)/.test(h)) return "contabo";
  if (/\.contaboserver\.net$/.test(h)) return "contabo";
  if (/\.(vps\.)?ovh\.(net|ca|us|eu)$/.test(h)) return "ovh";
  if (/\.(members\.linode\.com|ip\.linodeusercontent\.com)$/.test(h)) return "linode";
  if (/\.upcloud\.host$/.test(h)) return "upcloud";
  if (/\.scw\.cloud$/.test(h)) return "scaleway";
  return null;
}

/**
 * The provider slug a server's price belongs to and where that came from: the linked / provisioned provider, else what
 * the host's agent reports (DMI vendor strings), else a host-name pattern. A hint: an operator's own price replaces
 * any estimate that follows from it.
 */
export function providerHintOf(s: { provider: string | null; cloudHint: string | null; hostname?: string | null }): { provider: string; hint: ProviderHint } | null {
  if (s.provider) return { provider: s.provider, hint: "linked" };
  if (s.cloudHint) return { provider: s.cloudHint, hint: "agent" };
  const fromName = providerFromHostname(s.hostname);
  return fromName ? { provider: fromName, hint: "hostname" } : null;
}

export function providerOf(s: { provider: string | null; cloudHint: string | null; hostname?: string | null }): string | null {
  return providerHintOf(s)?.provider ?? null;
}

export const archOf = (s: { arch: string | null }): "x86" | "arm" => (isArm(s.arch) ? "arm" : "x86");

/** Allow-list for the provider hint an agent reports (a short lowercase slug). */
export function cleanCloudHint(v: unknown): string | null {
  return typeof v === "string" && /^[a-z][a-z0-9-]{1,23}$/.test(v.trim().toLowerCase()) ? v.trim().toLowerCase() : null;
}
