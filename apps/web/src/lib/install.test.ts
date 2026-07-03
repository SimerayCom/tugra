import { describe, it, expect } from "vitest";
import { installableServers, autoServerId } from "./install";
import type { ServerView } from "./types";

const srv = (id: string, status: ServerView["status"]): ServerView =>
  ({ id, name: `srv-${id}`, status } as ServerView);

describe("installableServers", () => {
  it("keeps only ONLINE servers", () => {
    const servers = [srv("a", "ONLINE"), srv("b", "OFFLINE"), srv("c", "PENDING"), srv("d", "ONLINE")];
    expect(installableServers(servers).map((s) => s.id)).toEqual(["a", "d"]);
  });
});

describe("autoServerId", () => {
  it("returns the id when exactly one server is online", () => {
    expect(autoServerId([srv("a", "ONLINE"), srv("b", "OFFLINE")])).toBe("a");
  });

  it("returns null when zero or many servers are online (user must choose)", () => {
    expect(autoServerId([srv("b", "OFFLINE")])).toBeNull();
    expect(autoServerId([])).toBeNull();
    expect(autoServerId([srv("a", "ONLINE"), srv("b", "ONLINE")])).toBeNull();
  });
});
