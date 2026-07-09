import { describe, it, expect } from "vitest";
import { bulkSummary } from "./bulk";
import type { ServerView } from "./types";

const s = (id: string, canWrite: boolean): ServerView => ({
  id,
  name: id,
  status: "ONLINE",
  teamId: "t",
  hostname: null,
  publicIp: null,
  publicIpv6: null,
  ipSource: "observed",
  wildcardDomain: null,
  magicSuffix: null,
  os: null,
  osVersion: null,
  arch: null,
  kernel: null,
  cpuCores: null,
  memTotalBytes: null,
  uptimeSeconds: null,
  cleanupEnabled: false,
  cleanupIntervalHours: null,
  cleanupVolumes: false,
  lastCleanupAt: null,
  lastSeenAt: null,
  createdAt: "",
  seal: null,
  tags: [],
  role: canWrite ? "OWNER" : "VIEWER",
  canWrite,
});

describe("bulkSummary", () => {
  it("counts writable vs skipped among the selection", () => {
    const servers = [s("a", true), s("b", false), s("c", true)];
    const sum = bulkSummary(servers, new Set(["a", "b", "c"]));
    expect(sum.writable).toBe(2);
    expect(sum.skipped).toBe(1);
  });
});
