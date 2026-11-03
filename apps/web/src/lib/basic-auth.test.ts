import { describe, it, expect } from "vitest";
import { completeBasicAuthRows, hasIncompleteBasicAuthRow, canSaveBasicAuth, basicAuthSaveRemovesAll } from "./basic-auth";

describe("completeBasicAuthRows", () => {
  it("trims usernames and drops rows missing either field", () => {
    expect(
      completeBasicAuthRows([
        { user: " alice ", password: "pw" },
        { user: "bob", password: "" },
        { user: "", password: "pw" },
        { user: "  ", password: "pw" },
      ]),
    ).toEqual([{ user: "alice", password: "pw" }]);
  });
});

describe("hasIncompleteBasicAuthRow", () => {
  it("flags a row with exactly one field filled", () => {
    expect(hasIncompleteBasicAuthRow([{ user: "a", password: "" }])).toBe(true);
    expect(hasIncompleteBasicAuthRow([{ user: "", password: "pw" }])).toBe(true);
  });
  it("is false when every row is empty or complete", () => {
    expect(hasIncompleteBasicAuthRow([{ user: "", password: "" }])).toBe(false);
    expect(hasIncompleteBasicAuthRow([{ user: "a", password: "pw" }])).toBe(false);
    expect(hasIncompleteBasicAuthRow([])).toBe(false);
  });
});

describe("canSaveBasicAuth", () => {
  it("blocks a pristine empty form (no rows, no existing users) — the no-op wipe", () => {
    expect(canSaveBasicAuth([], 0)).toBe(false);
    expect(canSaveBasicAuth([{ user: "", password: "" }], 0)).toBe(false);
  });
  it("blocks while any row is half-typed", () => {
    expect(canSaveBasicAuth([{ user: "a", password: "" }], 0)).toBe(false);
    expect(canSaveBasicAuth([{ user: "a", password: "pw" }, { user: "b", password: "" }], 2)).toBe(false);
  });
  it("allows saving a complete row", () => {
    expect(canSaveBasicAuth([{ user: "a", password: "pw" }], 0)).toBe(true);
  });
  it("allows an empty save when users currently exist (an explicit removal)", () => {
    expect(canSaveBasicAuth([], 2)).toBe(true);
  });
});

describe("basicAuthSaveRemovesAll", () => {
  it("is true only when the save clears everything while users exist", () => {
    expect(basicAuthSaveRemovesAll([], 2)).toBe(true);
    expect(basicAuthSaveRemovesAll([{ user: "", password: "" }], 1)).toBe(true);
  });
  it("is false when a complete row survives or there is nothing to remove", () => {
    expect(basicAuthSaveRemovesAll([{ user: "a", password: "pw" }], 2)).toBe(false);
    expect(basicAuthSaveRemovesAll([], 0)).toBe(false);
  });
});
