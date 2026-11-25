import { describe, it, expect } from "vitest";
import type { CleanupView } from "@tugra/shared";
import { ApiError } from "./api";
import { canOfferConfirm, cleanupErrorKey, cleanupFailureKey, rowNeedsAttention, sizeText, splitRemnants } from "./coolify-cleanup";

const view = (over: Partial<CleanupView> = {}): CleanupView => ({
  id: "c1", serverId: "s1", status: "READY", completeness: [], remnants: [{ kind: "container", name: "coolify-proxy", sizeBytes: null }], listHash: "a".repeat(64), results: [], complete: true, failureCode: null, confirmedAt: null, cleanedAt: null, createdAt: "2026-11-26T00:00:00Z", ...over,
});

describe("cleanupErrorKey", () => {
  it("uses the hub's stable code when it has a line, else the status", () => {
    expect(cleanupErrorKey(new ApiError(409, "x", "list_changed"))).toBe("coolifyCleanup.error.list_changed");
    expect(cleanupErrorKey(new ApiError(409, "x", "incomplete"))).toBe("coolifyCleanup.error.incomplete");
    expect(cleanupErrorKey(new ApiError(403, "only a team owner"))).toBe("coolifyCleanup.error.forbidden");
    expect(cleanupErrorKey(new ApiError(503, "agent offline"))).toBe("coolifyCleanup.error.offline");
    expect(cleanupErrorKey(new ApiError(500, "boom"))).toBe("coolifyCleanup.error.generic");
    expect(cleanupErrorKey(new Error("x"))).toBe("coolifyCleanup.error.generic");
  });
});

describe("cleanupFailureKey", () => {
  it("maps a stored code and nothing to nothing", () => {
    expect(cleanupFailureKey("partial")).toBe("coolifyCleanup.failure.partial");
    expect(cleanupFailureKey(null)).toBeNull();
  });
});

describe("splitRemnants / rowNeedsAttention", () => {
  it("splits what will be removed from what is kept", () => {
    const { removable, kept } = splitRemnants([{ kind: "container", name: "a", sizeBytes: null }, { kind: "directory", name: "/data/coolify/backups", sizeBytes: 1, keep: true, reason: "user_data" }]);
    expect(removable.map((r) => r.name)).toEqual(["a"]);
    expect(kept.map((r) => r.name)).toEqual(["/data/coolify/backups"]);
  });
  it("a row needs attention when something is missing or unreadable or short", () => {
    expect(rowNeedsAttention({ kind: "application", coolify: 1, tugra: 1, missing: [] })).toBe(false);
    expect(rowNeedsAttention({ kind: "application", coolify: 1, tugra: 0, missing: ["a"] })).toBe(true);
    expect(rowNeedsAttention({ kind: "volume", coolify: 0, tugra: 0, missing: [], unreadable: true })).toBe(true);
  });
});

describe("canOfferConfirm", () => {
  it("only a READY, complete cleanup with something to remove and a list fingerprint", () => {
    expect(canOfferConfirm(view())).toBe(true);
    expect(canOfferConfirm(view({ status: "INCOMPLETE" }))).toBe(false);
    expect(canOfferConfirm(view({ complete: false }))).toBe(false);
    expect(canOfferConfirm(view({ listHash: null }))).toBe(false);
    expect(canOfferConfirm(view({ remnants: [{ kind: "directory", name: "/data/coolify/backups", sizeBytes: 1, keep: true, reason: "user_data" }] }))).toBe(false);
    expect(canOfferConfirm(view({ status: "CLEANING" }))).toBe(false);
    expect(canOfferConfirm(null)).toBe(false);
  });
});

describe("sizeText", () => {
  it("is short", () => {
    expect(sizeText(null)).toBe("");
    expect(sizeText(512)).toBe("512 B");
    expect(sizeText(1536)).toBe("1.5 KB");
    expect(sizeText(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
