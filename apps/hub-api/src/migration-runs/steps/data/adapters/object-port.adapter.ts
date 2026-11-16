import { Injectable } from "@nestjs/common";
import { ObjectMigrationsService } from "../../../../object-migrations/object-migrations.service";
import type { ObjectPort, ObjectView } from "../data-contract";

/**
 * Object (S3/MinIO) migrations through the existing service (team authorization, status rules, audit and the target-agent
 * runner all stay where they are). The run never sees an endpoint or a credential: only status and bucket counters.
 */
@Injectable()
export class ObjectMigrationPort implements ObjectPort {
  constructor(private readonly objects: ObjectMigrationsService) {}

  async get(userId: string, id: string): Promise<ObjectView | null> {
    try {
      const v = await this.objects.get(userId, id);
      return {
        id: v.id,
        status: v.status,
        phase: v.phase,
        cancelRequested: v.cancelRequested,
        blockers: v.warnings.filter((w) => w.level === "blocker").length,
        buckets: v.buckets.map((b) => ({ srcBucket: b.srcBucket, selected: b.selected, status: b.status, diffMissing: b.diffMissing, diffDiffer: b.diffDiffer, diffExtra: b.diffExtra })),
      };
    } catch {
      return null; // gone, or the actor can no longer read it: the gate reports it
    }
  }

  async startSeed(userId: string, id: string): Promise<void> {
    await this.objects.start(userId, id, { phase: "seed" });
  }

  async startFinal(userId: string, id: string): Promise<void> {
    // the caller (DATA_FINAL) only gets here after FREEZE passed: the writers are stopped
    await this.objects.start(userId, id, { phase: "final", acknowledgeWritesFrozen: true, removeExtraneous: false });
  }

  async verify(userId: string, id: string): Promise<void> {
    await this.objects.verify(userId, id);
  }

  async cancel(userId: string, id: string): Promise<void> {
    await this.objects.cancel(userId, id);
  }
}
