import { buildCleanupScript, buildDiskUsageScript, parseDiskUsage } from "./cleanup-script";

describe("disk usage", () => {
  it("buildDiskUsageScript asks docker for one JSON object per line (no user input)", () => {
    expect(buildDiskUsageScript()).toBe("docker system df --format '{{json .}}'");
  });

  it("parseDiskUsage maps the four categories, parses counts, and strips the reclaimable percentage", () => {
    const out = [
      '{"Type":"Images","TotalCount":"7","Active":"3","Size":"2.1GB","Reclaimable":"800MB (38%)"}',
      '{"Type":"Containers","TotalCount":"4","Active":"2","Size":"120MB","Reclaimable":"40MB (33%)"}',
      '{"Type":"Local Volumes","TotalCount":"5","Active":"5","Size":"1GB","Reclaimable":"0B (0%)"}',
      '{"Type":"Build Cache","TotalCount":"20","Active":"0","Size":"3.4GB","Reclaimable":"3.4GB"}',
    ].join("\n");
    const d = parseDiskUsage(out);
    expect(d.images).toEqual({ totalCount: 7, active: 3, size: "2.1GB", reclaimable: "800MB" });
    expect(d.containers.totalCount).toBe(4);
    expect(d.volumes.reclaimable).toBe("0B");
    expect(d.buildCache).toEqual({ totalCount: 20, active: 0, size: "3.4GB", reclaimable: "3.4GB" });
  });

  it("defaults missing categories to zero and skips blank / non-JSON lines", () => {
    const d = parseDiskUsage('\nwarning: something\n{"Type":"Images","TotalCount":"1","Active":"1","Size":"5MB","Reclaimable":"0B"}\n{bad json');
    expect(d.images.totalCount).toBe(1);
    expect(d.containers).toEqual({ totalCount: 0, active: 0, size: "0B", reclaimable: "0B" });
    expect(d.volumes).toEqual({ totalCount: 0, active: 0, size: "0B", reclaimable: "0B" });
    expect(d.buildCache).toEqual({ totalCount: 0, active: 0, size: "0B", reclaimable: "0B" });
  });
});

describe("buildCleanupScript", () => {
  it("prunes dangling layers and old build cache, best-effort, without volumes by default", () => {
    expect(buildCleanupScript({ volumes: false })).toBe(
      "rc=0; docker image prune -f || rc=1; docker builder prune -af --filter until=168h || rc=1; exit $rc",
    );
  });

  it("never removes containers, networks or tagged images (would strand managed state / rollback)", () => {
    const script = buildCleanupScript({ volumes: true });
    expect(script).not.toContain("system prune");
    expect(script).not.toContain("container prune");
    expect(script).not.toContain("network prune");
    expect(script).not.toContain("image prune -a"); // no `-a`: tagged rollback images are left to the hub's keep-5
  });

  it("adds `docker volume prune` when requested (destructive, opt-in)", () => {
    expect(buildCleanupScript({ volumes: true })).toContain("docker volume prune -f || rc=1");
  });

  it("clamps the retention window (floored, min 1h, max 1y, non-finite → default)", () => {
    expect(buildCleanupScript({ volumes: false, retentionHours: 24 })).toContain("--filter until=24h");
    expect(buildCleanupScript({ volumes: false, retentionHours: 0 })).toContain("--filter until=1h");
    expect(buildCleanupScript({ volumes: false, retentionHours: 1e9 })).toContain("--filter until=8760h"); // capped at 1y
    expect(buildCleanupScript({ volumes: false, retentionHours: Number.NaN })).toContain("--filter until=168h");
    expect(buildCleanupScript({ volumes: false, retentionHours: Infinity })).toContain("--filter until=168h");
  });
});
