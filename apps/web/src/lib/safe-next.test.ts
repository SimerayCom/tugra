import { describe, it, expect } from "vitest";
import { safeNextPath } from "./safe-next";

describe("safeNextPath", () => {
  it("keeps a same-origin path with its query", () => {
    expect(safeNextPath("/oauth/authorize?client_id=a&state=b")).toBe("/oauth/authorize?client_id=a&state=b");
  });
  it.each(["https://evil.test", "//evil.test/x", "/\\evil.test", "javascript:alert(1)", "oauth/authorize", "", null, undefined, "/a\nb", "/a\\b"])("drops %s", (v) => {
    expect(safeNextPath(v as string | null | undefined)).toBeNull();
  });
});
