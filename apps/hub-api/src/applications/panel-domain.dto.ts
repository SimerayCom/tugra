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
export const PANEL_DOMAIN_CODES = ["cert_timeout", "proxy_failed", "updater_stale", "updater_failed", "unreachable", "restore_unverified", "interrupted"] as const;

export const PanelDomainJobSchema = z.object({
  phase: z.enum(PANEL_DOMAIN_PHASES),
  action: z.enum(["set", "remove"]).nullable(),
  domain: z.string().nullable(), // the host being switched to (null while removing)
  targetUrl: z.string().nullable(), // where the panel is moving to: https://<domain>, or http://<ip> while removing
  error: z.string().nullable(),
  code: z.enum(PANEL_DOMAIN_CODES).nullable(), // why it failed; the old URL kept working (except restore_unverified: the previous setup could not be confirmed)
  detail: z.string().nullable(), // a short, sanitized tail of the proxy's certificate log
  startedAt: z.string().nullable(),
});
export type PanelDomainJob = z.infer<typeof PanelDomainJobSchema>;

export const AGENT_MOVE_REASONS = ["moved", "waiting", "offline", "old_agent"] as const;

/** How far the remote agents are in moving to the panel's new address (null once none is being waited on). */
export const AgentMoveStatusSchema = z.object({
  primaryUrl: z.string(), // the address agents are moving to (wss://…/agent)
  total: z.number().int(), // remote agents that count (every enrolled server except the one the hub runs on)
  moved: z.number().int(), // of them, reporting the new address
  pending: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      reason: z.enum(AGENT_MOVE_REASONS), // waiting = online, not switched yet · offline · old_agent = online but cannot follow (update it)
      error: z.string().nullable().optional(), // why the agent refused the pushed list, if it did
    }),
  ),
  expiresAt: z.string(), // the old address stops being routed for agents at the latest then (7 days)
  switching: z.boolean(), // the panel change itself is still running
});
export type AgentMoveStatus = z.infer<typeof AgentMoveStatusSchema>;

export const PanelDomainStatusSchema = z.object({
  mode: z.enum(["ip", "domain", "port"]), // ip = http://<ip>/ via the proxy · domain = https://<domain> · port = legacy :3001
  domain: z.string().nullable(), // the host the panel is served on right now (null in ip/port mode)
  url: z.string().nullable(), // the instance's public web URL
  ipRoute: z.boolean(),
  localServerOnline: z.boolean(),
  acmeEmail: z.string().nullable(),
  job: PanelDomainJobSchema,
  agents: AgentMoveStatusSchema.nullable(), // remote agents still moving to the new address (the old one stays routable for them)
});
export type PanelDomainStatus = z.infer<typeof PanelDomainStatusSchema>;
