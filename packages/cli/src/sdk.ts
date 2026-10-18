/**
 * Typed SDK surface for the Tugra REST API — generated from the committed OpenAPI contract
 * (`apps/hub-api/openapi.json`) with `openapi-typescript`. Regenerate after the contract changes:
 *   pnpm --filter @tugra/cli generate:api
 *
 * These are compile-time types only (no runtime client); pair them with any fetch wrapper (e.g.
 * `openapi-fetch`) or with this package's own `ApiClient`. A drift test keeps them in sync with the spec.
 */
import type { paths, components, operations } from "./generated/schema";

export type { paths, components, operations };

/** Every documented API path, e.g. `"/api/v1/apps"` — the keys of the OpenAPI `paths` object. */
export type ApiPath = keyof paths;

/** The uniform error body returned by every endpoint (see docs/api.md "Errors"). */
export type ApiError = components["schemas"]["ApiError"];
