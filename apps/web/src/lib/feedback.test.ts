import { describe, it, expect } from "vitest";
import {
  issueTitle,
  formatDiagnostics,
  formatReportBody,
  githubIssueUrl,
  willTruncateIssueUrl,
  sanitizeRoutePath,
  formatReportFile,
  type FeedbackDiagnostics,
} from "./feedback";

const diag: FeedbackDiagnostics = {
  edition: "community",
  version: "0.1.0-beta.7",
  browser: "Mozilla/5.0 (X11; Linux x86_64)",
  language: "en-US",
  viewport: "1440×900",
  route: "/apps/abc123",
  capturedAt: "2026-11-11T08:00:00.000Z",
};

describe("issueTitle", () => {
  it("prefixes the category and uses the first line", () => {
    expect(issueTitle("bug", "Deploy fails\nmore detail")).toBe("[Bug] Deploy fails");
    expect(issueTitle("idea", "Add dark terminal")).toBe("[Idea] Add dark terminal");
    expect(issueTitle("question", "")).toBe("[Question]");
  });
  it("truncates a very long first line", () => {
    const title = issueTitle("bug", "x".repeat(200));
    expect(title.startsWith("[Bug] ")).toBe(true);
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(6 + 80);
  });
});

describe("formatDiagnostics", () => {
  it("shows version (with edition) when known", () => {
    expect(formatDiagnostics(diag)).toContain("- Tugra: 0.1.0-beta.7 (community)");
  });
  it("falls back to edition-only when version is unknown", () => {
    const d = formatDiagnostics({ ...diag, version: undefined });
    expect(d).toContain("- Edition: community");
    expect(d).not.toContain("- Tugra:");
  });
  it("omits the id line entirely when neither is known", () => {
    const d = formatDiagnostics({ ...diag, version: undefined, edition: undefined });
    expect(d).not.toContain("- Tugra:");
    expect(d).not.toContain("- Edition:");
    expect(d).toContain("- Browser:");
  });
});

describe("formatReportBody", () => {
  it("is just the message when no diagnostics are attached", () => {
    expect(formatReportBody("hello", undefined)).toBe("hello");
  });
  it("appends the diagnostics block only when provided", () => {
    const body = formatReportBody("hello", diag);
    expect(body.startsWith("hello\n\n---\n")).toBe(true);
    expect(body).toContain("- Page: /apps/abc123");
  });
  it("falls back for an empty message", () => {
    expect(formatReportBody("   ", undefined)).toBe("(no description provided)");
  });
  it("never contains secret-looking material beyond what the caller passed", () => {
    // The body is message + known diag fields only — no tokens, no query string, no IPs.
    const body = formatReportBody("my app broke", diag);
    expect(body).not.toMatch(/token|password|secret|authorization|bearer/i);
    expect(body).not.toContain("?"); // route is a path only; no query string leaks in
  });
});

describe("githubIssueUrl", () => {
  it("builds a new-issue URL with encoded title and body", () => {
    const url = githubIssueUrl("SimerayCom/tugra", "bug", "Deploy fails on arm", diag);
    expect(url.startsWith("https://github.com/SimerayCom/tugra/issues/new?")).toBe(true);
    const qs = new URLSearchParams(url.split("?")[1]);
    expect(qs.get("title")).toBe("[Bug] Deploy fails on arm");
    expect(qs.get("body")).toContain("Deploy fails on arm");
    expect(qs.get("body")).toContain("- Browser:");
  });
  it("omits diagnostics from the body when not attached", () => {
    const url = githubIssueUrl("SimerayCom/tugra", "idea", "nice to have", undefined);
    const qs = new URLSearchParams(url.split("?")[1]);
    expect(qs.get("body")).toBe("nice to have");
  });
});

describe("formatReportFile", () => {
  it("starts with a title heading and includes the body", () => {
    const file = formatReportFile("bug", "it broke", diag);
    expect(file.startsWith("# [Bug] it broke\n")).toBe(true);
    expect(file).toContain("- Captured: 2026-11-11T08:00:00.000Z");
  });
});

describe("sanitizeRoutePath", () => {
  it("collapses numeric, uuid and long opaque (cuid/token) segments to :id", () => {
    expect(sanitizeRoutePath("/teams/42")).toBe("/teams/:id");
    expect(sanitizeRoutePath("/apps/550e8400-e29b-41d4-a716-446655440000")).toBe("/apps/:id");
    expect(sanitizeRoutePath("/apps/clh3x9k2a0001abcd1234efgh")).toBe("/apps/:id");
    expect(sanitizeRoutePath("/invite/aVeryLongOpaqueToken1234567890")).toBe("/invite/:id");
  });
  it("leaves plain static paths alone", () => {
    expect(sanitizeRoutePath("/settings")).toBe("/settings");
    expect(sanitizeRoutePath("/apps")).toBe("/apps");
  });
  it("strips any query string or hash", () => {
    expect(sanitizeRoutePath("/settings?tab=instance#email")).toBe("/settings");
  });
});

describe("githubIssueUrl length cap", () => {
  const huge = "x".repeat(50_000);
  it("flags when the URL would be too long", () => {
    expect(willTruncateIssueUrl("SimerayCom/tugra", "bug", "short note", diag)).toBe(false);
    expect(willTruncateIssueUrl("SimerayCom/tugra", "bug", huge, diag)).toBe(true);
  });
  it("truncates an over-long message and keeps the URL under the cap, with a pointer to Download", () => {
    const url = githubIssueUrl("SimerayCom/tugra", "bug", huge, diag);
    expect(url.length).toBeLessThanOrEqual(7000);
    const body = new URLSearchParams(url.split("?")[1]).get("body") ?? "";
    expect(body).toContain("truncated");
    expect(body).toContain("Download report");
  });
});

describe("issueTitle surrogate safety", () => {
  it("does not split an emoji at the truncation boundary (no replacement char)", () => {
    const msg = "a".repeat(76) + "😀".repeat(10); // boundary lands amid the emoji run
    const title = issueTitle("bug", msg);
    expect(title).not.toContain("�");
    // encoding round-trips cleanly (a lone surrogate would throw / produce U+FFFD)
    expect(decodeURIComponent(encodeURIComponent(title))).toBe(title);
  });
});
