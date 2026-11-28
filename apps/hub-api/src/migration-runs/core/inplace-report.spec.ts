import type { TakeoverItemView } from "@tugra/shared";
import { inPlaceReportItems } from "./inplace-report";

const d = (over: Partial<TakeoverItemView["domains"][number]> = {}) => ({ host: "a.example.test", tempCheck: "ok" as const, finalCheck: "ok" as const, cert: "issued" as const, ...over });
const app = (name: string, domains = [d()], over: Partial<TakeoverItemView> = {}): TakeoverItemView => ({ itemRef: `app:h:${name}`, name, buildMode: "reuse-image", domains, ...over });

describe("in-place report items (what the takeover verified, only the run's own)", () => {
  it("an app is moved once every domain answers after the switch and holds its new certificate", () => {
    const out = inPlaceReportItems([app("web"), app("slow", [d({ cert: "fallback" })])], "SWAPPED", false);
    expect(out).toEqual([
      { kind: "app", name: "web", outcome: "moved", code: null, evidence: "hub-verified" },
      { kind: "app", name: "slow", outcome: "skipped", code: "inplace.waiting", evidence: "hub-verified" },
    ]);
  });

  it("nothing is moved before the ports changed, whatever the tests beside Coolify said", () => {
    expect(inPlaceReportItems([app("web", [d({ finalCheck: "ok", cert: "issued" })])], "TESTING", false)[0]).toMatchObject({ outcome: "skipped", code: "inplace.waiting" });
    expect(inPlaceReportItems([app("web")], "GIVEN_BACK", true)[0]).toMatchObject({ outcome: "not-cut-over", code: "inplace.not-switched" });
  });

  it("a left-out item is skipped with its own code, a failed check is failed", () => {
    const out = inPlaceReportItems([app("gone", [], { skipped: true }), app("bad", [d({ finalCheck: "failed" })])], "SWAPPED", true);
    expect(out[0]).toMatchObject({ outcome: "skipped", code: "inplace.left-out" });
    expect(out[1]).toMatchObject({ outcome: "failed", code: "inplace.check-failed" });
  });

  it("a database is moved when its check passed, a service when every container is ready and its domains hold", () => {
    const db: TakeoverItemView = { itemRef: "database:h:pg", name: "pg", kind: "database", buildMode: "reuse-image", verify: { level: "exact", state: "ok" } as never, domains: [] };
    const svc: TakeoverItemView = { itemRef: "service:h:s", name: "s", kind: "service", buildMode: "reuse-image", members: [{ name: "a", ready: "ok" }, { name: "b", ready: "pending" }], domains: [] };
    const out = inPlaceReportItems([db, svc, { ...svc, members: [{ name: "a", ready: "ok" }] }], "VERIFIED", false);
    expect(out.map((i) => [i.kind, i.outcome])).toEqual([["database", "moved"], ["service", "skipped"], ["service", "moved"]]);
  });

  it("an app that serves no domain is moved after the switch, not before", () => {
    expect(inPlaceReportItems([app("worker", [])], "PLANNED", false)[0].outcome).toBe("skipped");
    expect(inPlaceReportItems([app("worker", [])], "SWAPPED", false)[0].outcome).toBe("moved");
  });
});
