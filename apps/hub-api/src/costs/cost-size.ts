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

/** The provider slug a server's price belongs to: the linked / provisioned provider, else what the host itself reports. */
export function providerOf(s: { provider: string | null; cloudHint: string | null }): string | null {
  return s.provider ?? s.cloudHint ?? null;
}

export const archOf = (s: { arch: string | null }): "x86" | "arm" => (isArm(s.arch) ? "arm" : "x86");

/** Allow-list for the provider hint an agent reports (a short lowercase slug). */
export function cleanCloudHint(v: unknown): string | null {
  return typeof v === "string" && /^[a-z][a-z0-9-]{1,23}$/.test(v.trim().toLowerCase()) ? v.trim().toLowerCase() : null;
}
