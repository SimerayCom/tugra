import { describe, it, expect } from "vitest";
import type { TakeoverItemView } from "@tugra/shared";
import { appStateOf, domainEvidence, inPlaceBusy, itemIconHints, nextHeadingKey, outcomeCounts, outcomeOf, outcomeTone, rowsOf, runStateKey, siteCounts, stageLine, stagesOf, stepNoteKey, stepTitleKey } from "./inplace-run";

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

describe("appStateOf: one phrase per app, from what was measured", () => {
  const live = { host: "a.example.com", tempCheck: "ok" as const, finalCheck: "ok" as const, cert: "issued" as const };
  it("before the switch: checking until every domain answers like Coolify, then the same, a failed domain needs a look", () => {
    expect(appStateOf(it0({ domains: [dom("pending")] }), "TESTING")).toBe("checking");
    expect(appStateOf(it0({ domains: [dom("ok"), dom("pending")] }), "TESTING")).toBe("checking");
    expect(appStateOf(it0({ domains: [dom("ok")] }), "TESTING")).toBe("same");
    expect(appStateOf(it0({ domains: [dom("ok"), dom("failed")] }), "TESTING")).toBe("needs_look");
  });
  it("nothing is called the same when nothing was checked", () => {
    expect(appStateOf(it0({ domains: [] }), "TESTING")).toBe("no_site");
    expect(appStateOf(it0({ domains: [dom("pending")] }), "PLANNED")).toBe("checking");
  });
  it("after the switch: switching, then live with the certificate on its way, then live with it issued; a failed final check needs a look", () => {
    expect(appStateOf(it0({ domains: [dom("ok")] }), "SWAPPING")).toBe("switching");
    expect(appStateOf(it0({ domains: [dom("ok")] }), "SWAPPED")).toBe("switching");
    expect(appStateOf(it0({ domains: [{ ...live, cert: "pending" }] }), "SWAPPED")).toBe("live_cert");
    expect(appStateOf(it0({ domains: [live] }), "VERIFIED")).toBe("live");
    expect(appStateOf(it0({ domains: [{ ...live, finalCheck: "failed" }] }), "SWAPPED")).toBe("needs_look");
    expect(appStateOf(it0({ domains: [{ ...live, cert: "failed" }] }), "SWAPPED")).toBe("needs_look");
  });
  it("a left-out app, databases, services and a given-back takeover", () => {
    expect(appStateOf(it0({ skipped: true }), "TESTING")).toBe("left_out");
    expect(appStateOf(it0({ kind: "database", domains: [] }), "SWAPPED")).toBe("database");
    expect(appStateOf(it0({ kind: "database", domains: [], verify: { level: "counts", state: "ok" } }), "VERIFIED")).toBe("database_checked");
    expect(appStateOf(it0({ kind: "database", domains: [], verify: { level: "counts", state: "failed" } }), "SWAPPED")).toBe("needs_look");
    expect(appStateOf(it0({ kind: "service", domains: [], members: [{ name: "x", ready: "failed" }] }), "SWAPPED")).toBe("needs_look");
    expect(appStateOf(it0(), "GIVEN_BACK")).toBe("given_back");
  });
});

describe("domainEvidence and icon hints read what the hub may send, and nothing else", () => {
  it("returns both sides only when both were measured", () => {
    const d = { ...dom("failed"), evidence: { coolify: { status: 200, bytes: 10 }, tugra: { status: 502, bytes: 0, location: "x" } } };
    expect(domainEvidence(d)).toEqual({ coolify: { status: 200, bytes: 10, location: null }, tugra: { status: 502, bytes: 0, location: "x" } });
    expect(domainEvidence(dom("failed"))).toBeNull();
    expect(domainEvidence({ evidence: { coolify: { status: 200 } } })).toBeNull();
    expect(domainEvidence({ evidence: { coolify: {}, tugra: {} } })).toBeNull();
  });
  it("takes the app id and the image from an item that carries them", () => {
    expect(itemIconHints({ appId: "a1", image: "nginx:1" })).toEqual({ appId: "a1", image: "nginx:1" });
    expect(itemIconHints(it0())).toEqual({ appId: null, image: null });
  });
});

describe("the words of the simple page", () => {
  it("counts the sites that answer, are live and hold a certificate; apps and databases apart", () => {
    const live = { host: "b.example.com", tempCheck: "ok" as const, finalCheck: "ok" as const, cert: "issued" as const };
    const c = siteCounts([it0({ domains: [dom("ok"), dom("failed")] }), it0({ itemRef: "x", domains: [live] }), it0({ itemRef: "y", skipped: true }), it0({ itemRef: "z", kind: "database", domains: [] })]);
    expect(c).toEqual({ sites: 3, same: 2, live: 1, certified: 1, leftOut: 1, problems: 1 });
  });
  it("names the stage the takeover is in", () => {
    expect(stageLine("TESTING", false)).toEqual({ stage: "tested", n: 2, state: "current" });
    expect(stageLine("SWAPPED", false)).toEqual({ stage: "handedOver", n: 3, state: "current" });
    expect(stageLine("VERIFIED", true).stage).toBe("verified");
    expect(stageLine("FAILED", false).state).toBe("stopped");
  });
  it("names an in-place step in the owner's words, a copy run keeps the general name", () => {
    expect(stepTitleKey({ inPlace: true }, "DEPLOY_DARK")).toBe("inPlaceRun.step.DEPLOY_DARK");
    expect(stepTitleKey({ inPlace: true }, "FREEZE")).toBe("migrationRun.steps.FREEZE.title");
    expect(stepTitleKey({ inPlace: false }, "DEPLOY_DARK")).toBe("migrationRun.steps.DEPLOY_DARK.title");
  });
  it("one state word for the header and one heading for the card", () => {
    const na = (kind: "approval" | "failed" | "engine" | "timer") => ({ kind, stepKey: null, code: "x", since: "" });
    expect(runStateKey({ status: "WAITING", nextAction: na("approval") })).toBe("inPlaceRun.state.goAhead");
    expect(runStateKey({ status: "FAILED", nextAction: na("failed") })).toBe("inPlaceRun.state.needsLook");
    expect(runStateKey({ status: "RUNNING", nextAction: na("engine") })).toBe("inPlaceRun.state.moving");
    expect(runStateKey({ status: "ABORTED", nextAction: na("engine") })).toBe("inPlaceRun.state.givenBack");
    expect(nextHeadingKey("engine", "DEPLOY_DARK", "RUNNING")).toBe("inPlaceRun.next.checking");
    expect(nextHeadingKey("engine", "CUTOVER", "RUNNING")).toBe("inPlaceRun.next.switching");
    expect(nextHeadingKey("failed", "IMPORT", "FAILED")).toBe("inPlaceRun.next.needsLook");
    expect(nextHeadingKey("none", null, "COMPLETED")).toBe("inPlaceRun.next.done");
  });
});
