import { Injectable } from "@nestjs/common";
import { InstanceSettings, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

const SINGLETON = "singleton";

/**
 * The single-row instance-level settings (onboarding state, registration gating, edition, self-update,
 * API gating). Mirrors the CatalogSnapshot fixed-PK singleton pattern. The row is created lazily on first
 * access; `get()` is read-only in steady state (no write per call), so per-request consumers (e.g. API
 * gating) don't cause write amplification.
 */
@Injectable()
export class InstanceSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The singleton settings row, created on first access. Read-only once it exists; race-safe. */
  async get(): Promise<InstanceSettings> {
    const existing = await this.prisma.instanceSettings.findUnique({ where: { id: SINGLETON } });
    if (existing) return existing;
    // First access (or a concurrent race): create it. `update: {}` makes the losing racer a no-op.
    return this.prisma.instanceSettings.upsert({ where: { id: SINGLETON }, create: { id: SINGLETON }, update: {} });
  }

  /** Patch the singleton (ensuring it exists first). Used by onboarding / registration-gating / settings. */
  async update(patch: Prisma.InstanceSettingsUpdateInput): Promise<InstanceSettings> {
    await this.get();
    return this.prisma.instanceSettings.update({ where: { id: SINGLETON }, data: patch });
  }
}
