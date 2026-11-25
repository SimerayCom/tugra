import { Controller, Get, INestApplication, Post, Body, Module, MiddlewareConsumer, NestModule, RequestMethod } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { configureApp } from "../app-config";
import { defaultEmptyBody } from "./default-body.middleware";

@Controller()
class EchoController {
  @Post("things")
  prefixed(@Body() body: unknown) {
    return { body: body ?? null };
  }
  @Post("webhooks/deploy/:token")
  exempt(@Body() body: unknown) {
    return { body: body ?? null };
  }
  @Get("health")
  health() {
    return { ok: true };
  }
}

@Module({ controllers: [EchoController] })
class EchoModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(defaultEmptyBody).forRoutes({ path: "{*splat}", method: RequestMethod.ALL });
  }
}

describe("defaultEmptyBody", () => {
  let app: INestApplication;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [EchoModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  it("a body-less POST under the /api/v1 prefix sees {}", async () => {
    const res = await request(app.getHttpServer()).post("/api/v1/things").expect(201);
    expect(res.body).toEqual({ body: {} });
  });

  it("a body-less POST on a route exempt from the prefix sees {}", async () => {
    const res = await request(app.getHttpServer()).post("/webhooks/deploy/abc").expect(201);
    expect(res.body).toEqual({ body: {} });
  });

  it("a real JSON body is untouched, and plain GETs still work", async () => {
    const res = await request(app.getHttpServer()).post("/api/v1/things").send({ a: 1 }).expect(201);
    expect(res.body).toEqual({ body: { a: 1 } });
    await request(app.getHttpServer()).get("/health").expect(200);
  });
});
