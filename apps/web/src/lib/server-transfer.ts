/** Moving a server to another team: the wire shapes of the hub's team-transfer endpoints plus small pure helpers. */

export type TransferBlockerKind = "application" | "build_server" | "database" | "monitor" | "cluster" | "app_move" | "migration" | "reboot" | "tunnel" | "log_drain" | "bulk_task";

export interface TransferBlocker {
  kind: TransferBlockerKind;
  /** Exact number of resources of this kind on the server. */
  count: number;
  /** A sample (the hub caps it); `count` may be larger than `items.length`. */
  items: { id: string; name: string }[];
}

export type TransferDetachKind = "cloud_credential" | "dns_credential" | "dns_secret" | "alert_channels";

export interface TransferDetach {
  kind: TransferDetachKind;
  name?: string;
  count?: number;
}

export interface TransferPlan {
  server: { id: string; name: string };
  from: { id: string; name: string };
  to: { id: string; name: string };
  blockers: TransferBlocker[];
  detaches: TransferDetach[];
  canMove: boolean;
}

export type BulkTransferStatus = "moved" | "unchanged" | "blocked" | "denied" | "failed";

export interface BulkTransferResult {
  serverId: string;
  status: BulkTransferStatus;
  blockers?: TransferBlocker[];
  message?: string;
}

export interface BulkTransferResponse {
  moved: number;
  results: BulkTransferResult[];
}

/** Where to look at a blocking resource (null = nothing to open for that kind). */
export function blockerHref(kind: TransferBlockerKind, id: string): string | null {
  switch (kind) {
    case "application":
    case "build_server":
      return `/apps/${id}`;
    case "database":
      return `/databases/${id}`;
    case "cluster":
      return `/clusters/${id}`;
    case "monitor":
      return "/monitors";
    default:
      return null;
  }
}

/** The `blockers` of a 409 `server_transfer_blocked` error body (a move raced a new resource), else null. */
export function blockersFromError(data: Record<string, unknown> | undefined): TransferBlocker[] | null {
  if (!data || data.code !== "server_transfer_blocked" || !Array.isArray(data.blockers)) return null;
  return data.blockers as TransferBlocker[];
}
