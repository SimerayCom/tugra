import { describe, it, expect } from "vitest";
import type { TakeoverItemView } from "@tugra/shared";
import { inPlaceBusy, outcomeCounts, outcomeOf, outcomeTone, rowsOf, stagesOf, stepNoteKey } from "./inplace-run";

const dom = (temp: "pending" | "ok" | "failed") => ({ host: "a.example.com", tempCheck: temp, finalCheck: "pending" as const, cert: "pending" as const });
const it0 = (o: Partial<TakeoverItemView> = {}): TakeoverItemView => ({ itemRef: "app:s:a", name: "a", buildMode: "reuse-image", domains: [dom("ok")], ...o });

describe("outcomeOf", () => {
  it("reuse is the default road", () => {
    expect(outcomeOf(it0())).toBe("reused");
  });
  it("a rebuild is verified only when every domain answered like Coolify's copy", () => {
    expect(outcomeOf(it0({ buildMode: "rebuild-verify" }))).toBe("rebuilt_verified");
    expect(outcomeOf(it0({ buildMode: "rebuild-verify", domains: [dom("ok"), dom("pending")] }))).toBe("rebuilding");
    expect(outcomeOf(it0({ buildMode: "rebuild-verify", domains: [dom("ok"), dom("failed")] }))).toBe("rebuilt_check_failed");
  });
  it("a rebuild with no domain to check is never called verified", () => {
    expect(outcomeOf(it0({ buildMode: "rebuild-verify", domains: [] }))).toBe("rebuilding");
  });
  it("a failed build is its own outcome, any other skip is just left out", () => {
    expect(outcomeOf(it0({ buildMode: "rebuild-verify", skipped: true, issues: ["rebuild_failed"] }))).toBe("rebuild_failed");
    expect(outcomeOf(it0({ skipped: true, issues: ["container_absent"] }))).toBe("skipped");
  });
  it("an app that shares data keeps the image and says a rebuild was asked for", () => {
    expect(outcomeOf(it0({ exclusive: true, rebuildDeclined: true }))).toBe("rebuild_declined");
  });
  it("a database is never counted as a rebuild", () => {
    expect(outcomeOf(it0({ kind: "database", buildMode: "reuse-image" }))).toBe("database");
    expect(outcomeOf(it0({ kind: "database", skipped: true }))).toBe("skipped");
  });
  it("tones: problems are red, going on is amber", () => {
    expect(outcomeTone("rebuild_failed")).toBe("danger");
    expect(outcomeTone("rebuilt_check_failed")).toBe("danger");
    expect(outcomeTone("rebuilding")).toBe("warn");
    expect(outcomeTone("rebuilt_verified")).toBe("ok");
  });
});

describe("outcomeCounts and rowsOf", () => {
  const items = [
    it0({ itemRef: "app:s:1" }),
    it0({ itemRef: "app:s:2", buildMode: "rebuild-verify" }),
    it0({ itemRef: "database:s:pg", kind: "database" }),
    it0({ itemRef: "app:s:3", skipped: true, issues: ["no_domain"] }),
  ];
  it("counts apps and databases apart", () => {
    expect(outcomeCounts(items)).toEqual({ apps: 3, reused: 1, rebuiltVerified: 1, rebuilding: 0, problems: 0, declined: 0, skipped: 1, databases: 1 });
  });
  it("lists apps first and databases after, keeping the hub's order", () => {
    expect(rowsOf({ items }).map((r) => r.item.itemRef)).toEqual(["app:s:1", "app:s:2", "app:s:3", "database:s:pg"]);
  });
  it("nothing is nothing", () => {
    expect(outcomeCounts([]).apps).toBe(0);
  });
});

describe("stagesOf", () => {
  const states = (s: Parameters<typeof stagesOf>[0], v = false) => stagesOf(s, v).map((x) => x.state);
  it("walks forward", () => {
    expect(states("PLANNED")).toEqual(["current", "todo", "todo", "todo"]);
    expect(states("TESTING")).toEqual(["done", "current", "todo", "todo"]);
    expect(states("SWAPPING")).toEqual(["done", "done", "current", "todo"]);
    expect(states("SWAPPED")).toEqual(["done", "done", "current", "todo"]);
    expect(states("VERIFIED")).toEqual(["done", "done", "done", "done"]);
    expect(states("SWAPPED", true)).toEqual(["done", "done", "done", "done"]);
  });
  it("a give back or a failure is stopped, never progress", () => {
    for (const s of ["GIVING_BACK", "GIVEN_BACK", "FAILED"] as const) expect(states(s)).toEqual(["stopped", "todo", "todo", "todo"]);
  });
  it("busy only while the takeover moves by itself", () => {
    expect(["TESTING", "SWAPPING", "SWAPPED", "GIVING_BACK"].map((s) => inPlaceBusy(s as never))).toEqual([true, true, true, true]);
    expect(["PLANNED", "VERIFIED", "GIVEN_BACK", "FAILED"].map((s) => inPlaceBusy(s as never))).toEqual([false, false, false, false]);
    expect(inPlaceBusy(null)).toBe(false);
    expect(inPlaceBusy(undefined)).toBe(false);
  });
});

describe("stepNoteKey", () => {
  it("only DEPLOY_DARK, VERIFY and CUTOVER carry a note, and none without a takeover", () => {
    expect(stepNoteKey("DEPLOY_DARK", null)).toBeNull();
    expect(stepNoteKey("IMPORT", "TESTING")).toBeNull();
    expect(stepNoteKey("DEPLOY_DARK", "TESTING")).toBe("inPlaceRun.stepNote.DEPLOY_DARK.tested");
    expect(stepNoteKey("DEPLOY_DARK", "SWAPPED")).toBe("inPlaceRun.stepNote.DEPLOY_DARK.done");
    expect(stepNoteKey("VERIFY", "TESTING")).toBe("inPlaceRun.stepNote.VERIFY.review");
    expect(stepNoteKey("VERIFY", "SWAPPED")).toBeNull();
    expect(stepNoteKey("CUTOVER", "SWAPPED")).toBe("inPlaceRun.stepNote.CUTOVER.swapped");
    expect(stepNoteKey("CUTOVER", "TESTING")).toBeNull();
    expect(stepNoteKey("CUTOVER", "FAILED")).toBe("inPlaceRun.stepNote.CUTOVER.failed");
  });
});
