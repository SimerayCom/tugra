import { Injectable } from "@nestjs/common";

/**
 * In-process registry of the SOURCE databases with a point-in-time replay in flight (claimed by
 * PitrRestoreService.start before any row exists, released when the replay finishes). Shared with the base-backup
 * retention so a prune never races a replay that has not yet written its Restore row: the restore side claims
 * then reads its base + WAL; the prune side checks the claim (and the RUNNING row) before each destructive step.
 * Single-hub by design (like the databases maintenance lock); the Restore row is the cross-restart backstop.
 */
@Injectable()
export class PitrClaimsService {
  private readonly bySource = new Set<string>();

  has(sourceId: string): boolean {
    return this.bySource.has(sourceId);
  }

  /** Claim `sourceId`; false when it is already claimed (synchronous: no await between check and add). */
  claim(sourceId: string): boolean {
    if (this.bySource.has(sourceId)) return false;
    this.bySource.add(sourceId);
    return true;
  }

  release(sourceId: string): void {
    this.bySource.delete(sourceId);
  }
}
