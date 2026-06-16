import { describe, it, expect } from "vitest";
import { appColor, appSourceSummary, appUrl, deploymentColor, webhookUrl } from "./apps";

describe("app helpers", () => {
  it("maps app status to a color", () => {
    expect(appColor("RUNNING")).toContain("--c-g");
    expect(appColor("FAILED")).toContain("--c-r");
    expect(appColor("STOPPED")).toContain("--c-am");
    expect(appColor("NEW")).toContain("--c-tx3");
  });

  it("maps deployment status to a color", () => {
    expect(deploymentColor("SUCCESS")).toContain("--c-g");
    expect(deploymentColor("FAILED")).toContain("--c-r");
    expect(deploymentColor("RUNNING")).toContain("--c-am");
  });

  it("builds the app url from domain + https", () => {
    expect(appUrl({ domain: "x.com", https: true })).toBe("https://x.com");
    expect(appUrl({ domain: "x.com", https: false })).toBe("http://x.com");
    expect(appUrl({ domain: null, https: true })).toBeNull();
  });

  it("summarizes the app source", () => {
    expect(appSourceSummary({ source: "IMAGE", image: "nginx", gitBranch: null })).toBe("nginx");
    expect(appSourceSummary({ source: "GIT", image: null, gitBranch: "dev" })).toBe("git:dev");
    expect(appSourceSummary({ source: "COMPOSE", image: null, gitBranch: null })).toBe("compose");
  });

  it("builds the public webhook url from a token", () => {
    expect(webhookUrl("tugra_wh_abc")).toMatch(/\/webhooks\/deploy\/tugra_wh_abc$/);
  });
});
