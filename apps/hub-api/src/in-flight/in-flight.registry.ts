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

  async track<T>(spec: { kind: InFlightKind; label: string; serverIds: string[]; teamId?: string | null }, fn: () => Promise<T>): Promise<T> {
    const id = randomBytes(6).toString("hex");
    this.active.set(id, { kind: spec.kind, id, label: spec.label, serverIds: spec.serverIds, teamId: spec.teamId ?? null, since: new Date().toISOString() });
    try {
      return await fn();
    } finally {
      this.active.delete(id);
    }
  }

  snapshot(): InFlightItem[] {
    return [...this.active.values()];
  }
}
