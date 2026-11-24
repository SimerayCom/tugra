import { z } from "zod";
import { EVENT_TYPES, NOTIFICATION_CATEGORIES, NOTIFICATION_SEVERITIES } from "@tugra/shared";

export { EVENT_TYPES, NOTIFICATION_CATEGORIES, NOTIFICATION_SEVERITIES };

// Reserved outbound headers a user's custom headers may not set: the ones we control (content-type +
// signature) plus request-framing / hop-by-hop headers (a user Content-Length/Transfer-Encoding would
// desync the body → request smuggling).
const RESERVED_HEADERS = new Set([
  "content-type",
  "x-tugra-signature",
  "content-length",
  "transfer-encoding",
  "connection",
  "host",
]);
const HeaderName = z.string().regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/, "invalid header name");
const HeaderValue = z.string().regex(/^[^\r\n]*$/, "header value may not contain CR/LF").max(4096);

/** Webhook-channel config shape (validated in the service, keyed on the resolved channel type). */
export const WebhookConfigSchema = z
  .object({
    url: z.string().url(),
    signingSecret: z.string().min(16).optional(),
    headers: z
      .record(HeaderName, HeaderValue)
      .refine((h) => !Object.keys(h).some((k) => RESERVED_HEADERS.has(k.toLowerCase())), "cannot set a reserved header")
      .optional(),
  })
  .passthrough();

const CategoryEnum = z.enum(NOTIFICATION_CATEGORIES);
/** Telegram forum topics: category → message_thread_id (a positive 32-bit int). */
const TopicId = z.number().int().positive().max(2147483647);
export const TopicsSchema = z
  .object({
    uptime: TopicId.optional(),
    deploy: TopicId.optional(),
    backup: TopicId.optional(),
    server: TopicId.optional(),
    security: TopicId.optional(),
    updates: TopicId.optional(),
  })
  .strict();

export const CreateChannelSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  teamId: z.string().min(1),
  config: z.record(z.unknown()),
  eventTypes: z.array(z.enum(EVENT_TYPES)).optional(),
  categories: z.array(CategoryEnum).optional(),
  minSeverity: z.enum(NOTIFICATION_SEVERITIES).optional(),
  topics: TopicsSchema.optional(),
  locale: z.string().min(1).default("en"),
});
export type CreateChannelInput = z.infer<typeof CreateChannelSchema>;

export const UpdateChannelSchema = z.object({
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  eventTypes: z.array(z.enum(EVENT_TYPES)).optional(),
  categories: z.array(CategoryEnum).optional(),
  minSeverity: z.enum(NOTIFICATION_SEVERITIES).optional(),
  topics: TopicsSchema.nullable().optional(), // null clears the map
  config: z.record(z.unknown()).optional(),
  locale: z.string().min(1).optional(),
});
export type UpdateChannelInput = z.infer<typeof UpdateChannelSchema>;

/** Body of POST /channels/:id/test — an optional category sends the test the way that category routes. */
export const TestChannelSchema = z.object({ category: CategoryEnum.optional() }).default({});
export type TestChannelInput = z.infer<typeof TestChannelSchema>;
