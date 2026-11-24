/**
 * Stable identity of "the thing an event is about", shared by the repeat-window dedupe and the incident
 * providers (PagerDuty / Opsgenie) that open an incident on a failure and resolve it on the matching recovery.
 */

// Stable, UNIQUE resource-identity fields read from a fired event's ctx to build a key. Only durable
// unique ids belong here — NOT display names (e.g. tokenName is a non-unique label → deliberately excluded,
// else two distinct tokens sharing a name collapse and the second is never alerted) and NOT volatile fields
// (errorTail/sizeBytes/responseMs/durationMs/days/…). All present values are joined so an app-scoped task
// keeps appId+taskName distinct. An event carrying none of these has no safe key and is NOT deduped.
const ID_FIELDS = ["appId", "dbId", "serverId", "domain", "taskName", "monitorId"] as const;

/** A stable entity key for the resource an event is about, or "" when the ctx carries no unique identifier. */
export function entityKey(ctx: Record<string, unknown>): string {
  return ID_FIELDS.map((f) => ctx[f]).filter((v) => v != null && v !== "").map(String).join(":");
}

/** "deploy_failed" and "deploy_success" are two states of one family ("deploy"); a lone word is its own family. */
export function eventFamily(type: string): string {
  const parts = type.split("_");
  return parts.length > 1 ? parts.slice(0, -1).join("_") : type;
}

/** Correlation key linking a failure to its recovery ("monitor:<id>"), or undefined when the event has no entity. */
export function incidentKey(type: string, ctx: Record<string, unknown>): string | undefined {
  const entity = entityKey(ctx);
  return entity ? `${eventFamily(type)}:${entity}` : undefined;
}
