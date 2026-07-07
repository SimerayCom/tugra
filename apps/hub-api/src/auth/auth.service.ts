import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { Role } from "@prisma/client";
import * as argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";
import { CryptoService } from "../crypto/crypto.service";
import { AuditService } from "../audit/audit.service";
import { TeamDefaultsService } from "../teams/team-defaults.service";
import { TotpService } from "./totp.service";

const ACCESS_TTL = "15m";
const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string | null;
  twoFaEnabled: boolean;
  uiMode: string;
}

interface RefreshPayload {
  sub: string;
  jti: string;
  family: string;
  type: "refresh";
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly crypto: CryptoService,
    private readonly totp: TotpService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
    private readonly teamDefaults: TeamDefaultsService,
  ) {}

  // ---- registration / login ------------------------------------------------

  async register(
    email: string,
    password: string,
    name?: string,
  ): Promise<{ user: PublicUser; tokens: TokenPair }> {
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictException("email already registered");
    }

    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: { email, password: passwordHash, name: name ?? null },
      });
      const team = await tx.team.create({
        data: { name: name ? `${name}'s Team` : "My Team" },
      });
      await tx.membership.create({
        data: { userId: created.id, teamId: team.id, role: Role.OWNER },
      });
      await this.teamDefaults.ensureDefaults(team.id, tx);
      return created;
    });

    await this.audit.log({ actor: user.id, action: "auth.register" });
    const tokens = await this.issueTokens(user.id);
    return { user: this.toPublicUser(user), tokens };
  }

  /**
   * Log a user in from a verified OAuth email. Creates the account (+ default
   * team) on first sign-in, reusing the register flow. OAuth users get a random
   * unusable password hash — they can't password-login, only via the provider.
   */
  async loginWithGithub(email: string, name?: string): Promise<TokenPair> {
    let user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      const passwordHash = await argon2.hash(randomUUID(), { type: argon2.argon2id });
      user = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: { email, password: passwordHash, name: name ?? null },
        });
        const team = await tx.team.create({
          data: { name: name ? `${name}'s Team` : "My Team" },
        });
        await tx.membership.create({
          data: { userId: created.id, teamId: team.id, role: Role.OWNER },
        });
        await this.teamDefaults.ensureDefaults(team.id, tx);
        return created;
      });
      await this.audit.log({ actor: user.id, action: "auth.register", meta: { provider: "github" } });
    }
    await this.audit.log({ actor: user.id, action: "auth.login", meta: { provider: "github" } });
    return this.issueTokens(user.id);
  }

  async login(
    email: string,
    password: string,
    totp?: string,
  ): Promise<{ tokens: TokenPair } | { twoFaRequired: true }> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      throw new UnauthorizedException("invalid credentials");
    }

    const valid = await argon2.verify(user.password, password);
    if (!valid) {
      await this.audit.log({
        actor: user.id,
        action: "auth.login.failed",
        meta: { reason: "bad_password" },
      });
      throw new UnauthorizedException("invalid credentials");
    }

    if (user.twoFaEnabled) {
      if (!totp) {
        return { twoFaRequired: true };
      }
      const secret = this.crypto.decrypt(user.twoFaSecret as string);
      if (!this.totp.verify(totp, secret)) {
        await this.audit.log({
          actor: user.id,
          action: "auth.login.failed",
          meta: { reason: "bad_totp" },
        });
        throw new UnauthorizedException("invalid 2FA code");
      }
    }

    await this.audit.log({ actor: user.id, action: "auth.login" });
    return { tokens: await this.issueTokens(user.id) };
  }

  // ---- tokens (rotation + reuse detection) ---------------------------------

  async issueTokens(userId: string, family?: string): Promise<TokenPair> {
    const fam = family ?? randomUUID();
    const jti = randomUUID();

    const accessToken = await this.jwt.signAsync(
      { sub: userId, type: "access" },
      {
        secret: this.config.get<string>("JWT_ACCESS_SECRET"),
        expiresIn: ACCESS_TTL,
      },
    );
    const refreshToken = await this.jwt.signAsync(
      { sub: userId, jti, family: fam, type: "refresh" },
      {
        secret: this.config.get<string>("JWT_REFRESH_SECRET"),
        expiresIn: REFRESH_TTL_SECONDS,
      },
    );

    await this.redis.set(`rt:${jti}`, userId, REFRESH_TTL_SECONDS);
    await this.redis.sadd(`rtfam:${fam}`, jti);
    await this.redis.expire(`rtfam:${fam}`, REFRESH_TTL_SECONDS);

    return { accessToken, refreshToken };
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    let payload: RefreshPayload;
    try {
      payload = await this.jwt.verifyAsync<RefreshPayload>(refreshToken, {
        secret: this.config.get<string>("JWT_REFRESH_SECRET"),
      });
    } catch {
      throw new UnauthorizedException("invalid refresh token");
    }
    if (payload.type !== "refresh") {
      throw new UnauthorizedException("invalid token type");
    }

    const stored = await this.redis.get(`rt:${payload.jti}`);
    if (!stored) {
      // Reuse (or already-revoked): nuke the whole family.
      await this.revokeFamily(payload.family);
      await this.audit.log({
        actor: payload.sub,
        action: "auth.refresh.reuse_detected",
        meta: { family: payload.family },
      });
      throw new UnauthorizedException("refresh token reuse detected");
    }

    // Rotate: invalidate the used token, issue a new pair in the same family.
    await this.redis.del(`rt:${payload.jti}`);
    await this.redis.srem(`rtfam:${payload.family}`, payload.jti);
    return this.issueTokens(payload.sub, payload.family);
  }

  async logout(refreshToken: string): Promise<void> {
    try {
      const payload = await this.jwt.verifyAsync<RefreshPayload>(refreshToken, {
        secret: this.config.get<string>("JWT_REFRESH_SECRET"),
      });
      await this.revokeFamily(payload.family);
      await this.audit.log({ actor: payload.sub, action: "auth.logout" });
    } catch {
      // Logging out with an invalid/expired token is a no-op.
    }
  }

  private async revokeFamily(family: string): Promise<void> {
    const members = await this.redis.smembers(`rtfam:${family}`);
    await this.redis.del(
      `rtfam:${family}`,
      ...members.map((jti) => `rt:${jti}`),
    );
  }

  // ---- 2FA -----------------------------------------------------------------

  async setup2FA(
    userId: string,
  ): Promise<{ otpauthUrl: string; qrDataUrl: string }> {
    const user = await this.requireUser(userId);
    const secret = this.totp.generateSecret();
    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFaSecret: this.crypto.encrypt(secret), twoFaEnabled: false },
    });
    const otpauthUrl = this.totp.keyUri(user.email, secret);
    return { otpauthUrl, qrDataUrl: await this.totp.qrDataUrl(otpauthUrl) };
  }

  async enable2FA(userId: string, token: string): Promise<void> {
    const user = await this.requireUser(userId);
    if (!user.twoFaSecret) {
      throw new UnauthorizedException("2FA not set up");
    }
    const secret = this.crypto.decrypt(user.twoFaSecret);
    if (!this.totp.verify(token, secret)) {
      throw new UnauthorizedException("invalid 2FA code");
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFaEnabled: true },
    });
    await this.audit.log({ actor: userId, action: "auth.2fa.enabled" });
  }

  async me(userId: string): Promise<PublicUser> {
    return this.toPublicUser(await this.requireUser(userId));
  }

  /** Update the current user's display name and/or email. */
  async updateProfile(
    userId: string,
    input: { name?: string; email?: string; uiMode?: "fleet" | "home" },
  ): Promise<PublicUser> {
    const user = await this.requireUser(userId);
    if (input.email && input.email !== user.email) {
      const taken = await this.prisma.user.findUnique({ where: { email: input.email } });
      if (taken && taken.id !== userId) throw new ConflictException("email already in use");
    }
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.uiMode !== undefined ? { uiMode: input.uiMode } : {}),
      },
    });
    await this.audit.log({ actor: userId, action: "auth.profile.update" });
    return this.toPublicUser(updated);
  }

  /** Change the current user's password (verifies the current one first). */
  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.requireUser(userId);
    if (!(await argon2.verify(user.password, currentPassword))) {
      throw new UnauthorizedException("current password is incorrect");
    }
    const passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id });
    await this.prisma.user.update({ where: { id: userId }, data: { password: passwordHash } });
    await this.audit.log({ actor: userId, action: "auth.password.change" });
  }

  private async requireUser(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException("user not found");
    }
    return user;
  }

  private toPublicUser(user: {
    id: string;
    email: string;
    name: string | null;
    twoFaEnabled: boolean;
    uiMode: string;
  }): PublicUser {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      twoFaEnabled: user.twoFaEnabled,
      uiMode: user.uiMode,
    };
  }
}
