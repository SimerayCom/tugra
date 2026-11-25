import { applyDecorators, INestApplication } from "@nestjs/common";
import { ApiBody, ApiResponse, DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import type { OpenAPIObject } from "@nestjs/swagger";
import { z } from "zod";
import type { ZodTypeAny } from "zod";
import { ApiErrorSchema } from "../common/api-error";
import { FsErrorBodySchema } from "../files/dto";
import { MigrationRunViewSchema } from "../migration-runs/core/dto";

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
  const doc = SwaggerModule.createDocument(app, config);
  attachErrorResponses(doc);
  return doc;
}

/**
 * Document the uniform error contract: register the shared `ApiError` component and attach the error
 * responses each operation can actually return, referencing that one component by `$ref`. Additive only —
 * it never touches an operation's success (2xx) responses or any error response already declared — so it
 * is non-breaking (oasdiff-safe). Rules per operation (codes added in a fixed order for byte-stable output):
 *   400 when it has a request body · 401 + 403 when it requires auth · 404 when it has a path param ·
 *   429 + 500 always. The `/mcp` endpoint is skipped (it speaks JSON-RPC, not this shape).
 */
function attachErrorResponses(doc: OpenAPIObject): void {
  const components = ((doc as any).components ??= {});
  (components.schemas ??= {}).ApiError = toSchema(ApiErrorSchema);
  components.schemas.FsErrorBody = toSchema(FsErrorBodySchema); // the typed error body the file routes reference
  components.schemas.MigrationRunView = toSchema(MigrationRunViewSchema); // returned by ~15 migration-run routes: one component instead of 15 inlined copies
  const errorResponse = (description: string) => ({
    description,
    content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } },
  });
  const METHODS = ["get", "put", "post", "delete", "patch"] as const;

  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    if (path === "/api/v1/mcp") continue; // the MCP endpoint speaks JSON-RPC, not this error shape
    for (const method of METHODS) {
      const op = (item as any)[method];
      if (!op) continue;
      const responses = (op.responses ??= {});
      const secured = Array.isArray(op.security) && op.security.length > 0;
      const hasBody = Boolean(op.requestBody);
      const hasPathParam = Array.isArray(op.parameters) && op.parameters.some((p: any) => p?.in === "path");
      const toAdd: Array<[string, string]> = [];
      if (hasBody) toAdd.push(["400", "Invalid or malformed request."]);
      if (secured) toAdd.push(["401", "Missing or invalid authentication."]);
      if (secured) toAdd.push(["403", "Authenticated but not permitted (scope or team permission)."]);
      if (hasPathParam) toAdd.push(["404", "Resource not found."]);
      toAdd.push(["429", "Rate limit exceeded; see Retry-After."]);
      toAdd.push(["500", "Unexpected server error."]);
      for (const [code, description] of toAdd) {
        if (!responses[code]) responses[code] = errorResponse(description);
      }
    }
  }
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
  const json = render(schema);
  delete json.$schema; // strip the JSON-Schema dialect marker; the doc is OpenAPI 3.1
  return json;
}

