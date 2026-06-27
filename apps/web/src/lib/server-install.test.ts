import { describe, it, expect } from "vitest";
import { installPhase, TROUBLESHOOT_MS } from "./server-install";

describe("installPhase", () => {
  it("is 'expired' when there is no valid command, regardless of elapsed time", () => {
    expect(installPhase(null, 0)).toBe("expired");
    expect(installPhase(null, TROUBLESHOOT_MS + 1)).toBe("expired");
  });
  it("shows the command while still within the patience window", () => {
    expect(installPhase("tugra-agent …", 0)).toBe("command");
    expect(installPhase("tugra-agent …", TROUBLESHOOT_MS - 1)).toBe("command");
  });
  it("escalates to troubleshooting once the threshold is reached", () => {
    expect(installPhase("tugra-agent …", TROUBLESHOOT_MS)).toBe("troubleshoot");
    expect(installPhase("tugra-agent …", TROUBLESHOOT_MS + 60_000)).toBe("troubleshoot");
  });
});
