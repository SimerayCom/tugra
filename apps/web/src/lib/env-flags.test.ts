import { describe, it, expect } from "vitest";
import {
  BUILD_TOTAL_MAX_BYTES, ML_KEYS_MAX, ML_TOTAL_MAX_BYTES, ML_VALUE_MAX_BYTES, applyBulkFlags, budgetIssues, canonicalFlags, flagsEqual,
  flagsPayload, isDefaultFlags, lineCount, looksSensitiveKey, rowIssues,
} from "./env-flags";

const git = { applicable: { buildTime: true, literal: false } };
const compose = { applicable: { buildTime: false, literal: true } };
const codes = (row: Parameters<typeof rowIssues>[0], ctx = git) => rowIssues(row, ctx).map((i) => i.code);

describe("pinned limits (must match the hub)", () => {
  it("numbers", () => {
    expect(ML_VALUE_MAX_BYTES).toBe(16384);
    expect(ML_KEYS_MAX).toBe(32);
    expect(ML_TOTAL_MAX_BYTES).toBe(49152);
    expect(BUILD_TOTAL_MAX_BYTES).toBe(49152);
  });
});

describe("canonicalFlags / flagsEqual", () => {
  it("fills defaults and ignores key order and omitted fields", () => {
    expect(canonicalFlags()).toEqual({ buildTime: false, runtime: true, literal: false, multiline: false });
    expect(flagsEqual({ multiline: true, runtime: true }, { multiline: true })).toBe(true);
    expect(flagsEqual({ buildTime: true }, {})).toBe(false);
    expect(flagsEqual(undefined, { runtime: true })).toBe(true);
    expect(isDefaultFlags({ literal: false })).toBe(true);
    expect(isDefaultFlags({ runtime: false })).toBe(false);
  });
});

describe("rowIssues", () => {
  it("clean rows have no issues", () => {
    expect(codes({ key: "A", value: "x" })).toEqual([]);
    expect(codes({ key: "PEM", value: "a\nb", flags: { multiline: true } })).toEqual([]);
  });
  it("a line break without Multiline, and NUL", () => {
    expect(codes({ key: "A", value: "a\nb" })).toEqual(["newline"]);
    expect(codes({ key: "A", value: "a\rb" })).toEqual(["newline"]);
    expect(codes({ key: "A", value: "a\u0000b", flags: { multiline: true } })).toEqual(["nul"]);
  });
  it("multiline key must be strict POSIX; size boundary in bytes", () => {
    expect(codes({ key: "a.b", value: "x", flags: { multiline: true } })).toEqual(["multilineKey"]);
    expect(codes({ key: "K", value: "a".repeat(ML_VALUE_MAX_BYTES), flags: { multiline: true } })).toEqual([]);
    expect(codes({ key: "K", value: "a".repeat(ML_VALUE_MAX_BYTES + 1), flags: { multiline: true } })).toEqual(["tooLarge"]);
    expect(codes({ key: "K", value: "é".repeat(ML_VALUE_MAX_BYTES / 2 + 1), flags: { multiline: true } })).toEqual(["tooLarge"]);
  });
  it("literal key only matters where literal applies", () => {
    expect(codes({ key: "a.b", value: "x", flags: { literal: true } }, compose)).toEqual(["literalKey"]);
    expect(codes({ key: "a.b", value: "x", flags: { literal: true } }, git)).toEqual([]);
  });
  it("build-time: source, key and the runtime-off rule", () => {
    expect(codes({ key: "K", value: "x", flags: { buildTime: true } }, compose)).toEqual(["buildSource"]);
    expect(codes({ key: "a.b", value: "x", flags: { buildTime: true } })).toEqual(["buildKey"]);
    expect(codes({ key: "K", value: "x", flags: { runtime: false } })).toEqual(["runtimeOffNeedsBuild"]);
    expect(codes({ key: "K", value: "x", flags: { buildTime: true, runtime: false } })).toEqual([]);
  });
});

describe("budgetIssues", () => {
  it("multiline count and total, build total", () => {
    const many = Array.from({ length: ML_KEYS_MAX + 1 }, (_, i) => ({ key: `K${i}`, value: "x", flags: { multiline: true } }));
    expect(budgetIssues(many.slice(0, ML_KEYS_MAX))).toEqual([]);
    expect(budgetIssues(many).map((b) => b.i18nKey)).toEqual(["envMultilineBudget"]);
    const big = ["A", "B", "C", "D"].map((k) => ({ key: k, value: "x".repeat(15 * 1024), flags: { multiline: true } }));
    expect(budgetIssues(big).map((b) => b.i18nKey)).toEqual(["envMultilineBudget"]);
    expect(budgetIssues([{ key: "K", value: "x".repeat(BUILD_TOTAL_MAX_BYTES), flags: { buildTime: true } }]).map((b) => b.i18nKey)).toEqual(["envBuildBudget"]);
  });
});

describe("applyBulkFlags / flagsPayload", () => {
  it("keeps existing flags for kept keys, auto-enables Multiline for line breaks and counts them", () => {
    const prev = [{ key: "A", flags: canonicalFlags({ literal: true }) }];
    const { rows, autoCount } = applyBulkFlags([{ key: "A", value: "1" }, { key: "PEM", value: "x\ny" }, { key: "B", value: "2" }], prev);
    expect(rows.map((r) => r.flags.literal)).toEqual([true, false, false]);
    expect(rows.map((r) => r.flags.multiline)).toEqual([false, true, false]);
    expect(autoCount).toBe(1);
  });
  it("payload is sparse and a later duplicate wins", () => {
    expect(flagsPayload([{ key: "A" }, { key: "B", flags: { multiline: true } }, { key: " ", flags: { multiline: true } }])).toEqual({
      B: { buildTime: false, runtime: true, literal: false, multiline: true },
    });
    expect(flagsPayload([{ key: "B", flags: { multiline: true } }, { key: "B" }])).toEqual({});
  });
});

describe("misc", () => {
  it("lineCount and looksSensitiveKey", () => {
    expect(lineCount("")).toBe(0);
    expect(lineCount("a\r\nb\nc")).toBe(3);
    expect(looksSensitiveKey("API_TOKEN")).toBe(true);
    expect(looksSensitiveKey("PUBLIC_URL")).toBe(false);
  });
});
