import type { GpuReport } from "./types";

/**
 * Advisory-only hint for the app's "GPUs" limit against the last detected snapshot of its server. It never blocks
 * a save (the hub still validates only the format). Unknown / missing / cluster → null: an unprobed server never nags.
 * The returned `key` is an `apps.gpusAdvice_<key>` i18n suffix.
 */
export function gpusAdvice(
  value: string,
  report: GpuReport | undefined | null,
  clusterId?: string | null,
): null | { key: string; params?: Record<string, string | number> } {
  const v = value.trim();
  if (!v || clusterId || !report || report.readiness === "unknown") return null;
  switch (report.readiness) {
    case "none":
      return { key: "noGpu" };
    case "non_nvidia":
      return { key: "nonNvidia" };
    case "driver_missing":
      return { key: "noDriver" };
    case "runtime_missing":
      return { key: "runtimeUnconfirmed" };
    default:
      break;
  }
  const smi = (report.inventory?.gpus ?? []).filter((g) => g.source === "nvidia-smi");
  if (smi.length === 0) return null;
  const k = smi.length;
  if (/^\d+$/.test(v)) {
    return Number(v) > k ? { key: "countExceeds", params: { n: k } } : null;
  }
  const m = /^device=(.+)$/.exec(v);
  if (!m) return null;
  const indexes = new Set(smi.map((g) => g.index));
  const uuids = new Set(smi.map((g) => g.uuid).filter((u): u is string => !!u));
  for (const tok of m[1].split(",").map((x) => x.trim()).filter(Boolean)) {
    if (/^\d+$/.test(tok)) {
      if (!indexes.has(Number(tok))) return { key: "indexOutOfRange", params: { n: k } };
    } else if (/^(GPU|MIG)-/.test(tok)) {
      if (!uuids.has(tok)) return { key: "deviceUnknown" };
    }
  }
  return null;
}
