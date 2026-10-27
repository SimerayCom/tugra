import { describe, it, expect } from "vitest";
import { collapseCarriageReturns, summarizeDeployLog } from "./log-lines";

describe("collapseCarriageReturns", () => {
  it("returns input unchanged when there is no carriage return", () => {
    const s = "line one\nline two\n";
    expect(collapseCarriageReturns(s)).toBe(s);
  });

  it("keeps only the final frame of a \\r-overwritten progress line", () => {
    const git = "Receiving objects:  10% (1/10)\rReceiving objects: 100% (10/10), done.";
    expect(collapseCarriageReturns(git)).toBe("Receiving objects: 100% (10/10), done.");
  });

  it("collapses a multi-frame pull line to its last state", () => {
    const pull = "abc Downloading [=>   ] 9MB\rabc Downloading [==> ] 22MB\rabc Download complete";
    expect(collapseCarriageReturns(pull)).toBe("abc Download complete");
  });

  it("collapses each line independently", () => {
    const s = "a1\ra2\nb1\rb2\nc";
    expect(collapseCarriageReturns(s)).toBe("a2\nb2\nc");
  });

  it("treats a trailing \\r as a CRLF line ending, not an overwrite-to-empty", () => {
    expect(collapseCarriageReturns("foo\r\nbar\r\n")).toBe("foo\nbar\n");
    expect(collapseCarriageReturns("a\rb\r\n")).toBe("b\n"); // interior overwrite + CRLF ending
  });
});

describe("summarizeDeployLog", () => {
  it("lifts the rollout state and strips control lines from an image-pull log", () => {
    const raw = [
      "docker.io/library/nginx:alpine",
      "TUGRA_DIGEST=nginx@sha256:a3554c0d0b48177b1413c26e01f695334428020d9df01243fbae3e11cfd17417",
      "05c9649fc4c3ad98f0781d55e03a19de525cd578103953535e567829dfed5fe6",
      "TUGRA_ROLLOUT: healthy",
    ].join("\n");
    const s = summarizeDeployLog(raw);
    expect(s.rollout).toBe("healthy");
    expect(s.stripped).toBe(true);
    expect(s.body).toBe("docker.io/library/nginx:alpine"); // only the human-meaningful line survives
    expect(s.body).not.toMatch(/TUGRA_|[0-9a-f]{64}/);
  });

  it("keeps real build output and reports no rollout when there is no marker", () => {
    const raw = "Step 1/3 : FROM node:20\nStep 2/3 : RUN npm ci\nSuccessfully built myapp";
    const s = summarizeDeployLog(raw);
    expect(s.rollout).toBeNull();
    expect(s.stripped).toBe(false);
    expect(s.body).toBe(raw);
  });

  it("captures a non-healthy rollout state", () => {
    const s = summarizeDeployLog("boom\nTUGRA_ROLLOUT: rolled_back");
    expect(s.rollout).toBe("rolled_back");
    expect(s.body).toBe("boom");
  });

  it("returns an empty body (still stripped) when the log is only control lines", () => {
    const s = summarizeDeployLog("TUGRA_DIGEST=x@sha256:1\nTUGRA_ROLLOUT: healthy");
    expect(s.body).toBe("");
    expect(s.stripped).toBe(true);
    expect(s.rollout).toBe("healthy");
  });

  it("does not strip a hex-looking token that is not a lone 64-char line", () => {
    const raw = "built image abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789 ok";
    const s = summarizeDeployLog(raw);
    expect(s.body).toBe(raw); // 64-hex only stripped when it is the WHOLE line
    expect(s.stripped).toBe(false);
  });
});
