import { z } from "zod";
import { GPU_PROBE_BEGIN, GPU_PROBE_END } from "./gpu-probe-script";

/**
 * Pure types, zod schemas and parsers for the per-server GPU detection snapshot. The probe output is
 * UNTRUSTED (it is produced on a host the hub does not control, and the result is relayed to browsers/MCP):
 * every field is matched against a strict whitelist regex, capped, and anything that does not match is dropped.
 */

export type GpuVendor = "nvidia" | "amd" | "intel" | "other";

export const PCI_ADDR_RE = /^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/;
export const GPU_UUID_RE = /^(GPU|MIG)-[0-9A-Za-z-]{8,80}$/;
export const DRIVER_VERSION_RE = /^[0-9][0-9A-Za-z._-]{0,31}$/;
export const RUNTIME_NAME_RE = /^[A-Za-z0-9._-]{1,40}$/;
const HEX4_RE = /^0x[0-9a-f]{4}$/;
const PCI_CLASS_RE = /^0x[0-9a-f]{6}$/;

export const MAX_GPUS = 16;
const MAX_RUNTIMES = 16;
const MAX_NAME = 64;
const MAX_ERROR = 200;
const MAX_MEMORY_MB = 4_194_304;

/** Hypervisor / BMC display adapters: they are VGA-class PCI devices but not compute GPUs. ASPEED 1a03, VMware 15ad,
 *  QEMU std-vga 1234, virtio 1af4, QXL/Red Hat 1b36, Hyper-V 1414, VirtualBox 80ee, Matrox G200e on Dell iDRAC / HPE iLO
 *  102b, Cirrus (old KVM guests) 1013, Xen 5853, Parallels 1ab8, Huawei iBMC 19e5. The list is explicit on purpose:
 *  treating every unknown vendor as virtual would hide genuine non-big-three accelerators. */
const VIRTUAL_VENDORS = new Set(["1a03", "15ad", "1234", "1af4", "1b36", "1414", "80ee", "102b", "1013", "5853", "1ab8", "19e5"]);

export const GpuDeviceSchema = z.object({
  index: z.number().int().min(0).max(63).nullable(),
  uuid: z.string().regex(GPU_UUID_RE).nullable(),
  name: z.string().min(1).max(MAX_NAME),
  vendor: z.enum(["nvidia", "amd", "intel", "other"]),
  kind: z.enum(["gpu", "virtual"]),
  memoryMb: z.number().int().min(0).max(MAX_MEMORY_MB).nullable(),
  driver: z.string().regex(DRIVER_VERSION_RE).nullable(),
  pci: z.string().regex(PCI_ADDR_RE).nullable(),
  source: z.enum(["nvidia-smi", "pci"]),
});
export type GpuDevice = z.infer<typeof GpuDeviceSchema>;

export const GpuInventorySchema = z.object({
  v: z.literal(1),
  gpus: z.array(GpuDeviceSchema).max(MAX_GPUS),
  runtimes: z.array(z.string().regex(RUNTIME_NAME_RE)).max(MAX_RUNTIMES),
  defaultRuntime: z.string().regex(RUNTIME_NAME_RE).nullable(),
  nvidiaRuntime: z.boolean(),
  nvidiaDriverLoaded: z.boolean(),
  nvidiaModuleVersion: z.string().regex(DRIVER_VERSION_RE).nullable(),
  error: z.string().max(MAX_ERROR).nullable(),
});
export type GpuInventory = z.infer<typeof GpuInventorySchema>;

export const GPU_READINESS = ["unknown", "none", "driver_missing", "runtime_missing", "ready", "non_nvidia", "probe_failed"] as const;
export type GpuReadiness = (typeof GPU_READINESS)[number];

export const GpuReportSchema = z.object({
  inventory: GpuInventorySchema.nullable(),
  readiness: z.enum(GPU_READINESS),
  checkedAt: z.string().nullable(),
  ageSeconds: z.number().int().nullable(),
  stale: z.boolean(),
  ttlSeconds: z.number().int(),
  throttled: z.boolean().optional(),
  busy: z.boolean().optional(),
});
export type GpuReport = z.infer<typeof GpuReportSchema>;

