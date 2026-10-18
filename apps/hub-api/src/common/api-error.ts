import { z } from "zod";

/**
 * The single error-response shape for the REST API. A strict superset of NestJS's default HttpException
 * body, so existing clients (which read `message`) are unaffected:
 *  - `statusCode` — the HTTP status, repeated in the body.
 *  - `error`      — the status reason phrase (e.g. "Bad Request", "Not Found").
 *  - `message`    — a human-readable message, OR an array of messages (field-validation errors are an array).
 */
export const ApiErrorSchema = z.object({
  statusCode: z.number().int(),
  error: z.string(),
  message: z.union([z.string(), z.array(z.string())]),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
