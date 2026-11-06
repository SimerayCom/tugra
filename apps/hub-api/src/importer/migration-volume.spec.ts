import {
  DEFAULT_MAX_VOLUME_BYTES,
  MAX_VOLUME_BYTES_CEILING,
  isValidVolumeName,
  maxDecodedVolumeBytes,
  maxVolumeBytes,
  scrubVolumeTail,
  volDataRef,
  volStageRef,
  volumeTimeoutMs,
} from "./migration-volume";

describe("maxVolumeBytes", () => {
  afterEach(() => {
    delete process.env.MIGRATION_MAX_VOLUME_BYTES;
  });
  it("defaults to 256 MiB when unset", () => {
    expect(maxVolumeBytes()).toBe(DEFAULT_MAX_VOLUME_BYTES);
    expect(DEFAULT_MAX_VOLUME_BYTES).toBe(256 * 1024 * 1024);
  });
  it("honors a valid override", () => {
    process.env.MIGRATION_MAX_VOLUME_BYTES = String(100 * 1024 * 1024);
    expect(maxVolumeBytes()).toBe(100 * 1024 * 1024);
  });
  it("clamps above the hard ceiling (512 MiB) — never past the coupled 5-min/stale window", () => {
    process.env.MIGRATION_MAX_VOLUME_BYTES = String(10 * 1024 * 1024 * 1024);
    expect(maxVolumeBytes()).toBe(MAX_VOLUME_BYTES_CEILING);
  });
  it("falls back to the default for garbage / zero / negative", () => {
    for (const bad of ["", "abc", "0", "-5", "NaN"]) {
      process.env.MIGRATION_MAX_VOLUME_BYTES = bad;
      expect(maxVolumeBytes()).toBe(DEFAULT_MAX_VOLUME_BYTES);
    }
  });
});

describe("volumeTimeoutMs", () => {
  it("is at least the 5-min base and never over the 8-min ceiling (< the 10-min stale reaper)", () => {
    expect(volumeTimeoutMs(0)).toBe(5 * 60_000);
    expect(volumeTimeoutMs(DEFAULT_MAX_VOLUME_BYTES)).toBeGreaterThan(5 * 60_000);
    expect(volumeTimeoutMs(DEFAULT_MAX_VOLUME_BYTES)).toBeLessThanOrEqual(8 * 60_000);
    expect(volumeTimeoutMs(10 * 1024 * 1024 * 1024)).toBe(8 * 60_000); // saturates at the ceiling
    expect(volumeTimeoutMs(-1)).toBe(5 * 60_000); // garbage floors at the base
    expect(volumeTimeoutMs(8 * 60_000)).toBeLessThan(10 * 60_000); // strictly under STALE_RUNNING_MS
  });
  it("scales monotonically with size", () => {
    expect(volumeTimeoutMs(50 * 1024 * 1024)).toBeLessThan(volumeTimeoutMs(200 * 1024 * 1024));
  });
});

describe("maxDecodedVolumeBytes", () => {
  const GiB = 1024 * 1024 * 1024;
  it("floors at 1 GiB for small compressed inputs (no false-reject of compressible volumes)", () => {
    expect(maxDecodedVolumeBytes(10 * 1024 * 1024)).toBe(1 * GiB); // 10 MiB * 50 < 1 GiB → floor
    expect(maxDecodedVolumeBytes(0)).toBe(1 * GiB);
    expect(maxDecodedVolumeBytes(-5)).toBe(1 * GiB);
  });
  it("is ~50x the compressed size in the middle band", () => {
    expect(maxDecodedVolumeBytes(100 * 1024 * 1024)).toBe(100 * 1024 * 1024 * 50); // 5 GiB
  });
  it("ceilings at 8 GiB so a gzip bomb can never fill the target disk", () => {
    expect(maxDecodedVolumeBytes(256 * 1024 * 1024)).toBe(8 * GiB); // 256 MiB * 50 = 12.5 GiB → clamped
    expect(maxDecodedVolumeBytes(10 * GiB)).toBe(8 * GiB);
  });
});

describe("isValidVolumeName", () => {
  it("accepts the names the declare step can produce", () => {
    for (const ok of ["data", "a", "db-data", "cache_1", "x".repeat(41)]) expect(isValidVolumeName(ok)).toBe(true);
  });
  it("rejects traversal, uppercase, leading punctuation, over-length and non-strings", () => {
    for (const bad of ["", "..", "../etc", "Data", "-x", "_x", "a b", "a/b", "x".repeat(42), 5, null, undefined, {}]) {
      expect(isValidVolumeName(bad as unknown)).toBe(false);
    }
  });
});

describe("ref builders", () => {
  it("compose a per-volume stage ref and its sibling data ref (no parsing ever needed)", () => {
    expect(volStageRef("app:srv1:a1", "data")).toBe("vol:app:srv1:a1:data");
    expect(volDataRef("app:srv1:a1", "data")).toBe("data:vol:app:srv1:a1:data");
    expect(volDataRef("app:srv1:a1", "data")).toBe(`data:${volStageRef("app:srv1:a1", "data")}`);
  });
});

describe("scrubVolumeTail", () => {
  it("strips the signed capability URL and sig/exp fragments and bounds length", () => {
    const leak = "curl: (22) https://hub.example/api/v1/import/migration/dl/ckxyz.bin?exp=123&sig=SECRETSIG failed";
    const out = scrubVolumeTail(leak);
    expect(out).not.toMatch(/https?:\/\//);
    expect(out).not.toContain("SECRETSIG");
    expect(out).not.toMatch(/sig=[^<]/);
    expect(scrubVolumeTail("x".repeat(5000)).length).toBe(2000);
    expect(scrubVolumeTail(undefined as unknown as string)).toBe("");
  });
});
