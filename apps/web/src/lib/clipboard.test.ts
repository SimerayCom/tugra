import { describe, it, expect, vi, afterEach } from "vitest";
import { copyText } from "./clipboard";

// jsdom does not define document.execCommand, so each fallback test assigns its own mock.
afterEach(() => {
  vi.restoreAllMocks();
  Object.assign(navigator, { clipboard: undefined });
  Object.assign(document, { execCommand: undefined });
});

describe("copyText", () => {
  it("uses the async Clipboard API in a secure context and returns true", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    await expect(copyText("hello")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to execCommand when the Clipboard API is absent (insecure http origin)", async () => {
    Object.assign(navigator, { clipboard: undefined });
    const exec = vi.fn().mockReturnValue(true);
    Object.assign(document, { execCommand: exec });
    await expect(copyText("x")).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
  });

  it("falls back to execCommand when the Clipboard API rejects (permission denied)", async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    const exec = vi.fn().mockReturnValue(true);
    Object.assign(document, { execCommand: exec });
    await expect(copyText("x")).resolves.toBe(true);
    expect(exec).toHaveBeenCalled();
  });

  it("returns false when the copy truly cannot happen (no API and execCommand fails)", async () => {
    Object.assign(navigator, { clipboard: undefined });
    Object.assign(document, { execCommand: vi.fn().mockReturnValue(false) });
    await expect(copyText("x")).resolves.toBe(false);
  });

  it("leaves no stray textarea in the DOM after the fallback", async () => {
    Object.assign(navigator, { clipboard: undefined });
    Object.assign(document, { execCommand: vi.fn().mockReturnValue(true) });
    await copyText("x");
    expect(document.querySelector("textarea")).toBeNull();
  });
});
