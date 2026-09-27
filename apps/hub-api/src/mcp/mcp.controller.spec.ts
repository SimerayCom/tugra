import { McpController, type McpHttpResponse } from "./mcp.controller";
import type { McpService } from "./mcp.service";
import type { RedisService } from "../redis/redis.service";
import type { AuthUser } from "../auth/strategies/jwt.strategy";

function res() {
  const r = {} as McpHttpResponse & { status: jest.Mock; setHeader: jest.Mock };
  r.status = jest.fn(() => r);
  r.setHeader = jest.fn(() => r);
  return r;
}

const user: AuthUser = { userId: "u1", scopes: ["read"], tokenId: "t1" };

function make(over: { handle?: jest.Mock; incrBy?: jest.Mock } = {}) {
  const handle = over.handle ?? jest.fn().mockResolvedValue({ jsonrpc: "2.0", id: 1, result: {} });
  const incrBy = over.incrBy ?? jest.fn(async (_k: string, amount: number) => amount); // returns the running total
  const ctrl = new McpController({ handle } as unknown as McpService, { incrBy } as unknown as RedisService);
  return { ctrl, handle, incrBy };
}

describe("McpController", () => {
  it("GET → 405 with Allow: POST and a JSON-RPC error body", async () => {
    const { ctrl } = make();
    const r = res();
    const body = ctrl.getNotSupported(r) as { error: { code: number } };
    expect(r.status).toHaveBeenCalledWith(405);
    expect(r.setHeader).toHaveBeenCalledWith("Allow", "POST");
    expect(body.error.code).toBe(-32000);
  });

  it("POST delegates to McpService.handle with the token-resolved ctx (never client-supplied)", async () => {
    const { ctrl, handle } = make();
    const out = await ctrl.handle(user, { jsonrpc: "2.0", id: 1, method: "ping" }, res());
    expect(handle).toHaveBeenCalledWith({ userId: "u1", scopes: ["read"], tokenId: "t1" }, { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(out).toMatchObject({ result: {} });
  });

  it("applies a per-user burst rate-limit → 429 + JSON-RPC -32000 when exceeded (charges 1 for a single message)", async () => {
    const { ctrl, handle, incrBy } = make({ incrBy: jest.fn().mockResolvedValue(31) });
    const r = res();
    const out = (await ctrl.handle(user, { jsonrpc: "2.0", id: 1, method: "ping" }, r)) as { error: { code: number } };
    expect(incrBy).toHaveBeenCalledWith("mcp:burst:u1", 1, 10);
    expect(r.status).toHaveBeenCalledWith(429);
    expect(out.error.code).toBe(-32000);
    expect(handle).not.toHaveBeenCalled(); // short-circuits before dispatch
  });

  it("charges the burst budget by NUMBER OF MESSAGES in a batch (a batch of k costs k) (#F2)", async () => {
    const { ctrl, incrBy } = make();
    await ctrl.handle(user, [{ method: "ping", id: 1 }, { method: "ping", id: 2 }, { method: "ping", id: 3 }], res());
    expect(incrBy).toHaveBeenCalledWith("mcp:burst:u1", 3, 10);
  });

  it("rejects an oversized batch (>20) with 400 + -32600, before charging or dispatching (#F2)", async () => {
    const { ctrl, handle, incrBy } = make();
    const r = res();
    const big = Array.from({ length: 21 }, (_v, i) => ({ method: "ping", id: i }));
    const out = (await ctrl.handle(user, big, r)) as { error: { code: number; message: string } };
    expect(r.status).toHaveBeenCalledWith(400);
    expect(out.error.code).toBe(-32600);
    expect(out.error.message).toMatch(/batch too large/);
    expect(incrBy).not.toHaveBeenCalled(); // rejected before it costs budget
    expect(handle).not.toHaveBeenCalled();
  });

  it("a notification (handle→null) yields a 202 with no body", async () => {
    const { ctrl } = make({ handle: jest.fn().mockResolvedValue(null) });
    const r = res();
    const out = await ctrl.handle(user, { jsonrpc: "2.0", method: "notifications/initialized" }, r);
    expect(r.status).toHaveBeenCalledWith(202);
    expect(out).toBeUndefined();
  });

  it("handles a JSON-RPC batch (array) — dispatches each, filters out notification nulls", async () => {
    const handle = jest.fn().mockResolvedValueOnce({ jsonrpc: "2.0", id: 1, result: {} }).mockResolvedValueOnce(null);
    const { ctrl } = make({ handle });
    const out = (await ctrl.handle(user, [{ method: "ping", id: 1 }, { method: "notifications/x" }], res())) as unknown[];
    expect(handle).toHaveBeenCalledTimes(2);
    expect(out).toHaveLength(1);
  });
});
