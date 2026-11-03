import { buildCleanupScript } from "./cleanup-script";

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
