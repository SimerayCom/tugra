import { Injectable } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import type { InFlightItem, InFlightKind } from "./in-flight.dto";

/**
 * Work that lives only in this process (a server patch run, a swarm promote or ingress change): there is no row to read, so the code that
 * does it wraps the call in `track`. An update restarts this very process, which is exactly the process that knows about it. The entry is
 * removed when the call settles, however it ends.
 */
@Injectable()
export class InFlightRegistry {
  private readonly active = new Map<string, InFlightItem>();

  /** `id` is the thing the work is on (a cluster id, a server id) so the panel can link to it; it may repeat across concurrent calls. */
  async track<T>(spec: { kind: InFlightKind; id?: string; label: string; serverIds: string[]; teamId?: string | null }, fn: () => Promise<T>): Promise<T> {
    const key = randomBytes(6).toString("hex");
    this.active.set(key, { kind: spec.kind, id: spec.id ?? key, label: spec.label, serverIds: spec.serverIds, teamId: spec.teamId ?? null, since: new Date().toISOString() });
    try {
      return await fn();
    } finally {
      this.active.delete(key);
    }
  }

  snapshot(): InFlightItem[] {
    return [...this.active.values()];
  }
}
