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

  /**
   * The team's canonical default environment (its default project's default env),
   * for resolving a resource that was created without a chosen environment. Never
   * returns null: if the invariant is somehow missing for a team, it bootstraps
   * the defaults and retries rather than letting an orphan (null-env) row through.
   */
  async resolveDefaultEnvironmentId(
    teamId: string,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<string> {
    const found = await this.findDefaultEnvironmentId(teamId, client);
    if (found) return found;
    await this.ensureDefaults(teamId, client);
    const healed = await this.findDefaultEnvironmentId(teamId, client);
    if (!healed) throw new Error(`no default environment for team ${teamId}`);
    return healed;
  }

  private async findDefaultEnvironmentId(
    teamId: string,
    client: Prisma.TransactionClient,
  ): Promise<string | null> {
    const env = await client.environment.findFirst({
      where: { isDefault: true, project: { teamId, isDefault: true } },
      select: { id: true },
    });
    return env?.id ?? null;
  }
}
