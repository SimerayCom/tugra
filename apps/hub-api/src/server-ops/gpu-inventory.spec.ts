import { classifyReadiness, isGpuStale, parseGpuProbe, parseStoredInventory, type GpuInventory } from "./gpu-inventory";

const B = "TUGRA_GPU_PROBE v1";
const E = "TUGRA_GPU_PROBE_END";
const probe = (...lines: string[]) => [B, ...lines, E].join("\n") + "\n";
const RT_NVIDIA = 'TUGRA_RUNTIMES {"io.containerd.runc.v2":{"path":"runc"},"nvidia":{"path":"nvidia-container-runtime"},"runc":{"path":"runc"}}';
const RT_PLAIN = 'TUGRA_RUNTIMES {"io.containerd.runc.v2":{"path":"runc"},"runc":{"path":"runc"}}';
const NVRM = "TUGRA_NVRM NVRM version: NVIDIA UNIX x86_64 Kernel Module  550.54.15  Thu Feb 22 01:44:30 UTC 2024";
const parse = (s: string): GpuInventory => {
  const r = parseGpuProbe(s);
  if (!r || "busy" in r) throw new Error("expected an inventory");
  return r;
};

describe("parseGpuProbe", () => {
  it("full NVIDIA output (2 GPUs, nvidia runtime, module version) is ready and nvidia-smi rows replace PCI rows", () => {
    const inv = parse(
      probe(
        "TUGRA_PCI 0000:01:00.0 0x10de 0x2684 0x030000",
        "TUGRA_NVPROC 0000:01:00.0|GPU-12345678-aaaa-bbbb-cccc-1234567890ab|NVIDIA GeForce RTX 4090",
        "TUGRA_PCI 0000:02:00.0 0x10de 0x2684 0x030000",
        RT_NVIDIA,
        "TUGRA_DEFRT runc",
        NVRM,
        "TUGRA_NVSMI 0, GPU-12345678-aaaa-bbbb-cccc-1234567890ab, NVIDIA GeForce RTX 4090, 24564, 550.54.15",
        "TUGRA_NVSMI 1, GPU-87654321-aaaa-bbbb-cccc-1234567890ab, NVIDIA GeForce RTX 4090, 24564, 550.54.15",
      ),
    );
    expect(inv.gpus).toHaveLength(2);
    expect(inv.gpus.every((g) => g.source === "nvidia-smi")).toBe(true);
    expect(inv.gpus[0]).toEqual({ index: 0, uuid: "GPU-12345678-aaaa-bbbb-cccc-1234567890ab", name: "NVIDIA GeForce RTX 4090", vendor: "nvidia", kind: "gpu", memoryMb: 24564, driver: "550.54.15", pci: null, source: "nvidia-smi" });
    expect(inv.runtimes).toEqual(["io.containerd.runc.v2", "nvidia", "runc"]);
    expect(inv.defaultRuntime).toBe("runc");
    expect(inv.nvidiaRuntime).toBe(true);
    expect(inv.nvidiaDriverLoaded).toBe(true);
    expect(inv.nvidiaModuleVersion).toBe("550.54.15");
    expect(classifyReadiness(inv)).toBe("ready");
  });

  it("PCI nvidia + procfs info, driver loaded but no nvidia runtime is runtime_missing (not driver_missing)", () => {
    const inv = parse(
      probe(
        "TUGRA_PCI 0000:01:00.0 0x10de 0x2684 0x030000",
        "TUGRA_NVPROC 0000:01:00.0|GPU-12345678-aaaa-bbbb-cccc-1234567890ab|NVIDIA GeForce RTX 4090",
        RT_PLAIN,
        "TUGRA_DEFRT runc",
      ),
    );
    expect(inv.gpus).toHaveLength(1);
    expect(inv.gpus[0]).toMatchObject({ source: "pci", name: "NVIDIA GeForce RTX 4090", uuid: "GPU-12345678-aaaa-bbbb-cccc-1234567890ab", pci: "0000:01:00.0" });
    expect(inv.nvidiaDriverLoaded).toBe(true);
    expect(inv.nvidiaRuntime).toBe(false);
    expect(classifyReadiness(inv)).toBe("runtime_missing");
  });

  it("PCI nvidia with no procfs is driver_missing, with a synthesized name", () => {
    const inv = parse(probe("TUGRA_PCI 0000:01:00.0 0x10de 0x2684 0x030000", RT_PLAIN));
    expect(inv.gpus[0].name).toBe("NVIDIA GPU [10de:2684]");
    expect(inv.nvidiaDriverLoaded).toBe(false);
    expect(classifyReadiness(inv)).toBe("driver_missing");
  });

  it("loaded driver + runtime but no smi rows and no error is probe_failed", () => {
    const inv = parse(probe("TUGRA_PCI 0000:01:00.0 0x10de 0x2684 0x030000", NVRM, RT_NVIDIA));
    expect(classifyReadiness(inv)).toBe("probe_failed");
  });

  it("a runtime plus NVSMI_ERR is probe_failed with the sanitized text", () => {
    const inv = parse(
      probe("TUGRA_PCI 0000:01:00.0 0x10de 0x2684 0x030000", NVRM, RT_NVIDIA, "TUGRA_NVSMI_ERR rc=125 docker: Error response from daemon: could not select device driver"),
    );
    expect(inv.error).toBe("docker: Error response from daemon: could not select device driver");
    expect(classifyReadiness(inv)).toBe("probe_failed");
  });

  it("AMD / Intel PCI is non_nvidia", () => {
    expect(classifyReadiness(parse(probe("TUGRA_PCI 0000:03:00.0 0x1002 0x73bf 0x030000")))).toBe("non_nvidia");
    expect(classifyReadiness(parse(probe("TUGRA_PCI 0000:00:02.0 0x8086 0x4680 0x030000")))).toBe("non_nvidia");
  });

  it("ASPEED / virtio / VMware only is none with kind virtual", () => {
    const inv = parse(
      probe(
        "TUGRA_PCI 0000:05:00.0 0x1a03 0x2000 0x030000",
        "TUGRA_PCI 0000:00:01.0 0x1af4 0x1050 0x030000",
        "TUGRA_PCI 0000:00:0f.0 0x15ad 0x0405 0x030000",
      ),
    );
    expect(inv.gpus).toHaveLength(3);
    expect(inv.gpus.every((g) => g.kind === "virtual")).toBe(true);
    expect(classifyReadiness(inv)).toBe("none");
  });

  it("BMC / legacy VM display adapters (Matrox, Cirrus, Xen, Parallels, Huawei iBMC) are virtual, not a non-NVIDIA GPU", () => {
    const inv = parse(
      probe(
        "TUGRA_PCI 0000:0a:00.1 0x102b 0x0534 0x030000",
        "TUGRA_PCI 0000:00:02.0 0x1013 0x00b8 0x030000",
        "TUGRA_PCI 0000:00:02.1 0x5853 0x1234 0x030000",
        "TUGRA_PCI 0000:00:03.0 0x1ab8 0x4005 0x030000",
        "TUGRA_PCI 0000:07:00.0 0x19e5 0x1711 0x030000",
      ),
    );
    expect(inv.gpus).toHaveLength(5);
    expect(inv.gpus.every((g) => g.kind === "virtual")).toBe(true);
    expect(classifyReadiness(inv)).toBe("none");
  });

  it("a real GPU next to a Matrox BMC adapter is still judged by the real GPU", () => {
    const inv = parse(probe("TUGRA_PCI 0000:0a:00.1 0x102b 0x0534 0x030000", "TUGRA_PCI 0000:03:00.0 0x1002 0x73bf 0x030000"));
    expect(classifyReadiness(inv)).toBe("non_nvidia");
  });

  it("parses the Open Kernel Module NVRM string (\"for x86_64\" before the version)", () => {
    const inv = parse(
      probe(
        "TUGRA_PCI 0000:01:00.0 0x10de 0x2684 0x030000",
        "TUGRA_NVRM NVRM version: NVIDIA UNIX Open Kernel Module for x86_64  560.35.03  Release Build  (dvs-builder@U16-I3-D08-1-2)",
      ),
    );
    expect(inv.nvidiaModuleVersion).toBe("560.35.03");
    expect(inv.nvidiaDriverLoaded).toBe(true);
    expect(classifyReadiness(inv)).toBe("runtime_missing");
  });

  it("includes class 0x0302 (3D controller)", () => {
    const inv = parse(probe("TUGRA_PCI 0000:01:00.0 0x10de 0x20b0 0x030200"));
    expect(inv.gpus).toHaveLength(1);
  });

  it("ignores non-display classes", () => {
    expect(parse(probe("TUGRA_PCI 0000:01:00.0 0x10de 0x20b0 0x020000")).gpus).toHaveLength(0);
  });

  it("[N/A] memory is null and a model name containing a comma parses", () => {
    const inv = parse(
      probe(RT_NVIDIA, "TUGRA_NVSMI 0, GPU-12345678-aaaa-bbbb-cccc-1234567890ab, NVIDIA Foo, Bar Edition, [N/A], 535.10"),
    );
    expect(inv.gpus[0]).toMatchObject({ name: "NVIDIA Foo, Bar Edition", memoryMb: null, driver: "535.10" });
  });

  it("drops bad uuid / driver / index / pci instead of storing them", () => {
    const inv = parse(
      probe(
        "TUGRA_PCI 0000:01:00.0 0x1002 0x73bf 0x030000",
        "TUGRA_PCI zzzz:01:00.0 0x1002 0x73bf 0x030000",
        "TUGRA_PCI 0000:01:00.0; 0x1002 0x73bf 0x030000",
        "TUGRA_NVSMI 0, GPU-bad, Card A, 100, $(reboot)",
        "TUGRA_NVSMI 99, GPU-12345678-aaaa-bbbb-cccc-1234567890ab, Card B, 100, 1.0",
        "TUGRA_NVSMI x, GPU-12345678-aaaa-bbbb-cccc-1234567890ab, Card C, 100, 1.0",
        "TUGRA_NVSMI 3, GPU-12345678-aaaa-bbbb-cccc-1234567890ab, Card D, 99999999999, 1.0",
      ),
    );
    const smi = inv.gpus.filter((g) => g.source === "nvidia-smi");
    expect(smi.map((g) => g.name)).toEqual(["Card A", "Card D"]);
    expect(smi[0]).toMatchObject({ uuid: null, driver: null });
    expect(smi[1]).toMatchObject({ memoryMb: null });
    expect(inv.gpus.filter((g) => g.source === "pci")).toHaveLength(1);
  });

  it("sanitizes hostile names (markup, shell metacharacters, control chars, 5 KB)", () => {
    const inv = parse(
      probe(
        "TUGRA_NVSMI 0, GPU-12345678-aaaa-bbbb-cccc-1234567890ab, <script>alert(1)</script>;`id`$(id)\u0007\u001b[31m, 1, 1.0",
        `TUGRA_NVSMI 1, GPU-12345678-aaaa-bbbb-cccc-1234567890ab, ${"A".repeat(5000)}, 1, 1.0`,
        "TUGRA_NVSMI 2, GPU-12345678-aaaa-bbbb-cccc-1234567890ab, <>;`, 1, 1.0",
      ),
    );
    for (const g of inv.gpus) {
      expect(g.name).toMatch(/^[A-Za-z0-9 ._,:()[\]/+-]+$/);
      expect(g.name.length).toBeLessThanOrEqual(64);
      expect(g.name.length).toBeGreaterThan(0);
    }
    expect(inv.gpus[0].name).not.toMatch(/[<>;`$]/);
    expect(inv.gpus[1].name).toHaveLength(64);
    expect(inv.gpus[2].name).toBe("NVIDIA GPU");
    expect(parseStoredInventory(inv)).not.toBeNull();
  });

  it("sanitizes a hostile procfs model and rejects a bad procfs uuid", () => {
    const inv = parse(probe("TUGRA_PCI 0000:01:00.0 0x10de 0x2684 0x030000", "TUGRA_NVPROC 0000:01:00.0|GPU-<x>|<img src=x onerror=1>RTX"));
    expect(inv.gpus[0].uuid).toBeNull();
    expect(inv.gpus[0].name).toBe("img src x onerror 1 RTX");
  });

  it("NVPROC for an unknown bdf is ignored", () => {
    const inv = parse(probe("TUGRA_PCI 0000:01:00.0 0x10de 0x2684 0x030000", "TUGRA_NVPROC 0000:09:00.0|GPU-12345678-aaaa-bbbb-cccc-1234567890ab|Other"));
    expect(inv.gpus[0].name).toBe("NVIDIA GPU [10de:2684]");
    expect(inv.nvidiaDriverLoaded).toBe(false);
  });

  it("drops runtime keys with spaces / junk, survives invalid runtimes JSON, and a __proto__ key pollutes nothing", () => {
    expect(parse(probe('TUGRA_RUNTIMES {"nvidia":{},"bad name":{},"a;b":{},"ok.1":{}}')).runtimes).toEqual(["nvidia", "ok.1"]);
    expect(parse(probe("TUGRA_RUNTIMES {not json")).runtimes).toEqual([]);
    expect(parse(probe("TUGRA_RUNTIMES [1,2]")).runtimes).toEqual([]);
    expect(parse(probe("TUGRA_RUNTIMES null")).runtimes).toEqual([]);
    const inv = parse(probe('TUGRA_RUNTIMES {"__proto__":{"polluted":true},"nvidia":{}}'));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(inv.nvidiaRuntime).toBe(true);
    expect(parse(probe("TUGRA_DEFRT bad name; x")).defaultRuntime).toBeNull();
  });

  it("caps the runtimes at 16 and the GPUs at 16", () => {
    const rts = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`rt${i}`, {}]));
    expect(parse(probe(`TUGRA_RUNTIMES ${JSON.stringify(rts)}`)).runtimes).toHaveLength(16);
    const lines = Array.from({ length: 30 }, (_, i) => `TUGRA_PCI 0000:${i.toString(16).padStart(2, "0")}:00.0 0x1002 0x73bf 0x030000`);
    expect(parse(probe(...lines)).gpus).toHaveLength(16);
  });

  it("returns null when the begin or end marker is missing", () => {
    expect(parseGpuProbe(`TUGRA_PCI 0000:01:00.0 0x10de 0x2684 0x030000\n${E}\n`)).toBeNull();
    expect(parseGpuProbe(`${B}\nTUGRA_PCI 0000:01:00.0 0x10de 0x2684 0x030000\n`)).toBeNull();
    expect(parseGpuProbe("")).toBeNull();
    expect(parseGpuProbe(`${E}\n${B}\n`)).toBeNull();
  });

  it("ignores docker noise and lines that are not line-anchored TUGRA_ tags", () => {
    const inv = parse(
      probe(
        "Unable to find image 'x' locally",
        "  TUGRA_PCI 0000:01:00.0 0x1002 0x73bf 0x030000",
        "noise TUGRA_PCI 0000:01:00.0 0x1002 0x73bf 0x030000",
        "TUGRA_UNKNOWN whatever",
        "TUGRA_PCI",
        "TUGRA_PCI 0000:02:00.0 0x1002 0x73bf 0x030000",
      ),
    );
    expect(inv.gpus.map((g) => g.pci)).toEqual(["0000:02:00.0"]);
  });

  it("'is already in use' returns busy", () => {
    expect(parseGpuProbe(probe(RT_NVIDIA, 'TUGRA_NVSMI_ERR rc=125 docker: Error response from daemon: Conflict. The container name "/tugra-gpuprobe" is already in use by container "abc".'))).toEqual({ busy: true });
  });

  it("an absent runtimes line means nvidiaRuntime false; NVSMI_ERR with no text gets a default", () => {
    expect(parse(probe("TUGRA_PCI 0000:03:00.0 0x1002 0x73bf 0x030000")).nvidiaRuntime).toBe(false);
    expect(parse(probe("TUGRA_NVSMI_ERR rc=1")).error).toBe("nvidia-smi failed (rc=1)");
  });

  it("caps and strips control chars from the probe error", () => {
    const inv = parse(probe(`TUGRA_NVSMI_ERR rc=1 ${"x".repeat(900)}\u0001\u0002`));
    expect(inv.error).toHaveLength(200);
    expect(inv.error).not.toMatch(/[\u0000-\u001f]/);
  });

  it("dedupes repeated PCI addresses and sorts by pci then index", () => {
    const inv = parse(
      probe("TUGRA_PCI 0000:03:00.0 0x1002 0x73bf 0x030000", "TUGRA_PCI 0000:01:00.0 0x1002 0x73bf 0x030000", "TUGRA_PCI 0000:03:00.0 0x1002 0x73bf 0x030000"),
    );
    expect(inv.gpus.map((g) => g.pci)).toEqual(["0000:01:00.0", "0000:03:00.0"]);
  });
});

const base: GpuInventory = { v: 1, gpus: [], runtimes: [], defaultRuntime: null, nvidiaRuntime: false, nvidiaDriverLoaded: false, nvidiaModuleVersion: null, error: null };
const smi = { index: 0, uuid: null, name: "N", vendor: "nvidia" as const, kind: "gpu" as const, memoryMb: 1, driver: "1.0", pci: null, source: "nvidia-smi" as const };
const pciNv = { ...smi, index: null, pci: "0000:01:00.0", source: "pci" as const };
const pciAmd = { ...pciNv, vendor: "amd" as const };
const virt = { ...pciNv, vendor: "other" as const, kind: "virtual" as const };

describe("classifyReadiness", () => {
  const cases: [string, GpuInventory | null, string][] = [
    ["null", null, "unknown"],
    ["error wins over rows", { ...base, error: "x", gpus: [smi], nvidiaRuntime: true }, "probe_failed"],
    ["smi + runtime", { ...base, gpus: [smi], nvidiaRuntime: true }, "ready"],
    ["smi without runtime", { ...base, gpus: [smi] }, "runtime_missing"],
    ["pci nvidia, no driver", { ...base, gpus: [pciNv] }, "driver_missing"],
    ["pci nvidia, driver, no runtime", { ...base, gpus: [pciNv], nvidiaDriverLoaded: true }, "runtime_missing"],
    ["pci nvidia, driver, runtime, no smi", { ...base, gpus: [pciNv], nvidiaDriverLoaded: true, nvidiaRuntime: true }, "probe_failed"],
    ["amd", { ...base, gpus: [pciAmd] }, "non_nvidia"],
    ["nvidia pci outranks amd", { ...base, gpus: [pciAmd, pciNv] }, "driver_missing"],
    ["virtual only", { ...base, gpus: [virt] }, "none"],
    ["empty", base, "none"],
  ];
  it.each(cases)("%s", (_n, inv, want) => {
    expect(classifyReadiness(inv)).toBe(want);
  });
});

describe("isGpuStale", () => {
  const now = new Date("2026-11-17T12:00:00Z");
  it("handles null, the exact boundary and beyond", () => {
    expect(isGpuStale(null, now)).toBe(false);
    expect(isGpuStale(new Date(now.getTime() - 600_000), now)).toBe(false);
    expect(isGpuStale(new Date(now.getTime() - 600_001), now)).toBe(true);
    expect(isGpuStale(new Date(now.getTime() - 5_000), now)).toBe(false);
    expect(isGpuStale(new Date(now.getTime() - 5_000), now, 1_000)).toBe(true);
  });
});

describe("parseStoredInventory", () => {
  it("accepts a valid snapshot and degrades null / malformed / wrong version to null", () => {
    expect(parseStoredInventory(base)).toEqual(base);
    expect(parseStoredInventory({ ...base, extra: 1 })).toEqual(base);
    expect(parseStoredInventory(null)).toBeNull();
    expect(parseStoredInventory(undefined)).toBeNull();
    expect(parseStoredInventory("x")).toBeNull();
    expect(parseStoredInventory({})).toBeNull();
    expect(parseStoredInventory({ ...base, v: 2 })).toBeNull();
    expect(parseStoredInventory({ ...base, gpus: [{ name: "" }] })).toBeNull();
    expect(parseStoredInventory({ ...base, runtimes: ["a b"] })).toBeNull();
  });
});
