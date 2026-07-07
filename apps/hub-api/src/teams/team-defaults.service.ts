import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Guarantees the invariant every later resource-flow step relies on: each team
 * has exactly one default project, and that project has a default "production"
 * environment. Called on team creation (register / OAuth / explicit) so a brand
 * new team is never an empty dead-end.
 */
@Injectable()
export class TeamDefaultsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Ensure the team has a default project + default production environment.
   * Idempotent: a no-op when a default project already exists. Accepts a
   * transaction client so it can run inside the team-creation transaction.
   */
  async ensureDefaults(
    teamId: string,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    const existing = await client.project.findFirst({
      where: { teamId, isDefault: true },
      select: { id: true },
    });
    if (existing) return;
    await client.project.create({
      data: {
        teamId,
        name: "Default",
        isDefault: true,
        environments: { create: { name: "production", isDefault: true } },
      },
    });
  }
}
