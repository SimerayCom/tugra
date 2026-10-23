import { describe, it, expect } from "vitest";
import { collapseCarriageReturns } from "./log-lines";

describe("collapseCarriageReturns", () => {
  it("returns input unchanged when there is no carriage return", () => {
    const s = "line one\nline two\n";
    expect(collapseCarriageReturns(s)).toBe(s);
  });

  it("keeps only the final frame of a \\r-overwritten progress line", () => {
    const git = "Receiving objects:  10% (1/10)\rReceiving objects: 100% (10/10), done.";
    expect(collapseCarriageReturns(git)).toBe("Receiving objects: 100% (10/10), done.");
  });

  it("collapses a multi-frame pull line to its last state", () => {
    const pull = "abc Downloading [=>   ] 9MB\rabc Downloading [==> ] 22MB\rabc Download complete";
    expect(collapseCarriageReturns(pull)).toBe("abc Download complete");
  });

  it("collapses each line independently", () => {
    const s = "a1\ra2\nb1\rb2\nc";
    expect(collapseCarriageReturns(s)).toBe("a2\nb2\nc");
  });

  it("treats a trailing \\r as a CRLF line ending, not an overwrite-to-empty", () => {
    expect(collapseCarriageReturns("foo\r\nbar\r\n")).toBe("foo\nbar\n");
    expect(collapseCarriageReturns("a\rb\r\n")).toBe("b\n"); // interior overwrite + CRLF ending
  });
});
