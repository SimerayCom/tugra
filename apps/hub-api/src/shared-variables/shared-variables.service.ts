import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Role, SharedVariable } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { CryptoService } from "../crypto/crypto.service";

const WRITE: Role[] = [Role.OWNER, Role.ADMIN];

export interface SharedVarView {
  id: string;
  teamId: string;
  key: string;
  value: string | null; // decrypted only for writers
  canWrite: boolean;
  createdAt: Date;
}

@Injectable()
export class SharedVariablesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
  ) {}

  async list(userId: string, teamId: string): Promise<SharedVarView[]> {
    const role = await this.access.teamRole(userId, teamId);
    if (!role) throw new ForbiddenException("not a member of this team");
    const canWrite = WRITE.includes(role);
    const vars = await this.prisma.sharedVariable.findMany({
      where: { teamId },
      orderBy: { key: "asc" },
    });
    return vars.map((v) => ({
      id: v.id,
      teamId: v.teamId,
      key: v.key,
      value: canWrite ? this.crypto.decrypt(v.valueEnc) : null,
      canWrite,
      createdAt: v.createdAt,
    }));
  }

  async upsert(userId: string, teamId: string, key: string, value: string): Promise<SharedVarView> {
    await this.access.requireRole(userId, teamId, WRITE);
    const v = await this.prisma.sharedVariable.upsert({
      where: { teamId_key: { teamId, key } },
      create: { teamId, key, valueEnc: this.crypto.encrypt(value) },
      update: { valueEnc: this.crypto.encrypt(value) },
    });
    await this.audit.log({ actor: userId, action: "shared_var.set", target: teamId, meta: { key } });
    return { id: v.id, teamId: v.teamId, key: v.key, value, canWrite: true, createdAt: v.createdAt };
  }

  async remove(userId: string, id: string): Promise<void> {
    const v = await this.prisma.sharedVariable.findUnique({ where: { id } });
    if (!v) throw new NotFoundException("variable not found");
    await this.access.requireRole(userId, v.teamId, WRITE);
    await this.prisma.sharedVariable.delete({ where: { id } });
    await this.audit.log({ actor: userId, action: "shared_var.remove", target: v.teamId, meta: { key: v.key } });
  }

  /** Internal: decrypted team-wide variables, for merging into a deploy's env. */
  async resolvedMap(teamId: string): Promise<Record<string, string>> {
    const vars = await this.prisma.sharedVariable.findMany({ where: { teamId } });
    const out: Record<string, string> = {};
    for (const v of vars) out[v.key] = this.crypto.decrypt(v.valueEnc);
    return out;
  }
}
