import { describe, it, expect } from "vitest";
import { parseDotenv, toDotenv, duplicateKeys, invalidKeys } from "./dotenv";

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

describe("duplicateKeys", () => {
  it("returns keys that appear more than once (trimmed), first-seen order", () => {
    expect(duplicateKeys([
      { key: "A", value: "1" },
      { key: " A ", value: "2" },
      { key: "B", value: "3" },
      { key: "C", value: "4" },
      { key: "B", value: "5" },
    ])).toEqual(["A", "B"]);
  });

  it("ignores empty keys and returns [] when all keys are unique", () => {
    expect(duplicateKeys([{ key: "A", value: "1" }, { key: "", value: "x" }, { key: "", value: "y" }])).toEqual([]);
  });
});

describe("invalidKeys", () => {
  it("flags names that aren't valid env vars, de-duped", () => {
    expect(invalidKeys([
      { key: "GOOD_1", value: "" },
      { key: "_ok", value: "" },
      { key: "1BAD", value: "" },
      { key: "has space", value: "" },
      { key: "has space", value: "" },
      { key: "WITH-DASH", value: "" },
    ])).toEqual(["1BAD", "has space", "WITH-DASH"]);
  });

  it("returns [] when every key is a valid name", () => {
    expect(invalidKeys([{ key: "FOO", value: "" }, { key: "BAR_BAZ2", value: "" }])).toEqual([]);
  });
});
