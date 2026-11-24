import { describe, it, expect } from "vitest";
import { dayColor, incidentDuration, overallTone, suggestSlug, validSlug } from "./status-page";

const t = (k: string, v?: Record<string, string | number>) => `${k}:${v?.n ?? ""}`;

describe("status page helpers", () => {
  it("suggests a valid address from a team name", () => {
    expect(suggestSlug("Acme Inc.")).toBe("acme-inc");
    expect(suggestSlug("  Çalışma Ekibi ")).toBe("calisma-ekibi");
    expect(suggestSlug("A")).toBe("a-page");
    expect(suggestSlug("")).toBe("status-page");
    expect(validSlug(suggestSlug("x".repeat(80)))).toBe(true);
    expect(suggestSlug("x".repeat(80)).length).toBeLessThanOrEqual(40);
  });

  it("validates addresses", () => {
    for (const ok of ["acme", "acme-status", "a1b"]) expect(validSlug(ok)).toBe(true);
    for (const bad of ["ab", "-acme", "acme-", "Acme", "a_b_c", "a b c", "x".repeat(41)]) expect(validSlug(bad)).toBe(false);
  });

  it("words an incident length in minutes, hours or days", () => {
    const at = (min: number) => new Date(Date.UTC(2026, 0, 1, 0, min)).toISOString();
    expect(incidentDuration(at(0), at(0), t)).toBe("statusPage.durationMinutes:1");
    expect(incidentDuration(at(0), at(12), t)).toBe("statusPage.durationMinutes:12");
    expect(incidentDuration(at(0), at(180), t)).toBe("statusPage.durationHours:3");
    expect(incidentDuration(at(0), at(60 * 24 * 3), t)).toBe("statusPage.durationDays:3");
  });

  it("colours the banner and the day bars", () => {
    expect(overallTone("operational")).toBe("ok");
    expect(overallTone("outage")).toBe("danger");
    expect(overallTone("maintenance")).toBe("warn");
    expect(overallTone("unknown")).toBe("muted");
    expect(dayColor(null)).toBe("var(--c-bd)");
    expect(dayColor(100)).toBe("var(--c-g)");
    expect(dayColor(99.5)).toBe("var(--c-am)");
    expect(dayColor(80)).toBe("var(--c-r)");
  });
});
