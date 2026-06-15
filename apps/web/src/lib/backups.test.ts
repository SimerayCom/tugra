import { describe, it, expect } from "vitest";
import { backupColor, formatSize } from "./backups";

describe("backup helpers", () => {
  it("maps backup status to a color", () => {
    expect(backupColor("SUCCESS")).toContain("--c-g");
    expect(backupColor("FAILED")).toContain("--c-r");
    expect(backupColor("RUNNING")).toContain("--c-am");
    expect(backupColor("PENDING")).toContain("--c-am");
  });

  it("formats byte sizes", () => {
    expect(formatSize(null)).toBe("—");
    expect(formatSize("512")).toBe("512 B");
    expect(formatSize("20480")).toBe("20 KB");
    expect(formatSize("1572864")).toBe("1.5 MB");
  });
});
