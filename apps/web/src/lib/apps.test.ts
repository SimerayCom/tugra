import { describe, it, expect } from "vitest";
import { appColor, appStatusDisplay, deleteCleanupOptions, appSourceSummary, appUrl, deploymentColor, shortDigest, webhookUrl } from "./apps";

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
    expect(deploymentColor("QUEUED")).toContain("--c-am"); // waiting to start
    expect(deploymentColor("CANCELLED")).toContain("--c-tx3"); // muted — never ran
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

  it("shortens a pinned image digest ref for display", () => {
    expect(shortDigest("nginx@sha256:abc123def4567890")).toBe("sha256:abc123def4…");
    expect(shortDigest("no-digest-here")).toBe("no-digest-here"); // graceful passthrough
  });
});

describe("appStatusDisplay", () => {
  const h = (state: "healthy" | "unhealthy" | "starting" | "none" | "unknown", checkType: "CMD" | "HTTP" | "NONE" = "NONE") => ({ state, checkType, containers: 1, observedAt: null });
  const d = (status: "NEW" | "RUNNING" | "STOPPED" | "FAILED", containerHealth: ReturnType<typeof h>, source: "IMAGE" | "GIT" | "COMPOSE" = "IMAGE") => appStatusDisplay({ status, containerHealth, source });

  it("passes a non-running status through unchanged, whatever the health", () => {
    expect(d("FAILED", h("healthy"))).toEqual({ key: "FAILED", color: appColor("FAILED") });
    expect(d("STOPPED", h("unhealthy"))).toEqual({ key: "STOPPED", color: appColor("STOPPED") });
    expect(d("NEW", h("unknown"))).toEqual({ key: "NEW", color: appColor("NEW") });
  });

  it("refines RUNNING by container health", () => {
    expect(d("RUNNING", h("unhealthy", "CMD"))).toEqual({ key: "RUNNING_UNHEALTHY", color: "var(--c-r)" });
    expect(d("RUNNING", h("starting", "CMD"))).toEqual({ key: "STARTING", color: "var(--c-am)" });
    expect(d("RUNNING", h("healthy", "CMD"))).toEqual({ key: "RUNNING", color: "var(--c-g)" });
  });

  it("none: no-healthcheck for compose or checkType NONE; HTTP/CMD-gated apps read plain Running", () => {
    expect(d("RUNNING", h("none", "NONE")).key).toBe("RUNNING_NO_HEALTHCHECK");
    expect(d("RUNNING", h("none", "HTTP"), "COMPOSE").key).toBe("RUNNING_NO_HEALTHCHECK");
    expect(d("RUNNING", h("none", "HTTP")).key).toBe("RUNNING");
    expect(d("RUNNING", h("none", "CMD")).key).toBe("RUNNING");
  });

  it("never alarms on missing data", () => {
    expect(d("RUNNING", h("unknown", "CMD"))).toEqual({ key: "RUNNING", color: "var(--c-g)" });
  });
});

describe("deleteCleanupOptions", () => {
  it("IMAGE without custom networks offers neither", () => {
    expect(deleteCleanupOptions({ source: "IMAGE", clusterId: null, networks: [] })).toEqual({ networks: [], buildCache: false });
    expect(deleteCleanupOptions({ source: "IMAGE", clusterId: null, networks: ["tugra-apps"] })).toEqual({ networks: [], buildCache: false }); // the shared bridge is never listed
  });
  it("GIT with custom networks offers both, listing the names", () => {
    expect(deleteCleanupOptions({ source: "GIT", clusterId: null, networks: ["tugra-apps", "backend", "db"] })).toEqual({ networks: ["backend", "db"], buildCache: true });
  });
  it("COMPOSE offers the build cache but no networks; IMAGE with networks offers networks only", () => {
    expect(deleteCleanupOptions({ source: "COMPOSE", clusterId: null, networks: ["x"] })).toEqual({ networks: [], buildCache: true });
    expect(deleteCleanupOptions({ source: "IMAGE", clusterId: null, networks: ["x"] })).toEqual({ networks: ["x"], buildCache: false });
  });
  it("a clustered app offers neither", () => {
    expect(deleteCleanupOptions({ source: "GIT", clusterId: "c1", networks: ["x"] })).toEqual({ networks: [], buildCache: false });
  });
});
