import { describe, it, expect } from "vitest";
import { buildRecoveryCodesFile, buildRecoveryCodesPrintHtml, recoveryCodesFilename } from "./recovery-codes-file";

const now = new Date("2026-12-01T10:20:30.000Z");
const labels = { title: "Recovery codes", hub: "Hub", created: "Created", hint: "Each code works once." };

describe("recoveryCodesFilename", () => {
  it("is tugra-recovery-codes-<host>-<date>.txt with a filename-safe host", () => {
    expect(recoveryCodesFilename("https://hub.acme.test", now)).toBe("tugra-recovery-codes-hub.acme.test-2026-12-01.txt");
    expect(recoveryCodesFilename("http://203.0.113.7:3000", now)).toBe("tugra-recovery-codes-203.0.113.7-3000-2026-12-01.txt");
  });
  it("survives an unparsable origin", () => {
    expect(recoveryCodesFilename("???", now)).toBe("tugra-recovery-codes-hub-2026-12-01.txt");
  });
});

describe("buildRecoveryCodesFile", () => {
  it("writes the hub address, creation date and every code", () => {
    const { filename, text } = buildRecoveryCodesFile({ codes: ["AAAA-1111", "BBBB-2222"], origin: "https://hub.acme.test", now, labels });
    expect(filename).toContain("hub.acme.test");
    expect(text).toContain("Hub: https://hub.acme.test");
    expect(text).toContain("Created: 2026-12-01T10:20:30.000Z");
    expect(text.split("\n")).toEqual(expect.arrayContaining(["AAAA-1111", "BBBB-2222"]));
  });
});

describe("buildRecoveryCodesPrintHtml", () => {
  it("lists the codes and escapes markup in labels and origin", () => {
    const html = buildRecoveryCodesPrintHtml({ codes: ["AAAA-1111"], origin: "https://x.test/<script>", now, labels: { ...labels, title: "A & B" } });
    expect(html).toContain("<li>AAAA-1111</li>");
    expect(html).toContain("A &amp; B");
    expect(html).not.toContain("<script>");
  });
});
