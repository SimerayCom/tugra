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

export const TrafficCountriesQuerySchema = TrafficQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(250).optional(),
});
export type TrafficCountriesQuery = z.infer<typeof TrafficCountriesQuerySchema>;

export const TrafficBreakdownQuerySchema = TrafficQuerySchema.extend({
  dim: z.enum(["browser", "os", "device", "referrer", "city", "network"]),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type TrafficBreakdownQuery = z.infer<typeof TrafficBreakdownQuerySchema>;

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
  botRequests: z.number(),
  humanRequests: z.number(),
  // Overall p95 latency (ms) over the range, interpolated from the latency histogram; 0 = no latency data.
  p95Ms: z.number(),
  // Distinct visitors over the range: a merged HyperLogLog estimate (about +-1.6%), never summed per bucket; 0 = none.
  uniqueVisitors: z.number(),
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
  // p95 latency (ms) per bucket (cumulative interpolation over the fixed histogram bounds; the overflow bucket
  // reports its 10000 ms lower bound as a floor); 0 where a bucket has no latency data.
  p95Ms: z.array(z.number()),
  // Distinct visitors per bucket (each bucket is its own sketch estimate, so the series does NOT sum to the total).
  uniqueVisitors: z.array(z.number()),
  totals: Totals,
});

export const TrafficPathsSchema = z.object({
  range: z.string(),
  paths: z.array(z.object({ path: z.string(), requests: z.number(), bytes: z.number() })),
  // Everything the agent folded into "(other)" (overflow beyond its per-minute top-N), reported separately.
  other: z.object({ requests: z.number(), bytes: z.number() }),
});

export const TrafficCountriesSchema = z.object({
  range: z.string(),
  // ISO-3166 alpha-2 codes; "ZZ" = unknown (unresolved or beyond the agent's per-minute top-N).
  countries: z.array(z.object({ country: z.string(), requests: z.number() })),
});

export const TrafficBreakdownSchema = z.object({
  range: z.string(),
  dim: z.enum(["browser", "os", "device", "referrer", "city", "network"]),
  items: z.array(z.object({ key: z.string(), requests: z.number() })),
  // Everything the agent folded into "(other)" (overflow beyond its per-minute top-N), reported separately.
  other: z.object({ requests: z.number() }),
});
