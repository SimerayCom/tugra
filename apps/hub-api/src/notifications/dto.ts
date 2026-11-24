import { z } from "zod";
import { EVENT_TYPES, NOTIFICATION_CATEGORIES, NOTIFICATION_SEVERITIES } from "@tugra/shared";
import { isValidIana } from "../common/timezone";
import { MAX_DEDUPE_WINDOW_SEC, MAX_RATE_PER_MIN } from "./policy";

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

// ---- delivery policy ----

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const PolicySchema = z
  .object({
    quietHours: z
      .object({
        from: z.string().regex(HHMM, "use HH:mm"),
        to: z.string().regex(HHMM, "use HH:mm"),
        tz: z.string().min(1).refine(isValidIana, "unknown time zone"),
        allowCritical: z.boolean().default(true),
      })
      .refine((q) => q.from !== q.to, "from and to must differ")
      .nullable()
      .optional(),
    rateLimitPerMin: z.number().int().min(1).max(MAX_RATE_PER_MIN).nullable().optional(),
    dedupeWindowSec: z.number().int().min(0).max(MAX_DEDUPE_WINDOW_SEC).nullable().optional(),
  })
  .strict();
export type PolicyInput = z.infer<typeof PolicySchema>;

export const CreateChannelSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  teamId: z.string().min(1),
  config: z.record(z.unknown()),
  eventTypes: z.array(z.enum(EVENT_TYPES)).optional(),
  categories: z.array(CategoryEnum).optional(),
  minSeverity: z.enum(NOTIFICATION_SEVERITIES).optional(),
  topics: TopicsSchema.optional(),
  policy: PolicySchema.optional(),
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
  policy: PolicySchema.nullable().optional(), // null clears the policy
  locale: z.string().min(1).optional(),
});
export type UpdateChannelInput = z.infer<typeof UpdateChannelSchema>;

/** Body of POST /channels/:id/test — an optional category sends the test the way that category routes. */
export const TestChannelSchema = z.object({ category: CategoryEnum.optional() }).default({});
export type TestChannelInput = z.infer<typeof TestChannelSchema>;

// ---- config shapes for the channel types added with the notify engine upgrade ----

const nonEmpty = z.string().trim().min(1);
const httpUrl = z.string().url().refine((u) => /^https?:\/\//i.test(u), "must be an http(s) URL");
const phone = z.string().regex(/^\+?[0-9]{6,15}$/, "must be a phone number");

/**
 * Required-field schemas for the newer channel types, keyed by type. The service validates a create/update
 * config against the entry for the channel's type (webhook has its own schema above). Extra keys pass through.
 */
export const CHANNEL_CONFIG_SCHEMAS: Record<string, z.ZodTypeAny> = {
  matrix: z
    .object({
      homeserver: httpUrl,
      roomId: z.string().regex(/^[#!][^\s:]+:[A-Za-z0-9.:-]+$/, "must be a room id (!id:server) or alias (#name:server)"),
      accessToken: nonEmpty.optional(),
      user: nonEmpty.optional(),
      password: nonEmpty.optional(),
    })
    .passthrough()
    .refine((c) => !!c.accessToken || (!!c.user && !!c.password), "an access token, or a user and password, is required"),
  googlechat: z.object({ webhookUrl: httpUrl.refine((u) => new URL(u).hostname === "chat.googleapis.com", "must be a chat.googleapis.com webhook") }).passthrough(),
  rocketchat: z.object({ webhookUrl: httpUrl }).passthrough(),
  pagerduty: z.object({ routingKey: nonEmpty, region: z.enum(["us", "eu"]).optional() }).passthrough(),
  opsgenie: z.object({ apiKey: nonEmpty, region: z.enum(["us", "eu"]).optional() }).passthrough(),
  zulip: z.object({ server: httpUrl, email: z.string().email(), apiKey: nonEmpty, stream: nonEmpty, topic: z.string().max(60).optional() }).passthrough(),
  bark: z.object({ server: httpUrl.optional(), deviceKey: nonEmpty, group: z.string().max(64).optional() }).passthrough(),
  signal: z
    .object({
      server: httpUrl,
      number: z.string().regex(/^\+[0-9]{6,15}$/, "must be a +country number"),
      recipients: z.union([z.string(), z.array(z.string())]).refine((r) => (Array.isArray(r) ? r : r.split(",")).map((x) => x.trim()).filter(Boolean).length > 0, "at least one recipient"),
    })
    .passthrough(),
  sms: z
    .object({
      accountSid: z.string().regex(/^AC[A-Fa-f0-9]{32}$/, "must be a Twilio account SID"),
      authToken: nonEmpty,
      from: z.union([phone, z.string().regex(/^MG[A-Fa-f0-9]{32}$/, "must be a phone number or messaging service SID")]),
      to: phone,
    })
    .passthrough(),
};

// ---- create from a Shoutrrr / Apprise style URL ----

export const ChannelUrlSchema = z.object({
  teamId: z.string().min(1),
  url: z.string().min(1).max(2048),
  name: z.string().trim().min(1).max(80).optional(),
  eventTypes: z.array(z.enum(EVENT_TYPES)).optional(),
  categories: z.array(CategoryEnum).optional(),
  minSeverity: z.enum(NOTIFICATION_SEVERITIES).optional(),
  locale: z.string().min(1).default("en"),
});
export type ChannelUrlInput = z.infer<typeof ChannelUrlSchema>;

/** Body of POST /channels/parse-url — same shape, minus the routing options. */
export const ParseChannelUrlSchema = z.object({ teamId: z.string().min(1), url: z.string().min(1).max(2048) });
export type ParseChannelUrlInput = z.infer<typeof ParseChannelUrlSchema>;

// ---- weekly digest ----

export const UpdateDigestSchema = z.object({
  enabled: z.boolean(),
  channelId: z.string().min(1).nullable().optional(),
});
export type UpdateDigestInput = z.infer<typeof UpdateDigestSchema>;
