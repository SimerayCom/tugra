import { applyDecorators, INestApplication } from "@nestjs/common";
import { ApiBody, ApiResponse, DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import type { OpenAPIObject } from "@nestjs/swagger";
import * as zodToJsonSchemaModule from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";

// zod-to-json-schema's own recursive return type makes tsc blow up (TS2589) when it's instantiated. Cast
// the module through `unknown` to a flattened signature so that deep type is never read.
const zodToJsonSchema = (
  zodToJsonSchemaModule as unknown as { zodToJsonSchema: (schema: ZodTypeAny, options?: unknown) => Record<string, unknown> }
).zodToJsonSchema;

// A plain JSON-schema bag. We deliberately DON'T type against @nestjs/swagger's recursive SchemaObject —
// referencing it here makes tsc blow up (TS2589 "excessively deep") — and cast to `any` at the ApiBody/
// ApiResponse boundary instead.
type JsonSchema = Record<string, unknown>;
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The API contract version stamped into the generated document. Deliberately a STABLE constant — NOT the
 * build/app version (appVersion/gitSha) — so `openapi.json` is byte-deterministic and the drift-guard diff
 * only flips when the API surface actually changes, never on a rebuild.
 */
export const API_VERSION = "1.0.0";

/** Build the OpenAPI 3.1 document from the running app's route metadata. Call AFTER configureApp(app) so
 *  every path carries the /api/v1 global prefix. Needs no app.init()/DB — it only reads route metadata. */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle("Tugra API")
    .setDescription(
      "REST API for the Tugra self-hosted PaaS. Authenticate with a personal access token " +
        "(`Authorization: Bearer tugra_pat_…`); the browser app uses a session cookie.",
    )
    .setVersion(API_VERSION)
    .setOpenAPIVersion("3.1.0")
    .addServer("/api/v1")
    .addBearerAuth(
      // bearerFormat is a display hint — say "opaque", not the library default "JWT" (PATs aren't JWTs).
      { type: "http", scheme: "bearer", bearerFormat: "opaque", description: "Personal access token (tugra_pat_…)." },
      "pat",
    )
    .addCookieAuth("tg_access", { type: "apiKey", description: "Browser session cookie." }, "session")
    .build();
  return SwaggerModule.createDocument(app, config);
}

/** Build + mount the docs: Swagger UI at /api/docs (outside the Nest router, so the /api/v1 prefix doesn't
 *  apply) and the JSON at /api/v1/openapi.json. Shared by main.ts and the e2e so both serve identically. */
export function setupOpenApi(app: INestApplication): OpenAPIObject {
  const doc = buildOpenApiDocument(app);
  SwaggerModule.setup("api/docs", app, doc, {
    jsonDocumentUrl: "api/v1/openapi.json",
    customSiteTitle: "Tugra API",
  });
  return doc;
}

/** Convert a zod schema to an inlined OpenAPI schema object (no $ref, so each decorator is self-contained
 *  and the output is deterministic). `.refine()` cross-field rules can't be represented and are dropped —
 *  acceptable for documentation. */
function toSchema(schema: ZodTypeAny): JsonSchema {
  const json = zodToJsonSchema(schema, { target: "openApi3", $refStrategy: "none" });
  delete json.$schema; // strip the JSON-Schema dialect marker; the doc is OpenAPI 3.1
  return json;
}

/** Document a request body from the same zod schema the ZodValidationPipe validates against — so the docs
 *  can never drift from validation. */
export function ApiZodBody(schema: ZodTypeAny) {
  return applyDecorators(ApiBody({ schema: toSchema(schema) as any, required: true }));
}

/** Document a response body from a zod schema (usually a `*ViewSchema`). `isArray` wraps it for list
 *  endpoints. */
export function ApiZodResponse(schema: ZodTypeAny, opts: { status?: number; isArray?: boolean; description?: string } = {}) {
  const inner = toSchema(schema);
  const finalSchema: JsonSchema = opts.isArray ? { type: "array", items: inner } : inner;
  return applyDecorators(
    ApiResponse({ status: opts.status ?? 200, description: opts.description, schema: finalSchema as any }),
  );
}
