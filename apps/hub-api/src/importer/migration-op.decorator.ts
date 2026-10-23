import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { MigrationTokenContext } from "./migration-token.service";

/**
 * The op a {@link MigrationTokenGuard}-protected request authenticated as. The opId comes ONLY from the
 * token (resolved by the guard) — a handler must never read a destination id from the body/param/query,
 * because the caller is the untrusted source host.
 */
export const MigrationOp = createParamDecorator((_data: unknown, ctx: ExecutionContext): MigrationTokenContext => {
  return ctx.switchToHttp().getRequest().migration as MigrationTokenContext;
});
