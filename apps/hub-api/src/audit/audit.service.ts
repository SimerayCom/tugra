import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

export interface AuditEntry {
  actor: string;
  action: string;
  target?: string;
  meta?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(entry: AuditEntry): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        actor: entry.actor,
        action: entry.action,
        target: entry.target,
        ...(entry.meta
          ? { meta: entry.meta as Prisma.InputJsonValue }
          : {}),
      },
    });
  }
}
