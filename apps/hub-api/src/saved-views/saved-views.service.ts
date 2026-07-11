import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { SavedView } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import type { CreateSavedViewInput } from "./dto";

export interface SavedViewView {
  id: string;
  name: string;
  status: string | null;
  tags: string[];
  teamId: string | null;
  canDelete: boolean;
  createdAt: Date;
}

@Injectable()
export class SavedViewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
  ) {}

  /** A user's own views + every view shared with a team they belong to. */
  async list(userId: string): Promise<SavedViewView[]> {
    const permsByTeam = await this.access.permissionsByTeam(userId);
    const views = await this.prisma.savedView.findMany({
      where: { OR: [{ userId }, { teamId: { in: [...permsByTeam.keys()] } }] },
      orderBy: { createdAt: "asc" },
    });
    return views.map((v) => this.view(v, this.mayDelete(v, userId, permsByTeam)));
  }

  async create(userId: string, dto: CreateSavedViewInput): Promise<SavedViewView> {
    if (dto.teamId) {
      const teams = await this.access.teamIds(userId);
      if (!teams.includes(dto.teamId)) throw new ForbiddenException("not a member of that team");
    }
    const v = await this.prisma.savedView.create({
      data: { userId, teamId: dto.teamId ?? null, name: dto.name, status: dto.status ?? null, tags: dto.tags ?? [] },
    });
    return this.view(v, true); // creator can always delete
  }

  async remove(userId: string, id: string): Promise<void> {
    const v = await this.prisma.savedView.findUnique({ where: { id } });
    if (!v) throw new NotFoundException("saved view not found");
    const permsByTeam = await this.access.permissionsByTeam(userId);
    if (!this.mayDelete(v, userId, permsByTeam)) throw new ForbiddenException("cannot delete this view");
    await this.prisma.savedView.delete({ where: { id } });
  }

  /** The creator, or a team admin for shared views, may delete. */
  private mayDelete(v: SavedView, userId: string, permsByTeam: Map<string, Set<string>>): boolean {
    if (v.userId === userId) return true;
    return v.teamId ? (permsByTeam.get(v.teamId)?.has("projects") ?? false) : false;
  }

  private view(v: SavedView, canDelete: boolean): SavedViewView {
    return { id: v.id, name: v.name, status: v.status, tags: v.tags, teamId: v.teamId, canDelete, createdAt: v.createdAt };
  }
}
