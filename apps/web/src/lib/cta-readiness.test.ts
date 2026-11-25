import { describe, it, expect } from "vitest";
import { blockTag, blockText, capabilitiesHref, hasCapability, serverBlock } from "./cta-readiness";

const ok: { status: "ONLINE" | "OFFLINE" | "PENDING"; canWrite: boolean; capabilities: string[] } = { status: "ONLINE", canWrite: true, capabilities: ["deploy", "backup"] };
const t = (k: string, v?: Record<string, string | number>) => `${k}${v ? JSON.stringify(v) : ""}`;

describe("serverBlock", () => {
  it("lets an online, writable server with the capabilities go ahead", () => {
    expect(serverBlock(ok, ["deploy"])).toBeNull();
    expect(serverBlock(ok)).toBeNull();
  });
  it("names the first thing in the way, in the order the user can fix it", () => {
    expect(serverBlock({ ...ok, status: "PENDING" }, ["deploy"])?.code).toBe("pending");
    expect(serverBlock({ ...ok, status: "OFFLINE", canWrite: false }, ["deploy"])?.code).toBe("offline");
    expect(serverBlock({ ...ok, canWrite: false }, ["deploy"])?.code).toBe("no_write");
    expect(serverBlock({ ...ok, capabilities: [] }, ["deploy", "patch"])).toEqual({ code: "capability", missing: ["deploy", "patch"] });
  });
  it("an empty grant grants nothing", () => {
    expect(hasCapability({ capabilities: [] }, "deploy")).toBe(false);
    expect(hasCapability({ capabilities: ["deploy"] }, "deploy")).toBe(true);
  });
  it("write access is only checked when asked for", () => {
    expect(serverBlock({ ...ok, canWrite: false }, ["deploy"], { write: false })).toBeNull();
  });
});

describe("texts", () => {
  it("capability text lists the missing ones by their names", () => {
    expect(blockText(t, { code: "capability", missing: ["deploy", "patch"] })).toBe('servers.cta.blockCapability{"caps":"servers.cap_deploy, servers.cap_patch"}');
    expect(blockTag(t, { code: "offline", missing: [] })).toBe("servers.cta.tagOffline");
    expect(blockText(t, { code: "no_write", missing: [] })).toBe("servers.cta.blockNoWrite");
  });
  it("the capability switches live on the server's maintenance tab", () => {
    expect(capabilitiesHref("abc")).toBe("/servers/abc?tab=maintenance");
  });
});
