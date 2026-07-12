import { describe, it, expect } from "vitest";
import { parseAnsi } from "./ansi";

const ESC = "\x1b[";

describe("parseAnsi", () => {
  it("returns a single segment for a plain line", () => {
    expect(parseAnsi("hello world")).toEqual([{ text: "hello world" }]);
  });

  it("returns an empty segment for an empty line", () => {
    expect(parseAnsi("")).toEqual([{ text: "" }]);
  });

  it("maps a basic foreground color and resets", () => {
    expect(parseAnsi(`${ESC}31mred${ESC}0m tail`)).toEqual([
      { text: "red", color: "var(--c-r)" },
      { text: " tail" },
    ]);
  });

  it("handles bold", () => {
    expect(parseAnsi(`${ESC}1mbold${ESC}22m x`)).toEqual([
      { text: "bold", bold: true },
      { text: " x" },
    ]);
  });

  it("strips extended 256-color sequences without mis-coloring", () => {
    // 38;5;196 must be consumed whole (not mis-read as fg code 5/196)
    expect(parseAnsi(`${ESC}38;5;196mx${ESC}0m`)).toEqual([{ text: "x" }]);
  });

  it("leaves a malformed/truncated escape as literal text (never throws)", () => {
    expect(() => parseAnsi(`${ESC}`)).not.toThrow();
    expect(parseAnsi(`${ESC}`)).toEqual([{ text: ESC }]);
  });

  it("combines color + bold on the same run", () => {
    expect(parseAnsi(`${ESC}1;32mok${ESC}0m`)).toEqual([{ text: "ok", color: "var(--c-g)", bold: true }]);
  });
});
