import { buildCleanupScript } from "./cleanup-script";

describe("buildCleanupScript", () => {
  it("prunes images/containers/networks/build-cache without volumes by default", () => {
    expect(buildCleanupScript({ volumes: false })).toBe("docker system prune -af");
  });

  it("adds --volumes when requested (destructive)", () => {
    expect(buildCleanupScript({ volumes: true })).toBe("docker system prune -af --volumes");
  });
});
