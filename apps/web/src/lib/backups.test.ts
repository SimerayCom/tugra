import { describe, it, expect } from "vitest";
import { backupColor, formatDuration, formatSize, lastErrorLine, restoreColor } from "./backups";

describe("backup helpers", () => {
  it("maps backup status to a color", () => {
    expect(backupColor("SUCCESS")).toContain("--c-g");
    expect(backupColor("FAILED")).toContain("--c-r");
    expect(backupColor("RUNNING")).toContain("--c-am");
    expect(backupColor("PENDING")).toContain("--c-am");
    expect(restoreColor("SUCCESS")).toContain("--c-g");
    expect(restoreColor("FAILED")).toContain("--c-r");
    expect(restoreColor("RUNNING")).toContain("--c-am");
  });

  it("formats byte sizes", () => {
    expect(formatSize(null)).toBe("—");
    expect(formatSize("512")).toBe("512 B");
    expect(formatSize("20480")).toBe("20 KB");
    expect(formatSize("1572864")).toBe("1.5 MB");
  });

  it("formats run durations", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(-5)).toBe("—");
    expect(formatDuration(420)).toBe("420 ms");
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(200_000)).toBe("3m 20s");
  });

  it("picks the last non-empty line of a failure as the inline reason", () => {
    expect(lastErrorLine(null)).toBeNull();
    expect(lastErrorLine("  \n")).toBeNull();
    expect(lastErrorLine("pg_dump: starting\npg_dump: error: connection refused\n\n")).toBe("pg_dump: error: connection refused");
  });
});
