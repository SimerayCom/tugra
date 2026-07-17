import * as fs from "node:fs";
import * as path from "node:path";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import type { OpenAPIObject } from "@nestjs/swagger";
import { AppModule } from "../app.module";
import { configureApp } from "../app-config";
import { buildOpenApiDocument } from "./openapi";

// apps/hub-api/openapi.json — the committed contract the drift-guard pins.
const OPENAPI_PATH = path.join(__dirname, "..", "..", "openapi.json");

describe("OpenAPI document", () => {
  let app: INestApplication;
  let doc: OpenAPIObject;
  let serialized: string;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app); // paths carry the /api/v1 prefix
    doc = buildOpenApiDocument(app); // no app.init() → route metadata only, no DB
    serialized = `${JSON.stringify(doc, null, 2)}\n`;
  });

  afterAll(async () => {
    await app?.close().catch(() => undefined);
  });

  it("is a valid OpenAPI 3.1 document with the pat + session security schemes", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.version).toBe("1.0.0");
    expect(Object.keys(doc.paths).length).toBeGreaterThan(50);
    expect(doc.components?.securitySchemes?.pat).toMatchObject({ type: "http", scheme: "bearer" });
    expect(doc.components?.securitySchemes?.session).toMatchObject({ type: "apiKey", in: "cookie" });
  });

  it("documents the public API surface (sample routes present under /api/v1)", () => {
    expect(doc.paths["/api/v1/apps"]).toBeDefined();
    expect(doc.paths["/api/v1/servers"]).toBeDefined();
    expect(doc.paths["/api/v1/databases"]).toBeDefined();
    // prefix-exempt infra routes stay at the bare path
    expect(doc.paths["/health"]).toBeDefined();
    expect(doc.paths["/version"]).toBeDefined();
  });

  it("matches the committed openapi.json (drift-guard)", () => {
    if (process.env.UPDATE_OPENAPI) {
      fs.writeFileSync(OPENAPI_PATH, serialized);
      return;
    }
    const committed = fs.readFileSync(OPENAPI_PATH, "utf8");
    expect(serialized).toBe(committed);
  });
});
