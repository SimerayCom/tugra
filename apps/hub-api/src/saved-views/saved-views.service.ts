import { Injectable, NotFoundException } from "@nestjs/common";
import { SavedView } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type { CreateSavedViewInput } from "./dto";

export interface SavedViewView {
  id: string;
  name: string;
  status: string | null;
  tags: string[];
  createdAt: Date;
}

@Injectable()
export class SavedViewsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string): Promise<SavedViewView[]> {
    const views = await this.prisma.savedView.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    });
    return views.map((v) => this.view(v));
  }

  async create(userId: string, dto: CreateSavedViewInput): Promise<SavedViewView> {
    const v = await this.prisma.savedView.create({
      data: { userId, name: dto.name, status: dto.status ?? null, tags: dto.tags ?? [] },
    });
    return this.view(v);
  }

  async remove(userId: string, id: string): Promise<void> {
    const v = await this.prisma.savedView.findFirst({ where: { id, userId } });
    if (!v) throw new NotFoundException("saved view not found");
    await this.prisma.savedView.delete({ where: { id } });
  }

  private view(v: SavedView): SavedViewView {
    return { id: v.id, name: v.name, status: v.status, tags: v.tags, createdAt: v.createdAt };
  }
}
