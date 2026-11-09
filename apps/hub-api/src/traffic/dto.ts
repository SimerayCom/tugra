import { z } from "zod";

const RANGES = ["1h", "6h", "24h", "7d", "30d"] as const;

// Shared query shape: unknown/missing range falls back to the service default; domain is a free-form host.
export const TrafficQuerySchema = z.object({
  range: z.enum(RANGES).optional(),
  teamId: z.string().min(1).max(64).optional(),
  domain: z.string().min(1).max(253).optional(),
});
export type TrafficQuery = z.infer<typeof TrafficQuerySchema>;

export const TrafficPathsQuerySchema = TrafficQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type TrafficPathsQuery = z.infer<typeof TrafficPathsQuerySchema>;

export const TrafficDomainsQuerySchema = z.object({
  range: z.enum(RANGES).optional(),
  teamId: z.string().min(1).max(64).optional(),
});
export type TrafficDomainsQuery = z.infer<typeof TrafficDomainsQuerySchema>;

export const TrafficDomainRowSchema = z.object({
  domain: z.string(),
  appId: z.string().nullable(),
  appName: z.string().nullable(),
  requests: z.number(),
});

const Totals = z.object({
  requests: z.number(),
  s2xx: z.number(),
  s3xx: z.number(),
  s4xx: z.number(),
  s5xx: z.number(),
  bytes: z.number(),
});

// Aligned arrays: index i of every series is the bucket starting at times[i] (unix ms).
export const TrafficSummarySchema = z.object({
  range: z.string(),
  stepSec: z.number(),
  times: z.array(z.number()),
  requests: z.array(z.number()),
  s2xx: z.array(z.number()),
  s3xx: z.array(z.number()),
  s4xx: z.array(z.number()),
  s5xx: z.array(z.number()),
  bytes: z.array(z.number()),
  totals: Totals,
});

export const TrafficPathsSchema = z.object({
  range: z.string(),
  paths: z.array(z.object({ path: z.string(), requests: z.number(), bytes: z.number() })),
  // Everything the agent folded into "(other)" (overflow beyond its per-minute top-N), reported separately.
  other: z.object({ requests: z.number(), bytes: z.number() }),
});
