import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lib/hub-stream-proxy", () => ({ proxyToHub: vi.fn(async () => new Response("proxied")) }));

import { proxyToHub } from "../../../lib/hub-stream-proxy";
import * as volumeRoute from "./apps/[id]/files/content/route";
import * as containerRoute from "./apps/[id]/container-files/content/route";
import * as agentRoute from "./agent-fs/t/[id]/route";

beforeEach(() => vi.mocked(proxyToHub).mockClear());
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

// These handlers sit in the file system, so they take precedence over the buffering `/api/v1` rewrite for the three
// routes that carry whole file bodies. Each must forward BOTH verbs: a route file that only exported PUT would answer
// 405 to the GET download on the same path.
describe("streaming file routes", () => {
  it.each([
    ["volume content", volumeRoute, "a1", "/api/v1/apps/a1/files/content"],
    ["container content", containerRoute, "a1", "/api/v1/apps/a1/container-files/content"],
    ["agent transfer", agentRoute, "AAAAAAAAAAAAAAAAAAAAAAAA", "/api/v1/agent-fs/t/AAAAAAAAAAAAAAAAAAAAAAAA"],
  ])("%s proxies GET and PUT to the right hub path", async (_n, mod, id, hubPath) => {
    const req = new Request("http://web/anything?x=1", { method: "PUT", body: "x" });
    expect(await (await mod.PUT(req, ctx(id))).text()).toBe("proxied");
    expect(await (await mod.GET(new Request("http://web/anything"), ctx(id))).text()).toBe("proxied");
    expect(vi.mocked(proxyToHub).mock.calls.map((c) => c[1])).toEqual([hubPath, hubPath]);
    expect(mod.dynamic).toBe("force-dynamic");
    expect(mod.runtime).toBe("nodejs");
  });

  it("encodes a hostile id so it cannot change the hub path", async () => {
    await volumeRoute.GET(new Request("http://web/x"), ctx("a/../../b?c"));
    expect(vi.mocked(proxyToHub).mock.calls[0][1]).toBe("/api/v1/apps/a%2F..%2F..%2Fb%3Fc/files/content");
  });
});
