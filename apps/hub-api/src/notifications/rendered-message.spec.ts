import {
  escapeHtml,
  levelColorHex,
  levelColorInt,
  levelPriority,
  levelPriorityGotify,
  levelTag,
  plainToRendered,
  sanitizeHeader,
  sanitizeNtfyHeader,
  toPlain,
  type RenderedMessage,
} from "./rendered-message";

const rm = (over: Partial<RenderedMessage> = {}): RenderedMessage => ({
  level: "info",
  title: "T",
  summary: "S",
  fields: [],
  links: [],
  timestamp: "2026-01-01T00:00:00.000Z",
  event: "e",
  ...over,
});

describe("rendered-message helpers", () => {
  it("maps level → color (hex for Slack/SMTP, int for Discord)", () => {
    expect(levelColorHex("success")).toBe("#57f287");
    expect(levelColorInt("failure")).toBe(16740447); // parseInt("ff705f",16), NOT NaN
    expect(levelColorInt("success")).toBe(0x57f287);
  });

  it("maps level → ntfy tag + provider priorities", () => {
    expect(levelTag("failure")).toBe("rotating_light");
    expect(levelTag("success")).toBe("white_check_mark");
    expect(levelPriority("failure")).toBe(5);
    expect(levelPriority("info")).toBe(3);
    expect(levelPriorityGotify("failure")).toBe(8);
    expect(levelPriorityGotify("info")).toBe(3);
  });

  it("escapes HTML with the ampersand first", () => {
    expect(escapeHtml(`<b>&"'`)).toBe("&lt;b&gt;&amp;&quot;&#39;");
  });

  it("sanitizes an email header against CRLF injection", () => {
    const out = sanitizeHeader("Deploy failed\r\nBcc: evil@x.com");
    expect(out).not.toMatch(/[\r\n]/);
    expect(out).toContain("Deploy failed");
  });

  it("sanitizes an ntfy header to printable ASCII", () => {
    const out = sanitizeNtfyHeader("Tuğra ✅ ok");
    expect(out).not.toMatch(/[^\x20-\x7e]/);
    expect(out).not.toContain("ğ");
    expect(out).toContain("ok");
  });

  it("toPlain lists title, a distinct summary, then label:value lines", () => {
    const out = toPlain(rm({ title: "Deploy failed", summary: "app blog failed", fields: [{ label: "Project", value: "web" }] }));
    expect(out).toContain("Deploy failed");
    expect(out).toContain("app blog failed");
    expect(out).toContain("Project: web");
  });

  it("toPlain degrades to title+summary with no fields, and does not repeat an identical summary", () => {
    expect(toPlain(rm({ title: "A", summary: "B", fields: [] }))).toBe("A\n\nB");
    expect(toPlain(rm({ title: "same", summary: "same", fields: [] }))).toBe("same");
  });

  it("plainToRendered (shim) infers the level from a leading emoji", () => {
    expect(plainToRendered("✅ ok").level).toBe("success");
    expect(plainToRendered("🔴 down").level).toBe("failure");
    expect(plainToRendered("❌ nope").level).toBe("failure");
    expect(plainToRendered("⚠️ ssl expiring").level).toBe("warning");
    expect(plainToRendered("Backup failed for x").level).toBe("info"); // no emoji → info (Dilim 3 fixes)
    const m = plainToRendered("hi");
    expect(m.title).toBe("hi");
    expect(m.summary).toBe("hi");
    expect(m.fields).toEqual([]);
    expect(m.links).toEqual([]);
    expect(m.event).toBe("");
  });
});
