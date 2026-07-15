import { VersionController } from "./version.controller";

describe("VersionController", () => {
  it("returns the build/version descriptor (protocol constant + env-driven metadata)", () => {
    const result = new VersionController().version();
    expect(result).toEqual(
      expect.objectContaining({
        version: expect.any(String),
        protocol: 2,
        channel: expect.any(String),
        commit: expect.any(String),
        edition: expect.any(String),
      }),
    );
  });
});
