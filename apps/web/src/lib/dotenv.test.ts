import { describe, it, expect } from "vitest";
import { parseDotenv, toDotenv } from "./dotenv";

describe("parseDotenv", () => {
  it("parses KEY=VALUE, export, and quoted values", () => {
    expect(parseDotenv("FOO=bar\nexport A=1\nB=\"x y\"\nC='z'")).toEqual([
      { key: "FOO", value: "bar" },
      { key: "A", value: "1" },
      { key: "B", value: "x y" },
      { key: "C", value: "z" },
    ]);
  });

  it("skips blanks and comments and empty keys", () => {
    expect(parseDotenv("\n# comment\n  \nFOO=bar\n=novalue\nNOEQ")).toEqual([
      { key: "FOO", value: "bar" },
    ]);
  });

  it("splits on the first = so values may contain =", () => {
    expect(parseDotenv("URL=postgres://u:p@h/db?a=b")).toEqual([
      { key: "URL", value: "postgres://u:p@h/db?a=b" },
    ]);
  });

  it("trims keys", () => {
    expect(parseDotenv("  KEY  = value")).toEqual([{ key: "KEY", value: "value" }]);
  });
});

describe("toDotenv", () => {
  it("serializes rows and drops empty keys, round-trips", () => {
    const rows = [{ key: "FOO", value: "bar" }, { key: "", value: "x" }, { key: "A", value: "1" }];
    expect(toDotenv(rows)).toBe("FOO=bar\nA=1");
    expect(parseDotenv(toDotenv(rows))).toEqual([
      { key: "FOO", value: "bar" },
      { key: "A", value: "1" },
    ]);
  });
});
