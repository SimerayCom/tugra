import { describe, it, expect } from "vitest";
import en from "../i18n/locales/en";
import { translate } from "../i18n/translate";
import { heldFromError, heldSummary, inFlightHref, inFlightLines } from "./in-flight";
import { ApiError } from "./api";
import type { InFlightItem, InFlightKind } from "./types";

const t = (key: string, vars?: Record<string, string | number>) => translate(en as never, key, vars);
const item = (kind: InFlightKind, id = "x1", over: Partial<InFlightItem> = {}): InFlightItem => ({ kind, id, label: id, serverIds: ["s1"], teamId: "t1", since: "2026-11-27T10:00:00.000Z", ...over });

const KINDS: InFlightKind[] = [
  "migration-run", "takeover", "cutover", "project-move", "app-move", "volume-transfer", "object-migration", "cleanup", "import",
  "deployment", "backup", "restore", "pitr-restore", "restore-verify", "rollout", "agent-update", "swarm", "patch", "reboot", "bulk-command",
];

describe("in-flight wording", () => {
  it("every kind has a name in the English locale", () => {
    for (const k of KINDS) expect(t(`inFlight.kind.${k}`), k).not.toBe(`inFlight.kind.${k}`);
  });

  it("summarises by group with plurals: '2 migrations', '1 backup or restore'", () => {
    expect(heldSummary(t, [item("migration-run"), item("takeover", "t2")])).toBe("Held: 2 migrations in progress");
    expect(heldSummary(t, [item("migration-run"), item("backup", "b1"), item("restore", "r1"), item("deployment", "d1")])).toBe(
      "Held: 1 migration, 1 deployment, 2 backups or restores in progress",
    );
    expect(heldSummary(t, [item("patch"), item("reboot", "r")])).toBe("Held: 2 server operations in progress");
  });

  it("one plain line per item for text-only places, capped with a 'more' line", () => {
    const items = [1, 2, 3, 4].map((n) => item("backup", `b${n}`, { label: `db${n}` }));
    expect(inFlightLines(t, items, 2)).toBe("Backup: db1\nBackup: db2\nand 2 more");
  });
});

describe("inFlightHref", () => {
  it("links the kinds that have a page", () => {
    expect(inFlightHref(item("migration-run", "r1"))).toBe("/import/runs/r1");
    expect(inFlightHref(item("object-migration", "o1"))).toBe("/migrations/objects/o1");
    expect(inFlightHref(item("rollout", "ro1"))).toBe("/rollouts/ro1");
    expect(inFlightHref(item("swarm", "c1"))).toBe("/clusters/c1");
    expect(inFlightHref(item("takeover", "tk", { serverIds: ["s9"] }))).toBe("/servers/s9");
    expect(inFlightHref(item("reboot", "rb", { serverIds: ["s9"] }))).toBe("/servers/s9");
  });
  it("has no link for the rest (no invented routes)", () => {
    for (const k of ["cutover", "project-move", "app-move", "volume-transfer", "import", "deployment", "backup", "restore", "bulk-command"] as InFlightKind[]) expect(inFlightHref(item(k)), k).toBeNull();
    expect(inFlightHref(item("takeover", "tk", { serverIds: [] }))).toBeNull();
  });
});

describe("heldFromError", () => {
  it("reads the list out of a 409 migration-active", () => {
    const list = [item("backup")];
    expect(heldFromError(new ApiError(409, "x", "migration-active", { inFlight: list }))).toEqual(list);
    expect(heldFromError(new ApiError(409, "x", "migration-active", {}))).toEqual([]);
  });
  it("is null for any other error", () => {
    expect(heldFromError(new ApiError(409, "x", "other"))).toBeNull();
    expect(heldFromError(new ApiError(500, "x", "migration-active"))).toBeNull();
    expect(heldFromError(new Error("boom"))).toBeNull();
    expect(heldFromError(null)).toBeNull();
  });
});
