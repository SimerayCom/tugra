import type { ServerView } from "./types";

/**
 * Why a Move / Adopt / Migrate button cannot work right now, decided from what the page already knows about a server, so the button can
 * say so (and how to fix it) before the click instead of failing with a generic error afterwards.
 */
export type CtaBlockCode = "pending" | "offline" | "no_write" | "capability";
export interface CtaBlock {
  code: CtaBlockCode;
  /** The capabilities this action needs that the server has not been granted (code `capability`). */
  missing: string[];
}

type ServerFacts = Pick<ServerView, "status" | "canWrite" | "capabilities">;

/** A capability is granted when it is listed. An empty list grants nothing (the hub fails closed). */
export function hasCapability(server: Pick<ServerView, "capabilities">, cap: string): boolean {
  return (server.capabilities ?? []).includes(cap);
}

/**
 * The first thing in the way of an action on this server, or null when it can go ahead. Order matches what the user can fix first:
 * connect the agent, bring it online, get write access, then grant capabilities.
 */
export function serverBlock(server: ServerFacts, needs: readonly string[] = [], opts: { write?: boolean } = {}): CtaBlock | null {
  if (server.status === "PENDING") return { code: "pending", missing: [] };
  if (server.status !== "ONLINE") return { code: "offline", missing: [] };
  if (opts.write !== false && !server.canWrite) return { code: "no_write", missing: [] };
  const missing = needs.filter((c) => !hasCapability(server, c));
  return missing.length > 0 ? { code: "capability", missing } : null;
}

/** Where the capability switches of a server live. */
export const capabilitiesHref = (serverId: string): string => `/servers/${serverId}?tab=maintenance`;

type T = (key: string, vars?: Record<string, string | number>) => string;

/** One plain line for a block ("Needs the Deploy apps and Backups capabilities on this server."). */
export function blockText(t: T, b: CtaBlock): string {
  if (b.code === "pending") return t("servers.cta.blockPending");
  if (b.code === "offline") return t("servers.cta.blockOffline");
  if (b.code === "no_write") return t("servers.cta.blockNoWrite");
  return t("servers.cta.blockCapability", { caps: b.missing.map((c) => t(`servers.cap_${c}`)).join(", ") });
}

/** The same line for an option label ("Name (offline)"): a short tag, not a sentence. */
export function blockTag(t: T, b: CtaBlock): string {
  if (b.code === "pending") return t("servers.cta.tagPending");
  if (b.code === "offline") return t("servers.cta.tagOffline");
  if (b.code === "no_write") return t("servers.cta.tagNoWrite");
  return t("servers.cta.tagCapability");
}