function render(schema: z.core.$ZodType): JsonSchema {
  return z.toJSONSchema(schema, {
    target: "openapi-3.0",
    io: "input",
    unrepresentable: "any",
    reused: "inline",
    cycles: "throw",
    override: ({ zodSchema, jsonSchema }) => keepDocumentedShape(zodSchema, jsonSchema as JsonSchema),
  }) as JsonSchema;
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function startsWithTransform(schema: z.core.$ZodType): boolean {
  const def = schema._zod.def as { type: string; in?: z.core.$ZodType; innerType?: z.core.$ZodType };
  if (def.type === "pipe") return def.in?._zod.def.type === "transform";
  return (def.type === "nullable" || def.type === "readonly") && def.innerType !== undefined && startsWithTransform(def.innerType);
}

/** Whether a body may leave this field out. Zod answers "yes" for anything that starts with a transform (a
 *  `z.preprocess`), whatever follows it; look through that to the schema it feeds. */
function optionalInput(schema: z.core.$ZodType): boolean {
  const def = schema._zod.def as { type: string; in?: z.core.$ZodType; out?: z.core.$ZodType; innerType?: z.core.$ZodType };
  if (def.type === "pipe" && def.in?._zod.def.type === "transform" && def.out) return optionalInput(def.out);
  if ((def.type === "nullable" || def.type === "readonly") && def.innerType) return optionalInput(def.innerType);
  return schema._zod.optin === "optional";
}

/** Keep the document describing the API the way it always has, where zod 4's own JSON Schema output words it
 *  differently: dates are date-time strings, formats are formats (not their regexes), integers carry no safe-range
 *  bounds, plain objects refuse extra keys while `.passthrough()` ones allow them, a discriminated union is `anyOf`,
 *  a `.default()`/`.prefault()` value is always shown, and a `.transform().pipe(schema)` keeps the limits of `schema`. */
function keepDocumentedShape(zodSchema: z.core.$ZodType, json: JsonSchema): void {
  const def = zodSchema._zod.def as {
    type: string;
    catchall?: z.core.$ZodType;
    shape?: Record<string, z.core.$ZodType>;
    discriminator?: string;
    defaultValue?: unknown;
    out?: z.core.$ZodType;
    checks?: Array<{ _zod: { def: { check: string } } }>;
  };
  switch (def.type) {
    case "date":
      Object.assign(json, { type: "string", format: "date-time" });
      break;
    case "object":
      if (!def.catchall || def.catchall._zod.def.type === "never") json.additionalProperties = false;
      else if (def.catchall._zod.def.type === "unknown" || def.catchall._zod.def.type === "any") json.additionalProperties = true;
      if (def.shape) {
        // a field behind a `z.preprocess(...)` (see common/zod-record) is still required: zod would call it optional
        const required = new Set(Array.isArray(json.required) ? (json.required as string[]) : []);
        for (const [key, prop] of Object.entries(def.shape)) if (startsWithTransform(prop) && !optionalInput(prop)) required.add(key);
        const ordered = Object.keys(def.shape).filter((k) => required.has(k));
        if (ordered.length > 0) json.required = ordered;
      }
      break;
    case "union":
      if (def.discriminator !== undefined && Array.isArray(json.oneOf)) {
        json.anyOf = json.oneOf;
        delete json.oneOf;
      }
      break;
    case "default":
    case "prefault":
      if (!("default" in json) && def.defaultValue !== undefined) json.default = JSON.parse(JSON.stringify(def.defaultValue)) as unknown;
      break;
    case "pipe":
      if (def.out && def.out._zod.def.type !== "transform") {
        const limits = render(def.out);
        for (const [k, v] of Object.entries(limits)) if (k !== "$schema" && !(k in json)) json[k] = v;
      }
      break;
    default:
      break;
  }
  if (def.type === "number" && json.type === "integer") {
    // only the bounds `.int()` implies, not a limit somebody wrote down
    const written = (kind: string) => (def.checks ?? []).some((c) => c._zod.def.check === kind);
    if (json.minimum === -MAX_SAFE && !written("greater_than")) delete json.minimum;
    if (json.maximum === MAX_SAFE && !written("less_than")) delete json.maximum;
  }
  if (typeof json.pattern === "string" && (json.format === "email" || json.format === "date-time")) delete json.pattern;
}

/** Document a request body from the same zod schema the ZodValidationPipe validates against — so the docs
 *  can never drift from validation. */
export function ApiZodBody(schema: ZodTypeAny, opts: { required?: boolean } = {}) {
  return applyDecorators(ApiBody({ schema: toSchema(schema) as any, required: opts.required ?? true }));
}

/** Document a response as a reference to a component registered in {@link attachErrorResponses} (keeps big, shared
 *  views out of every operation). */
export function ApiRefResponse(name: string, opts: { status?: number; description?: string } = {}) {
  return applyDecorators(ApiResponse({ status: opts.status ?? 200, description: opts.description, schema: { $ref: `#/components/schemas/${name}` } as any }));
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
