import { describe, it, expect } from "vitest";
import { scanSteps } from "./scan-steps";
import type { ScanContainer, ScanReport } from "./types";

const c = (over: Partial<ScanContainer>): ScanContainer => ({ name: "x", image: "i", state: "running", project: null, service: null, software: null, managedBy: null, ports: [], adoptable: false, ...over });
const rep = (containers: ScanContainer[]) => ({ containers }) as ScanReport;

describe("scanSteps", () => {
  it("splits what a platform deployed from the platform's own containers", () => {
    const s = scanSteps(rep([
      c({ name: "coolify", managedBy: "coolify", platformInfra: true }),
      c({ name: "coolify-db", managedBy: "coolify" }), // an older report: only the name tells
      c({ name: "a1", managedBy: "coolify", project: "a1" }),
      c({ name: "a2", managedBy: "coolify" }),
      c({ name: "dokploy-redis", managedBy: "dokploy" }),
    ]));
    expect(s.platformApps).toEqual({ coolify: 2, dokploy: 0 });
    expect(s.platformInfra).toEqual({ coolify: 2, dokploy: 1 });
  });
  it("counts plain compose projects as stacks, not the ones a platform or Swarm runs", () => {
    const s = scanSteps(rep([
      c({ name: "shop-web", project: "shop" }),
      c({ name: "shop-db", project: "shop" }),
      c({ name: "blog", project: "blog" }),
      c({ name: "abc", project: "abc", managedBy: "coolify" }),
      c({ name: "sw", project: "sw", swarm: true }),
    ]));
    expect(s.stacks).toEqual(["blog", "shop"]);
  });
  it("counts standalone adoptable containers and Swarm tasks", () => {
    const s = scanSteps(rep([c({ adoptable: true }), c({ name: "y", adoptable: true }), c({ name: "w", swarm: true })]));
    expect(s.standalone).toBe(2);
    expect(s.swarm).toBe(1);
  });
});
