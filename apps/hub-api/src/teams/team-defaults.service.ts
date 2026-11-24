import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

/** Project names are capped at 80 characters (the same cap the project API enforces). */
const MAX_PROJECT_NAME = 80;

/**
 * The quick path for a resource created without a chosen environment (API, CLI, MCP, a template one-click).
 * A new team starts with NO project. The first time a resource arrives without a project, one is made for it and
 * named after the team ("Acme"), never "Default". Existing teams keep whatever default project they already have.
 */
@Injectable()
export class TeamDefaultsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Ensure the team has a default project (flagged `isDefault`) with a default environment. Idempotent: a no-op
   * when a default project already exists. A project that already carries the team's name is adopted rather than
   * duplicated; otherwise a new project named after the team is created. Accepts a transaction client.
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
    const team = await client.team.findUnique({ where: { id: teamId }, select: { name: true } });
    const name = (team?.name ?? "").trim().slice(0, MAX_PROJECT_NAME) || "Project";
    const sameName = await client.project.findFirst({
      where: { teamId, name },
      orderBy: { createdAt: "asc" },
      select: { id: true, environments: { select: { id: true, isDefault: true }, orderBy: { createdAt: "asc" } } },
    });
    if (sameName) {
      await client.project.update({ where: { id: sameName.id }, data: { isDefault: true } });
      if (sameName.environments.length === 0) {
        await client.environment.create({ data: { projectId: sameName.id, name: "production", isDefault: true } });
      } else if (!sameName.environments.some((e) => e.isDefault)) {
        await client.environment.update({ where: { id: sameName.environments[0].id }, data: { isDefault: true } });
      }
      return;
    }
    await client.project.create({
      data: {
        teamId,
        name,
        isDefault: true,
        environments: { create: { name: "production", isDefault: true } },
      },
    });
  }

  /**
   * The team's default environment (its default project's default env), for resolving a resource that was created
   * without a chosen environment. Never returns null: when the team has no default project yet (every new team),
   * it makes the team-named one and retries rather than letting an orphan (null-env) row through.
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
