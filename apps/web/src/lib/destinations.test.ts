import { describe, it, expect } from "vitest";
import { destSummary, destTypeLabel } from "./destinations";
import type { BackupDestination } from "./types";

const base: BackupDestination = {
  id: "d1", name: "x", type: "S3", teamId: "t1",
  s3Bucket: "my-bucket", s3Region: "us-east-1", s3Endpoint: "s3.amazonaws.com",
  s3Prefix: "tugra", encryptionEnabled: false, hasCredentials: true,
  role: "OWNER", canWrite: true, createdAt: "",
};

describe("destination helpers", () => {
  it("labels destination types", () => {
    expect(destTypeLabel("S3")).toContain("S3");
    expect(destTypeLabel("LOCAL")).toContain("Local");
  });

  it("summarizes an S3 destination with bucket/prefix and encryption flag", () => {
    expect(destSummary(base)).toBe("my-bucket/tugra");
    expect(destSummary({ ...base, encryptionEnabled: true })).toBe("my-bucket/tugra · encrypted");
    expect(destSummary({ ...base, type: "LOCAL" })).toBe("Local disk");
  });
});
