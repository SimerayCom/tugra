import { z } from "zod";

/** Owner action: serve the panel on this domain (HTTPS via Let's Encrypt HTTP-01). The ACME email is optional. */
export const SetPanelDomainSchema = z.object({
  domain: z.string().trim().min(1).max(253),
  acmeEmail: z.string().trim().max(320).optional(),
});
export type SetPanelDomainInput = z.infer<typeof SetPanelDomainSchema>;

/** Owner action: go back to http://<server-ip>/. `publicIp` is only needed when the hub does not know the address. */
export const RemovePanelDomainSchema = z.object({
  publicIp: z
    .string()
    .trim()
    .regex(/^(\d{1,3}\.){3}\d{1,3}$/, "must be a bare IPv4 address")
    .optional(),
});
export type RemovePanelDomainInput = z.infer<typeof RemovePanelDomainSchema>;

export const PANEL_DOMAIN_PHASES = ["idle", "proxy", "certificate", "switching", "done", "failed"] as const;
export const PANEL_DOMAIN_CODES = ["cert_timeout", "proxy_failed", "updater_stale", "updater_failed", "interrupted"] as const;

export const PanelDomainJobSchema = z.object({
  phase: z.enum(PANEL_DOMAIN_PHASES),
  action: z.enum(["set", "remove"]).nullable(),
  domain: z.string().nullable(), // the host being switched to (null while removing)
  error: z.string().nullable(),
  code: z.enum(PANEL_DOMAIN_CODES).nullable(), // why it failed; the old URL kept working
  detail: z.string().nullable(), // a short, sanitized tail of the proxy's certificate log
  startedAt: z.string().nullable(),
});
export type PanelDomainJob = z.infer<typeof PanelDomainJobSchema>;

export const PanelDomainStatusSchema = z.object({
  mode: z.enum(["ip", "domain", "port"]), // ip = http://<ip>/ via the proxy · domain = https://<domain> · port = legacy :3001
  domain: z.string().nullable(), // the host the panel is served on right now (null in ip/port mode)
  url: z.string().nullable(), // the instance's public web URL
  ipRoute: z.boolean(),
  localServerOnline: z.boolean(),
  acmeEmail: z.string().nullable(),
  job: PanelDomainJobSchema,
});
export type PanelDomainStatus = z.infer<typeof PanelDomainStatusSchema>;