/** Read a stored Json column back: a corrupt / old-shape row degrades to null (= unknown), never a throw. */
export function parseStoredInventory(json: unknown): GpuInventory | null {
  const r = GpuInventorySchema.safeParse(json);
  return r.success ? r.data : null;
}

/** Strip control characters (incl. newlines) to single spaces, collapse whitespace, cap. */
function cleanText(raw: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Whitelist sanitizer for a GPU model name. */
function cleanName(raw: string): string {
  return raw
    .replace(/[^A-Za-z0-9 ._,:()[\]/+-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME)
    .trim();
}

function vendorOf(vendorHex: string): GpuVendor {
  switch (vendorHex) {
    case "10de":
      return "nvidia";
    case "1002":
      return "amd";
    case "8086":
      return "intel";
    default:
      return "other";
  }
}

const VENDOR_LABEL: Record<GpuVendor, string> = { nvidia: "NVIDIA GPU", amd: "AMD GPU", intel: "Intel GPU", other: "GPU" };

function parseRuntimeNames(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.keys(parsed as Record<string, unknown>)
      .filter((k) => RUNTIME_NAME_RE.test(k))
      .slice(0, MAX_RUNTIMES);
  } catch {
    return [];
  }
}

/**
 * Parse the probe output. Returns null when the begin/end markers are missing (a truncated run must never
 * overwrite a good snapshot), `{ busy: true }` when the helper-container name was already in use (another probe
 * is running on that host), else the sanitized inventory. Only line-anchored `TUGRA_*` lines that match the
 * strict regexes are read; everything else (docker noise) is ignored.
 */
export function parseGpuProbe(output: string): GpuInventory | { busy: true } | null {
  const lines = output.split(/\r?\n/);
  const begin = lines.findIndex((l) => l.trim() === GPU_PROBE_BEGIN);
  if (begin < 0) return null;
  let end = -1;
  for (let i = lines.length - 1; i > begin; i--) {
    if (lines[i].trim() === GPU_PROBE_END) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;

  const pciRows: GpuDevice[] = [];
  const smiRows: GpuDevice[] = [];
  let runtimes: string[] = [];
  let defaultRuntime: string | null = null;
  let nvidiaDriverLoaded = false;
  let nvidiaModuleVersion: string | null = null;
  let error: string | null = null;

  for (let i = begin + 1; i < end; i++) {
    const line = lines[i];
    const sp = line.indexOf(" ");
    if (sp < 0) continue;
    const tag = line.slice(0, sp);
    const rest = line.slice(sp + 1);

    switch (tag) {
      case "TUGRA_PCI": {
        const f = rest.trim().split(/\s+/);
        if (f.length !== 4) break;
        const [addr, vendorRaw, deviceRaw, klass] = f;
        if (!PCI_ADDR_RE.test(addr) || !HEX4_RE.test(vendorRaw) || !HEX4_RE.test(deviceRaw) || !PCI_CLASS_RE.test(klass)) break;
        if (!klass.startsWith("0x03")) break;
        const vid = vendorRaw.slice(2);
        const did = deviceRaw.slice(2);
        const virtual = VIRTUAL_VENDORS.has(vid);
        const vendor = vendorOf(vid);
        pciRows.push({
          index: null,
          uuid: null,
          name: `${virtual ? "Virtual display" : VENDOR_LABEL[vendor]} [${vid}:${did}]`,
          vendor,
          kind: virtual ? "virtual" : "gpu",
          memoryMb: null,
          driver: null,
          pci: addr,
          source: "pci",
        });
        break;
      }
      case "TUGRA_NVPROC": {
        const a = rest.indexOf("|");
        const b = a < 0 ? -1 : rest.indexOf("|", a + 1);
        if (a < 0 || b < 0) break;
        const bdf = rest.slice(0, a).trim();
        const uuid = rest.slice(a + 1, b).trim();
        const model = cleanName(rest.slice(b + 1));
        const row = pciRows.find((r) => r.pci === bdf && r.vendor === "nvidia");
        if (!row) break;
        if (model) row.name = model;
        if (GPU_UUID_RE.test(uuid)) row.uuid = uuid;
        nvidiaDriverLoaded = true;
        break;
      }
      case "TUGRA_NVRM": {
        // Proprietary: "NVIDIA UNIX x86_64 Kernel Module  550.54.15"; open modules: "NVIDIA UNIX Open Kernel Module for x86_64  560.35.03".
        const m = /Kernel Module(?: for \S+)?\s+([0-9][0-9A-Za-z._-]{0,31})/.exec(rest);
        if (m && DRIVER_VERSION_RE.test(m[1])) {
          nvidiaModuleVersion = m[1];
          nvidiaDriverLoaded = true;
        }
        break;
      }
      case "TUGRA_NVSMI": {
        const f = rest.split(",").map((s) => s.trim());
        if (f.length < 5) break;
        const idxRaw = f[0];
        if (!/^\d{1,2}$/.test(idxRaw)) break;
        const index = Number(idxRaw);
        if (index > 63) break;
        const uuid = GPU_UUID_RE.test(f[1]) ? f[1] : null;
        const memRaw = f[f.length - 2];
        const memNum = /^\d{1,9}$/.test(memRaw) ? Number(memRaw) : null;
        const memoryMb = memNum !== null && memNum <= MAX_MEMORY_MB ? memNum : null;
        const drvRaw = f[f.length - 1];
        const driver = DRIVER_VERSION_RE.test(drvRaw) ? drvRaw : null;
        const name = cleanName(f.slice(2, f.length - 2).join(", ")) || "NVIDIA GPU";
        smiRows.push({ index, uuid, name, vendor: "nvidia", kind: "gpu", memoryMb, driver, pci: null, source: "nvidia-smi" });
        break;
      }
      case "TUGRA_NVSMI_ERR": {
        const m = /^rc=(\d{1,3})\s*(.*)$/s.exec(rest.trim());
        if (!m) break;
        const text = cleanText(m[2], MAX_ERROR);
        if (/is already in use/i.test(text)) return { busy: true };
        error = text || `nvidia-smi failed (rc=${m[1]})`;
        break;
      }
      case "TUGRA_RUNTIMES":
        runtimes = parseRuntimeNames(rest.trim());
        break;
      case "TUGRA_DEFRT": {
        const d = rest.trim();
        defaultRuntime = RUNTIME_NAME_RE.test(d) ? d : null;
        break;
      }
      default:
        break;
    }
  }

  // nvidia-smi is authoritative for NVIDIA devices: when it answered, the synthesized PCI/procfs nvidia rows go.
  const keptPci = smiRows.length > 0 ? pciRows.filter((r) => r.vendor !== "nvidia") : pciRows;
  const seenPci = new Set<string>();
  const dedupedPci = keptPci.filter((r) => {
    if (r.pci === null) return true;
    if (seenPci.has(r.pci)) return false;
    seenPci.add(r.pci);
    return true;
  });
  const gpus = [...dedupedPci, ...smiRows]
    .sort((x, y) => {
      if (x.pci !== y.pci) {
        if (x.pci === null) return 1;
        if (y.pci === null) return -1;
        return x.pci < y.pci ? -1 : 1;
      }
      return (x.index ?? 0) - (y.index ?? 0);
    })
    .slice(0, MAX_GPUS);

  return {
    v: 1,
    gpus,
    runtimes,
    defaultRuntime,
    nvidiaRuntime: runtimes.includes("nvidia"),
    nvidiaDriverLoaded,
    nvidiaModuleVersion,
    error,
  };
}

/** Docker-GPU readiness for a snapshot. Order matters (see the spec): null is UNKNOWN, never "no GPU". */
export function classifyReadiness(inv: GpuInventory | null): GpuReadiness {
  if (!inv) return "unknown";
  if (inv.error) return "probe_failed";
  if (inv.gpus.some((g) => g.source === "nvidia-smi")) return inv.nvidiaRuntime ? "ready" : "runtime_missing";
  if (inv.gpus.some((g) => g.vendor === "nvidia" && g.kind === "gpu")) {
    if (!inv.nvidiaDriverLoaded) return "driver_missing";
    if (!inv.nvidiaRuntime) return "runtime_missing";
    return "probe_failed";
  }
  if (inv.gpus.some((g) => g.kind === "gpu")) return "non_nvidia";
  return "none";
}

/** True once the snapshot is older than the TTL. A never-probed server is unknown, not stale. */
export function isGpuStale(checkedAt: Date | null, now: Date, ttlMs = 600_000): boolean {
  if (!checkedAt) return false;
  return now.getTime() - checkedAt.getTime() > ttlMs;
}
