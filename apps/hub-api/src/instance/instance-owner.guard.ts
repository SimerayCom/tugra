import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Allow only the instance owner (the first registered user) past. MUST run AFTER JwtAuthGuard, which
 * populates `req.user.userId`. `isInstanceOwner` isn't carried on the JWT AuthUser, so it's read from the
 * DB — only owner-scoped settings routes use this guard, so the extra lookup is negligible. Fail-closed.
 */
@Injectable()
export class InstanceOwnerGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== "http") return true;
    const userId: string | undefined = ctx.switchToHttp().getRequest()?.user?.userId;
    if (!userId) throw new ForbiddenException("owner only");
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { isInstanceOwner: true } });
    if (!user?.isInstanceOwner) throw new ForbiddenException("owner only");
    return true;
  }
}
