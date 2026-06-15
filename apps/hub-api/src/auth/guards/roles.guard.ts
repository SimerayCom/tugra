import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Role } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { ROLES_KEY } from "../decorators/roles.decorator";

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const userId: string | undefined = request.user?.userId;
    if (!userId) {
      return false;
    }

    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      select: { role: true },
    });
    const roles = new Set(memberships.map((m) => m.role));
    return required.some((r) => roles.has(r));
  }
}
