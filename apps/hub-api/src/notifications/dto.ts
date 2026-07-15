import { z } from "zod";
import { EVENT_TYPES } from "@tugra/shared";

export { EVENT_TYPES };

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

export const CreateChannelSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  teamId: z.string().min(1),
  config: z.record(z.unknown()),
  eventTypes: z.array(z.enum(EVENT_TYPES)).optional(),
});
export type CreateChannelInput = z.infer<typeof CreateChannelSchema>;

export const UpdateChannelSchema = z.object({
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  eventTypes: z.array(z.enum(EVENT_TYPES)).optional(),
  config: z.record(z.unknown()).optional(),
});
export type UpdateChannelInput = z.infer<typeof UpdateChannelSchema>;
