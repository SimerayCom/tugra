import { z } from "zod";

const Base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/, "must be base64url");

/** The JSON a browser's `PushSubscription.toJSON()` yields, plus an optional friendly device name. */
export const SubscribePushSchema = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({ p256dh: Base64Url.max(128), auth: Base64Url.max(64) }),
  deviceLabel: z.string().trim().min(1).max(80).optional(),
});
export type SubscribePushInput = z.infer<typeof SubscribePushSchema>;

/** Optional, client-localized wording for the test notification. */
export const TestPushSchema = z
  .object({ title: z.string().trim().min(1).max(120).optional(), body: z.string().trim().min(1).max(400).optional() })
  .default({});
export type TestPushInput = z.infer<typeof TestPushSchema>;
