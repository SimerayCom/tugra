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

describe("dotenv round-trip is lossless", () => {
  // Every value a secret might actually hold. parseDotenv(toDotenv(rows)) must equal rows for each.
  const hard: Array<[string, string]> = [
    ["simple", "hello"],
    ["empty", ""],
    ["with spaces", "hello world"],
    ["leading/trailing space", "  padded  "],
    ["tab", "a\tb"],
    ["equals in value", "a=b=c"],
    ["url with query", "postgres://u:p@h:5432/db?sslmode=require&x=1"],
    ["double quote", 'say "hi"'],
    ["single quote", "it's fine"],
    ["backslash", "a\\b\\c"],
    ["literal backslash-n (not a newline)", "a\\nb"],
    ["hash", "pa$$#word"],
    ["newline", "line1\nline2"],
    ["crlf", "line1\r\nline2"],
    ["multi-line PEM", "-----BEGIN KEY-----\nabc\ndef\n-----END KEY-----"],
    ["json blob", '{"a":1,"b":"x y","c":[1,2]}'],
    ["only spaces", "   "],
    ["quote at edges", '"wrapped"'],
    ["mixed escapes", 'a"b\\c\td\ne'],
  ];
  for (const [name, value] of hard) {
    it(`round-trips ${name}`, () => {
      const rows = [{ key: "K", value }];
      expect(parseDotenv(toDotenv(rows))).toEqual(rows);
    });
  }

  it("round-trips a whole set at once", () => {
    const rows = [
      { key: "A", value: "1" },
      { key: "PEM", value: "-----BEGIN-----\nx\ny\n-----END-----" },
      { key: "JSON", value: '{"k":"v"}' },
      { key: "PLAIN", value: "nothing-special" },
    ];
    expect(parseDotenv(toDotenv(rows))).toEqual(rows);
  });
});

describe("parseDotenv quoting", () => {
  it("expands \\n \\r \\t \\\\ \\\" inside double quotes", () => {
    expect(parseDotenv('K="a\\nb\\tc\\\\d\\"e"')).toEqual([{ key: "K", value: 'a\nb\tc\\d"e' }]);
  });

  it("treats single quotes as literal (no escape expansion)", () => {
    expect(parseDotenv("K='a\\nb'")).toEqual([{ key: "K", value: "a\\nb" }]);
  });

  it("reads a double-quoted value that spans multiple physical lines", () => {
    expect(parseDotenv('K="line1\nline2\nline3"\nNEXT=ok')).toEqual([
      { key: "K", value: "line1\nline2\nline3" },
      { key: "NEXT", value: "ok" },
    ]);
  });

  it("keeps an unterminated quote lenient instead of throwing", () => {
    expect(parseDotenv('K="no closing quote')).toEqual([{ key: "K", value: "no closing quote" }]);
  });

  it("does not strip quote characters that are part of an unquoted value", () => {
    // Serializer would quote this, but a hand-pasted bare value keeps its inner quotes verbatim.
    expect(parseDotenv("K=a'b'c")).toEqual([{ key: "K", value: "a'b'c" }]);
  });

  it("keeps the backslash on an unknown escape (pasted Windows paths survive)", () => {
    expect(parseDotenv('P="C:\\path"')).toEqual([{ key: "P", value: "C:\\path" }]);
  });

  it("keeps an inline '#' in a value instead of truncating a secret", () => {
    expect(parseDotenv("K=hunter2 #1")).toEqual([{ key: "K", value: "hunter2 #1" }]);
  });
});

describe("parseDotenv robustness", () => {
  it("handles CRLF, lone-CR and LF line endings alike", () => {
    expect(parseDotenv("A=1\r\nB=2\rC=3\nD=4")).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "2" },
      { key: "C", value: "3" },
      { key: "D", value: "4" },
    ]);
  });

  it("strips an `export ` prefix separated by a tab or multiple spaces", () => {
    expect(parseDotenv("export\tFOO=bar\nexport   BAZ=qux")).toEqual([
      { key: "FOO", value: "bar" },
      { key: "BAZ", value: "qux" },
    ]);
  });

  it("strips trailing blanks in linear time (no ReDoS on a long whitespace run)", () => {
    // `y` + 50k spaces + `z`: the old /[ \t]+$/ backtracked O(n^2) here and froze the tab.
    const value = `y${" ".repeat(50000)}z`;
    const started = performance.now();
    expect(parseDotenv(`K=${value}`)).toEqual([{ key: "K", value }]);
    expect(performance.now() - started).toBeLessThan(500);
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
