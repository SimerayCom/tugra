import { applyDecorators, SetMetadata } from "@nestjs/common";
import { ApiQuery } from "@nestjs/swagger";

export const PAGINATED_KEY = "tugra:paginated";
/** Upper bound on a single page; a larger `?limit` is clamped to this (echoed in `X-Limit`). */
export const PAGINATION_MAX = 200;

/**
 * Mark a collection-list handler as opt-in paginatable. The global `PaginationInterceptor` acts ONLY on
 * routes carrying this marker — so handler-owned `?limit` routes (metrics, heartbeats, logs), SSE streams
 * and the audit cursor-envelopes are never touched. It also documents the optional `?limit` / `?cursor`
 * query params in OpenAPI.
 *
 * Pagination is NON-BREAKING: with no `?limit` the response is byte-identical (a bare array); with `?limit`
 * the handler's array is sliced and `X-Total-Count` / `X-Limit` / `X-Next-Cursor` headers are added. The
 * response body SHAPE never changes (still a bare array), so the OpenAPI contract is unaffected.
 *
 * It also documents the standard collection-list query surface as OPTIONAL. In this codebase every
 * collection list carries `@Query("q")`; the NestJS Swagger plugin otherwise defaults a bare scalar query
 * param to `required: true`, which would (wrongly) be a breaking OpenAPI change — declaring it here as
 * `required: false` pins the correct, non-breaking shape.
 */
export function Paginated(): MethodDecorator & ClassDecorator {
  return applyDecorators(
    SetMetadata(PAGINATED_KEY, true),
    ApiQuery({
      name: "q",
      required: false,
      schema: { type: "string" },
      description: "Case-insensitive substring filter over the list's non-secret name/label fields.",
    }),
    ApiQuery({
      name: "limit",
      required: false,
      schema: { type: "integer", minimum: 1, maximum: PAGINATION_MAX },
      description: `Opt-in pagination: max items to return (1–${PAGINATION_MAX}; larger is clamped). Omit for the full list.`,
    }),
    ApiQuery({
      name: "cursor",
      required: false,
      schema: { type: "string" },
      description: "Opaque cursor from a previous page's `X-Next-Cursor` response header.",
    }),
  );
}
