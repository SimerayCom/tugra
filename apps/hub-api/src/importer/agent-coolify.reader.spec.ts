import { BadRequestException, ConflictException } from "@nestjs/common";
import { AgentCoolifyReader } from "./agent-coolify.reader";
import { buildAgentReadScript } from "../coolify-takeover/coolify-agent-sql";

const good = (extra = "") =>
  ["TUGRA_CFY_IMAGE ghcr.io/coollabsio/coolify:4.0.0-beta.463", "TUGRA_CFY_RO on", "TUGRA_CFY_ISO repeatable read", "TUGRA_CFY_BEGIN servers", '[{"id":0,"uuid":"s"}]', "TUGRA_CFY_END servers", "TUGRA_CFY_DONE", extra].join("\n");

function make(send: jest.Mock, online = true) {
  const ws = { isOnline: jest.fn(() => online), sendCommand: send };
  return { reader: new AgentCoolifyReader(ws as never), ws };
}

describe("AgentCoolifyReader", () => {
  it("runs the constant read script through the signed command channel with the database capability", async () => {
    const send = jest.fn(async () => ({ output: good() }));
    const { reader, ws } = make(send);
    const r = await reader.read("srv1");
    expect(send).toHaveBeenCalledWith("srv1", buildAgentReadScript(), "database", expect.any(Number), expect.any(Function));
    expect(ws.isOnline).toHaveBeenCalledWith("srv1");
    expect(r.sections.get("servers")).toHaveLength(1);
  });

  it("prefers the streamed output when the final result text was capped by the agent", async () => {
    const send = jest.fn(async (_id: string, _s: string, _c: string, _t: number, onChunk: (c: string) => void) => {
      onChunk(good());
      return { output: "capped tail only" };
    });
    expect((await make(send).reader.read("srv1")).sections.get("servers")).toHaveLength(1);
  });

  it("an offline agent is a 409 with a stable code and nothing is sent", async () => {
    const send = jest.fn();
    const { reader } = make(send, false);
    await expect(reader.read("srv1")).rejects.toMatchObject({ response: { code: "agent_offline" } });
    await expect(reader.read("srv1")).rejects.toBeInstanceOf(ConflictException);
    expect(send).not.toHaveBeenCalled();
  });

  it("a host that fails the read-only check is a 400 with the stable code", async () => {
    const send = jest.fn(async () => ({ output: good().replace("TUGRA_CFY_RO on", "TUGRA_CFY_RO off") }));
    await expect(make(send).reader.read("srv1")).rejects.toMatchObject({ response: { code: "not_read_only" } });
    await expect(make(send).reader.read("srv1")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("an answer that is cut short is unreadable, never a partial plan", async () => {
    const send = jest.fn(async () => ({ output: good().replace("TUGRA_CFY_DONE", "") }));
    await expect(make(send).reader.read("srv1")).rejects.toMatchObject({ response: { code: "unreadable" } });
  });

  it("output over the cap is refused", async () => {
    const send = jest.fn(async (_i: string, _s: string, _c: string, _t: number, onChunk: (c: string) => void) => {
      onChunk("x".repeat(60 * 1024 * 1024));
      onChunk("x".repeat(60 * 1024 * 1024));
      return { output: "" };
    });
    await expect(make(send).reader.read("srv1")).rejects.toMatchObject({ response: { code: "unreadable" } });
  });

  it("a channel error never echoes its text: a fixed message and code are all the caller sees", async () => {
    const send = jest.fn(async () => {
      throw new Error("docker: secret-stderr /data/coolify/source/.env APP_KEY=base64:AAAA");
    });
    const err = await make(send).reader.read("srv1").catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(JSON.stringify(err.getResponse())).not.toMatch(/APP_KEY|secret-stderr|\.env/);
    expect(err.getResponse()).toMatchObject({ code: "agent_unavailable" });
  });
});
