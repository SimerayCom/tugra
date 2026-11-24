import { describe, it, expect } from "vitest";
import { planBulkCapabilities, togglePick } from "./bulk-capabilities";
import type { ServerView } from "./types";

const mk = (id: string, capabilities: string[], canWrite = true) => ({ id, name: `app-${id}`, capabilities, canWrite }) as unknown as ServerView;

describe("planBulkCapabilities", () => {
  const servers = [mk("1", ["deploy"]), mk("2", ["deploy", "terminal"]), mk("3", ["deploy"], false), mk("4", ["files", "files_write"])];
  const sel = new Set(["1", "2", "3", "4"]);

  it("lists only the capabilities a grant would add, and skips read-only servers", () => {
    const rows = planBulkCapabilities(servers, sel, "grant", ["terminal"]);
    expect(rows.map((r) => [r.id, r.changes, r.blocked])).toEqual([
      ["1", ["terminal"], null],
      ["2", [], null],
      ["3", [], "readonly"],
      ["4", ["terminal"], null],
    ]);
  });

  it("revoking files also revokes files_write", () => {
    const rows = planBulkCapabilities(servers, sel, "revoke", ["files"]);
    expect(rows.find((r) => r.id === "4")?.changes).toEqual(["files", "files_write"]);
    expect(rows.find((r) => r.id === "1")?.changes).toEqual([]);
  });

  it("refuses files_write without files for a server that has neither", () => {
    const rows = planBulkCapabilities(servers, sel, "grant", ["files_write"]);
    expect(rows.find((r) => r.id === "1")?.blocked).toBe("files_write_requires_files");
    expect(rows.find((r) => r.id === "4")?.blocked).toBeNull();
  });

  it("only looks at the selected servers", () => {
    expect(planBulkCapabilities(servers, new Set(["2"]), "revoke", ["terminal"])).toHaveLength(1);
  });
});

describe("togglePick", () => {
  it("granting files_write also picks files; unpicking files unpicks files_write", () => {
    expect(togglePick([], "files_write", "grant")).toEqual(["files", "files_write"]);
    expect(togglePick(["files", "files_write"], "files", "grant")).toEqual([]);
  });
  it("revoking keeps the picks independent (the hub drops files_write with files)", () => {
    expect(togglePick([], "files_write", "revoke")).toEqual(["files_write"]);
    expect(togglePick(["files", "files_write"], "files", "revoke")).toEqual(["files_write"]);
  });
});
