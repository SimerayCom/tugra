import { describe, it, expect } from "vitest";
import { cleanDomain } from "./domain";

describe("cleanDomain", () => {
  it("strips scheme, path and trailing slash", () => {
    expect(cleanDomain("https://app.example.com/")).toBe("app.example.com");
    expect(cleanDomain("http://app.example.com/path?q=1")).toBe("app.example.com");
  });

  it("trims, lowercases and drops a trailing dot", () => {
    expect(cleanDomain("  APP.Example.COM.  ")).toBe("app.example.com");
  });

  it("leaves a bare domain untouched", () => {
    expect(cleanDomain("app.example.com")).toBe("app.example.com");
  });
});
