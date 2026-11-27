import { Body, Controller, Get, INestApplication, MiddlewareConsumer, Module, NestModule, Post } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { escapeLineSeparators, escapeJsonLineSeparators } from "./json-line-separators";

const LS = "\u2028";
const PS = "\u2029";

@Controller()
class EchoController {
  @Post("rpc")
  rpc(@Body() body: { text: string }) {
    // Same shape McpService builds for a tool result: JSON text inside content[].text.
    return { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ comment: body.text }) }] } };
  }
  @Get("plain")
  plain() {
    return `a${LS}b`;
  }
}

@Module({ controllers: [EchoController] })
class EchoModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(escapeJsonLineSeparators).forRoutes(EchoController);
  }
}

describe("escapeLineSeparators", () => {
  it("escapes both separators and leaves everything else alone", () => {
    expect(escapeLineSeparators(`"a${LS}b${PS}c é \\n"`)).toBe('"a\\u2028b\\u2029c é \\n"');
  });
});

describe("escapeJsonLineSeparators", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = (await Test.createTestingModule({ imports: [EchoModule] }).compile()).createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  it("a JSON-RPC response carries no raw U+2028/U+2029 and parses to the same value", async () => {
    const text = `one${LS}two${PS}three`;
    const res = await request(app.getHttpServer()).post("/rpc").send({ text }).buffer(true).expect(201);
    expect(res.text).not.toContain(LS);
    expect(res.text).not.toContain(PS);
    expect(res.text).toContain("\\u2028");
    expect(res.text).toContain("\\u2029");
    const inner = JSON.parse(res.body.result.content[0].text) as { comment: string };
    expect(inner.comment).toBe(text);
  });

  it("a string that is not JSON is left untouched", async () => {
    const res = await request(app.getHttpServer()).get("/plain").buffer(true).expect(200);
    expect(res.text).toBe(`a${LS}b`);
  });
});
