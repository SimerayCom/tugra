import net from "node:net";
import { z } from "zod";
import { isPctMetric } from "./checkers";

export const METRIC_KINDS = ["DISK", "CPU", "MEM", "LOAD1", "LOAD5", "LOAD15", "TEMP", "NET"] as const;

export const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
export const DNS_RECORD_TYPES = ["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SRV", "CAA", "PTR"] as const;

// Request headers a monitor may send. Framing / hop-by-hop headers are refused (a user Content-Length or
// Transfer-Encoding would desync the request); everything else, including Host and Authorization, is the user's call.
const BLOCKED_HEADERS = new Set(["content-length", "transfer-encoding", "connection"]);
const HeaderName = z.string().regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/, "invalid header name").max(128);
const HeaderValue = z.string().regex(/^[^\r\n]*$/, "header value may not contain CR/LF").max(4096);
export const MonitorHeadersSchema = z
  .record(HeaderName, HeaderValue)
  .refine((h) => !Object.keys(h).some((k) => BLOCKED_HEADERS.has(k.toLowerCase())), "cannot set a framing header")
  .refine((h) => Object.keys(h).length <= 50, "too many headers");

/** "200", "200-299" — an accepted HTTP status code or range. */
export const StatusRangeSchema = z.string().regex(/^[1-5]\d{2}(-[1-5]\d{2})?$/, "use 200 or 200-299");

/** A resolver address: an IP, optionally with a port ("1.1.1.1", "1.1.1.1:5353", "[::1]:53"). */
function validResolver(v: string): boolean {
  const bracket = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(v);
  if (bracket) return net.isIPv6(bracket[1]);
  if (net.isIP(v)) return true;
  const m = /^([^:]+):(\d{1,5})$/.exec(v);
  return !!m && net.isIPv4(m[1]);
}

/** Options shared by create and update (all optional). */
const optionsShape = {
  method: z.enum(HTTP_METHODS).optional(),
  keyword: z.string().min(1).max(1024).optional(),
  keywordInvert: z.boolean().optional(),
  acceptedStatus: z.array(StatusRangeSchema).max(32).optional(),
  // Request headers / basic auth / body are stored encrypted (they usually carry credentials).
  headers: MonitorHeadersSchema.optional(),
  basicAuth: z.object({ user: z.string().max(256), pass: z.string().max(1024) }).optional(),
  body: z.string().max(65536).optional(),
  ignoreTls: z.boolean().optional(),
  maxRedirects: z.number().int().min(0).max(20).optional(),
  upsideDown: z.boolean().optional(),
  dnsRecordType: z.enum(DNS_RECORD_TYPES).optional(),
  dnsServer: z.string().max(128).refine(validResolver, "use an IP address, optionally with a port").optional(),
  dnsExpect: z.string().min(1).max(512).optional(),
};

export const CreateMonitorSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum(["HTTP", "TCP", "METRIC", "KEYWORD", "PING", "DNS"]),
    target: z.string().min(1).optional(),
    serverId: z.string().min(1).optional(),
    metric: z.enum(METRIC_KINDS).optional(),
    thresholdPct: z.number().int().min(1).max(100).optional(),
    /** Limit for the absolute-unit kinds: load average, temperature in °C, bandwidth in MB/s. */
    thresholdValue: z.number().positive().max(100_000).optional(),
    teamId: z.string().min(1),
    intervalSec: z.number().int().min(10).optional(),
    retries: z.number().int().min(0).optional(),
    timeoutMs: z.number().int().min(1000).optional(),
    resendEvery: z.number().int().min(0).optional(),
    channelIds: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    ...optionsShape,
  })
  .refine(
    (d) =>
      d.type === "METRIC"
        ? !!d.serverId && !!d.metric && (isPctMetric(d.metric) ? d.thresholdPct != null : d.thresholdValue != null)
        : !!d.target,
    {
      message:
        "HTTP/TCP/KEYWORD/PING/DNS need target; METRIC needs serverId, metric and a threshold (thresholdPct for DISK/CPU/MEM, thresholdValue otherwise)",
      path: ["type"],
    },
  )
  .refine((d) => d.type !== "KEYWORD" || !!d.keyword, { message: "KEYWORD needs a keyword", path: ["keyword"] });
export type CreateMonitorInput = z.infer<typeof CreateMonitorSchema>;

export const UpdateMonitorSchema = z.object({
  name: z.string().min(1).optional(),
  intervalSec: z.number().int().min(10).optional(),
  retries: z.number().int().min(0).optional(),
  timeoutMs: z.number().int().min(1000).optional(),
  resendEvery: z.number().int().min(0).optional(),
  /** New limit of a metric monitor: thresholdPct for DISK/CPU/MEM, thresholdValue for the rest. */
  thresholdPct: z.number().int().min(1).max(100).optional(),
  thresholdValue: z.number().positive().max(100_000).optional(),
  enabled: z.boolean().optional(),
  channelIds: z.array(z.string()).optional(),
  ...optionsShape,
});
export type UpdateMonitorInput = z.infer<typeof UpdateMonitorSchema>;

// Set the same notification channels on many monitors at once (fleet alert op).
// Each monitor receives only the channels that belong to its own team.
export const BulkMonitorChannelsSchema = z.object({
  monitorIds: z.array(z.string().min(1)).min(1),
  channelIds: z.array(z.string().min(1)).min(1),
});
export type BulkMonitorChannelsInput = z.infer<typeof BulkMonitorChannelsSchema>;
