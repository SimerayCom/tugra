import { Body, Controller, INestApplication, Post } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { largeJsonBody } from "./large-json";

@Controller()
class SizeController {
  @Post("big/echo")
  big(@Body() body: { items: string[] }) {
    return { n: body.items.length };
  }
  @Post("small/echo")
  small(@Body() body: { items: string[] }) {
    return { n: body.items.length };
  }
}

/** The framework's own JSON parser (100 kB) must skip a request largeJsonBody already read, whatever the parser version. */
describe("largeJsonBody in front of the framework's body parser", () => {
  let app: INestApplication;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ controllers: [SizeController] }).compile();
    app = mod.createNestApplication({ rawBody: true });
    app.use(largeJsonBody("/big/", 4 * 1024 * 1024)); // registered before init, as in main.ts
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  const items = (kb: number) => Array.from({ length: kb }, () => "x".repeat(1000));

  it("accepts a 600 kB JSON body on the opted-in prefix when the request carries credentials", async () => {
    const res = await request(app.getHttpServer()).post("/big/echo").set("Authorization", "Bearer t").send({ items: items(600) }).expect(201);
    expect(res.body).toEqual({ n: 600 });
  });

  it("keeps the default 100 kB limit elsewhere and for anonymous requests", async () => {
    await request(app.getHttpServer()).post("/small/echo").set("Authorization", "Bearer t").send({ items: items(600) }).expect(413);
    await request(app.getHttpServer()).post("/big/echo").send({ items: items(600) }).expect(413);
    const ok = await request(app.getHttpServer()).post("/small/echo").send({ items: items(10) }).expect(201);
    expect(ok.body).toEqual({ n: 10 });
  });
});
