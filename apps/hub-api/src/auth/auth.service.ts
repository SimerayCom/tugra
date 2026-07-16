import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { Role, VerificationPurpose } from "@prisma/client";
import * as argon2 from "argon2";
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";
import { CryptoService } from "../crypto/crypto.service";
import { AuditService } from "../audit/audit.service";
import { MailService } from "../mail/mail.service";
import {
  resetPasswordEmail,
  verifyEmail as verifyEmailTemplate,
  emailChangeNoticeEmail,
} from "../mail/templates";
import { TeamDefaultsService } from "../teams/team-defaults.service";
import { InstanceSettingsService } from "../instance/instance-settings.service";
import { TotpService } from "./totp.service";
import { generateRecoveryCodes, recoveryHashInput } from "./recovery-codes";
import { hashToken } from "../api-tokens/api-token.util";
import { webBaseUrl } from "../common/web-url";

const ACCESS_TTL = "15m";
const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;

// Per-email login defence (complements the per-IP throttle, which shared NAT egress can defeat).
// A high per-email burst backstop that never trips for a human but caps a scripted flood; the
// LOCKOUT below (kept lower) is the primary brute-force defence and stays reachable first.
const LOGIN_RATE_MAX = 20; // login attempts per email per window before a soft 429
const LOGIN_RATE_WINDOW = 60; // seconds
const LOCKOUT_THRESHOLD = 10; // failed attempts within the window → temporary lock
const LOCKOUT_WINDOW = 15 * 60; // 900s — both the fail-counter window and the lock duration (bounded, auto-clears)

// Password reset: short-lived emailed token + a per-email request cap.
const PASSWORD_RESET_TTL_MS = 45 * 60 * 1000; // 45 min (matches the email copy)
const PASSWORD_RESET_RATE_MAX = 5; // reset requests per email per window before a soft 429
const PASSWORD_RESET_RATE_WINDOW = 60; // seconds

// Email verification: a longer-lived emailed token (people verify hours later, from another device).
const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string | null;
  twoFaEnabled: boolean;
  emailVerified: boolean;
  uiMode: string;
}

interface RefreshPayload {
  sub: string;
  jti: string;
  family: string;
  type: "refresh";
  gen?: number; // refresh generation at issue time; a bump (logout-all / password change) revokes older ones. Absent on legacy tokens ⇒ 0.
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
    private readonly mail: MailService,
    private readonly instanceSettings: InstanceSettingsService,
  ) {}

  // ---- registration / login ------------------------------------------------

  /**
   * Enforce the registration gate for a NEW account (`register` + first OAuth sign-in). Once the instance
   * is initialized and self-service registration is closed, only an email with a pending team invitation
   * may create an account. The very first user (initializedAt still null) is always allowed and becomes
   * the instance owner (see the atomic claim in register/loginWithGithub).
   */
  private async assertRegistrationAllowed(email: string): Promise<void> {
    const s = await this.instanceSettings.get();
    if (s.initializedAt != null && !s.allowRegistration && !(await this.hasPendingInvite(email))) {
      throw new ForbiddenException("registration is disabled — ask an admin to invite you");
    }
  }

  /** A non-expired team invitation for this email = a pending invite (accepted invites are deleted).
   *  Invites are stored lowercased (TeamsService.invite) and matched case-insensitively everywhere else
   *  (accept/decline/list), so normalize here too — otherwise a mixed-case invitee is wrongly gated. */
  private async hasPendingInvite(email: string): Promise<boolean> {
    const invite = await this.prisma.teamInvitation.findFirst({
      where: { email: email.trim().toLowerCase(), expiresAt: { gt: new Date() } },
    });
    return !!invite;
  }

  async register(
    email: string,
    password: string,
    name?: string,
  ): Promise<{ user: PublicUser; tokens: TokenPair }> {
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictException("email already registered");
    }
    await this.assertRegistrationAllowed(email); // gate closed self-service signups (invites bypass)

    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

    const user = await this.prisma.$transaction(async (tx) => {
      // Atomically elect the FIRST user as the instance owner: only the racer whose UPDATE flips the still-null
      // initializedAt (count === 1) is the owner. In the same transaction as the create, so a rollback undoes
      // the claim (never locks the instance "initialized" with no owner).
      const firstUser =
        (await tx.instanceSettings.updateMany({ where: { id: "singleton", initializedAt: null }, data: { initializedAt: new Date() } })).count === 1;
      const created = await tx.user.create({
        data: { email, password: passwordHash, name: name ?? null, isInstanceOwner: firstUser },
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
    // The account is usable immediately (logged in but unverified); enforcement (if enabled) and the
    // web banner nudge the user to confirm. We await the token persistence (fast, fail-soft) but the
    // SMTP send itself stays fire-and-forget inside the helper, so register latency isn't SMTP-bound.
    await this.sendEmailVerification(user.id, user.email, user.name).catch(() => undefined);
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
      // A NEW OAuth account is a registration → same gate + first-user ownership as password register.
      // (Existing users fall through to the `else` login path and are never gated.)
      await this.assertRegistrationAllowed(email);
      const passwordHash = await argon2.hash(randomUUID(), { type: argon2.argon2id });
      user = await this.prisma.$transaction(async (tx) => {
        const firstUser =
          (await tx.instanceSettings.updateMany({ where: { id: "singleton", initializedAt: null }, data: { initializedAt: new Date() } })).count === 1;
        const created = await tx.user.create({
          // OAuth emails are provider-verified, so the account starts verified.
          data: { email, password: passwordHash, name: name ?? null, emailVerified: true, emailVerifiedAt: new Date(), isInstanceOwner: firstUser },
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
    } else if (!user.emailVerified) {
      // GitHub proves the user owns this email — heal a pre-existing password account that never
      // verified (otherwise enforcement would block someone who just proved email ownership).
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: { emailVerified: true, emailVerifiedAt: new Date() },
      });
    }
    await this.audit.log({ actor: user.id, action: "auth.login", meta: { provider: "github" } });
    return this.issueTokens(user.id);
  }

  async login(
    email: string,
    password: string,
    totp?: string,
  ): Promise<{ tokens: TokenPair; recoveryLow?: true } | { twoFaRequired: true }> {
    const key = email.toLowerCase();

    // Temporary lockout after too many recent failures — bounded (auto-clears in 15 min) so a
    // guesser can't hammer forever, while a locked-out legit user recovers without operator help.
    if (await this.redis.get(`lock:${key}`)) {
      throw new HttpException("account temporarily locked — try again later", 423); // 423 Locked
    }
    // Per-email burst guard over a short fixed window, independent of the per-IP throttle.
    if ((await this.redis.incr(`rate:login:${key}`, LOGIN_RATE_WINDOW)) > LOGIN_RATE_MAX) {
      throw new HttpException("too many login attempts — slow down", HttpStatus.TOO_MANY_REQUESTS);
    }

    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      // Count the miss too so the lock/rate behaviour is identical whether or not the email
      // exists (no account enumeration via lockout timing) — same generic error either way.
      await this.registerLoginFailure(key);
      throw new UnauthorizedException("invalid credentials");
    }

    const valid = await argon2.verify(user.password, password);
    if (!valid) {
      await this.registerLoginFailure(key);
      await this.audit.log({
        actor: user.id,
        action: "auth.login.failed",
        meta: { reason: "bad_password" },
      });
      throw new UnauthorizedException("invalid credentials");
    }

    let recoveryLow = false;
    if (user.twoFaEnabled) {
      if (!totp) {
        return { twoFaRequired: true };
      }
      const result = await this.verifyTwoFactorCode(user, totp);
      if (!result.ok) {
        await this.registerLoginFailure(key);
        await this.audit.log({
          actor: user.id,
          action: "auth.login.failed",
          meta: { reason: "bad_totp" },
        });
        throw new UnauthorizedException("invalid 2FA code");
      }
      // A recovery code was spent (remaining !== null) and few remain → nudge the user.
      recoveryLow = result.remaining !== null && result.remaining <= 2;
    }

    // Success — clear the failure counter so an earlier typo streak doesn't linger.
    await this.redis.del(`fail:${key}`);
    await this.audit.log({ actor: user.id, action: "auth.login" });
    const tokens = await this.issueTokens(user.id);
    return recoveryLow ? { tokens, recoveryLow: true } : { tokens };
  }

  // ---- tokens (rotation + reuse detection) ---------------------------------

  async issueTokens(userId: string, family?: string): Promise<TokenPair> {
    const fam = family ?? randomUUID();
    const jti = randomUUID();
    // Stamp the token with the user's current refresh generation so a later bump revokes it.
    const gen = await this.currentGen(userId);

    const accessToken = await this.jwt.signAsync(
      { sub: userId, type: "access" },
      {
        secret: this.config.get<string>("JWT_ACCESS_SECRET"),
        expiresIn: ACCESS_TTL,
      },
    );
    const refreshToken = await this.jwt.signAsync(
      { sub: userId, jti, family: fam, type: "refresh", gen },
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

  /** The user's current refresh generation (0 if never bumped). Bumping it (logout-all /
   *  password change) invalidates every token stamped with an older generation. */
  private async currentGen(userId: string): Promise<number> {
    return Number(await this.redis.get(`rtgen:${userId}`)) || 0;
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

    // Global revocation gate: a logout-all / password change bumps the user's generation, so any
    // token stamped with an older gen is dead — including ones never individually tracked (e.g.
    // tokens minted before this mechanism, whose gen is absent ⇒ 0).
    if ((payload.gen ?? 0) < (await this.currentGen(payload.sub))) {
      await this.redis.del(`rt:${payload.jti}`);
      await this.redis.srem(`rtfam:${payload.family}`, payload.jti);
      throw new UnauthorizedException("session revoked");
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

  /** Revoke EVERY active session for a user (all families/devices) by bumping their refresh
   *  generation: refresh() then rejects any token stamped with an older gen. This catches tokens
   *  the hub never individually tracked — including any minted before this mechanism existed —
   *  because revocation is by generation, not by an index that such tokens are missing from. The
   *  now-orphaned rt:/rtfam: keys expire via their own TTL; the caller's access token still lives
   *  until it expires (short TTL). */
  async logoutAll(userId: string): Promise<void> {
    await this.redis.incr(`rtgen:${userId}`);
    await this.audit.log({ actor: userId, action: "auth.logout_all" });
  }

  private async revokeFamily(family: string): Promise<void> {
    const members = await this.redis.smembers(`rtfam:${family}`);
    await this.redis.del(
      `rtfam:${family}`,
      ...members.map((jti) => `rt:${jti}`),
    );
  }

  /** Record a failed login for this email and trip a temporary lock once too many pile up in
   *  the window. Keyed by email (lowercased) so the lock survives an attacker rotating IPs. */
  private async registerLoginFailure(emailKey: string): Promise<void> {
    const fails = await this.redis.incr(`fail:${emailKey}`, LOCKOUT_WINDOW);
    if (fails >= LOCKOUT_THRESHOLD) {
      await this.redis.set(`lock:${emailKey}`, "1", LOCKOUT_WINDOW);
    }
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

  async enable2FA(userId: string, token: string): Promise<{ recoveryCodes: string[] }> {
    const user = await this.requireUser(userId);
    if (!user.twoFaSecret) {
      throw new UnauthorizedException("2FA not set up");
    }
    const secret = this.crypto.decrypt(user.twoFaSecret);
    if (!this.totp.verify(token, secret)) {
      throw new UnauthorizedException("invalid 2FA code");
    }
    // Issue 10 one-time recovery codes; return them in plaintext ONCE (only their hashes
    // are stored). Replace any codes from a previous 2FA setup.
    const recoveryCodes = generateRecoveryCodes(10);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { twoFaEnabled: true, twoFaEnabledAt: new Date() },
      });
      await tx.twoFactorRecoveryCode.deleteMany({ where: { userId } });
      await tx.twoFactorRecoveryCode.createMany({
        data: recoveryCodes.map((code) => ({ userId, codeHash: this.crypto.hmac(recoveryHashInput(userId, code)) })),
      });
    });
    await this.audit.log({ actor: userId, action: "auth.2fa.enabled" });
    return { recoveryCodes };
  }

  /**
   * Verify a 2FA code against the user's TOTP secret, falling back to a one-time recovery code
   * (consumed atomically via updateMany so two concurrent attempts can't both spend it). Returns
   * `remaining` = how many recovery codes are left when one was spent, or null when TOTP matched
   * (so callers can flag "running low"). The `auth.2fa.recovery_used` audit is logged here.
   */
  private async verifyTwoFactorCode(
    user: { id: string; twoFaSecret: string | null },
    code: string,
  ): Promise<{ ok: boolean; remaining: number | null }> {
    if (this.totp.verify(code, this.crypto.decrypt(user.twoFaSecret as string))) {
      return { ok: true, remaining: null };
    }
    const consumed = await this.prisma.twoFactorRecoveryCode.updateMany({
      where: { userId: user.id, codeHash: this.crypto.hmac(recoveryHashInput(user.id, code)), usedAt: null },
      data: { usedAt: new Date() },
    });
    if (consumed.count !== 1) return { ok: false, remaining: null };
    const remaining = await this.prisma.twoFactorRecoveryCode.count({ where: { userId: user.id, usedAt: null } });
    await this.audit.log({ actor: user.id, action: "auth.2fa.recovery_used", meta: { remaining } });
    return { ok: true, remaining };
  }

  /**
   * Disable 2FA. Sudo re-auth: current password AND a valid 2FA code (TOTP or a recovery code).
   * Wipes the secret, flips twoFaEnabled off, and deletes every recovery code. So a lost
   * authenticator never becomes a permanent lockout: log in via a recovery code, then disable.
   */
  async disable2FA(userId: string, password: string, code: string): Promise<void> {
    const user = await this.requireUser(userId);
    if (!(await argon2.verify(user.password, password))) {
      throw new UnauthorizedException("password is incorrect");
    }
    if (!user.twoFaEnabled) throw new BadRequestException("2FA is not enabled");
    if (!(await this.verifyTwoFactorCode(user, code)).ok) {
      throw new UnauthorizedException("invalid 2FA code");
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { twoFaEnabled: false, twoFaSecret: null, twoFaEnabledAt: null } });
      await tx.twoFactorRecoveryCode.deleteMany({ where: { userId } });
    });
    await this.audit.log({ actor: userId, action: "auth.2fa.disabled" });
  }

  /** Replace all recovery codes with 10 fresh ones (returned in plaintext ONCE). Same
   *  password + code sudo re-auth as disable. */
  async regenerateRecoveryCodes(userId: string, password: string, code: string): Promise<{ recoveryCodes: string[] }> {
    const user = await this.requireUser(userId);
    if (!(await argon2.verify(user.password, password))) {
      throw new UnauthorizedException("password is incorrect");
    }
    if (!user.twoFaEnabled) throw new BadRequestException("2FA is not enabled");
    if (!(await this.verifyTwoFactorCode(user, code)).ok) {
      throw new UnauthorizedException("invalid 2FA code");
    }
    const recoveryCodes = generateRecoveryCodes(10);
    await this.prisma.$transaction(async (tx) => {
      await tx.twoFactorRecoveryCode.deleteMany({ where: { userId } });
      await tx.twoFactorRecoveryCode.createMany({
        data: recoveryCodes.map((c) => ({ userId, codeHash: this.crypto.hmac(recoveryHashInput(userId, c)) })),
      });
    });
    await this.audit.log({ actor: userId, action: "auth.2fa.recovery_regenerated" });
    return { recoveryCodes };
  }

  /** How many unused recovery codes remain (drives the "N remaining" UI). */
  async recoveryCodesStatus(userId: string): Promise<{ remaining: number }> {
    const remaining = await this.prisma.twoFactorRecoveryCode.count({ where: { userId, usedAt: null } });
    return { remaining };
  }

  async me(userId: string): Promise<PublicUser> {
    return this.toPublicUser(await this.requireUser(userId));
  }

  /**
   * Update the current user's display name and/or email. An EMAIL CHANGE is DEFERRED: we don't
   * write the new address, we email it a confirmation link — the old (verified) address stays in
   * control until the new owner clicks it. This blocks a typo'd address from locking the account and
   * a briefly-hijacked session from silently swapping the email. name/uiMode apply immediately.
   */
  async updateProfile(
    userId: string,
    input: { name?: string; email?: string; uiMode?: "fleet" | "home"; currentPassword?: string },
  ): Promise<PublicUser> {
    const user = await this.requireUser(userId);
    let emailChangeTarget: string | null = null;
    if (input.email && input.email !== user.email) {
      // Sudo re-auth: an email change is a takeover vector (→ password reset to the new address), so
      // require the current password — mirrors changePassword. A stolen session alone can't do it.
      if (!input.currentPassword || !(await argon2.verify(user.password, input.currentPassword))) {
        throw new UnauthorizedException("current password is required to change your email");
      }
      const taken = await this.prisma.user.findUnique({ where: { email: input.email } });
      if (taken && taken.id !== userId) throw new ConflictException("email already in use");
      emailChangeTarget = input.email; // deferred — verified into user.email only on confirm
    }
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.uiMode !== undefined ? { uiMode: input.uiMode } : {}),
      },
    });
    await this.audit.log({ actor: userId, action: "auth.profile.update" });
    if (emailChangeTarget) {
      await this.sendEmailVerification(userId, emailChangeTarget, updated.name).catch(() => undefined);
      // Security notice to the CURRENT (old) address so a change is never silent to the real owner.
      void this.mail.send(user.email, emailChangeNoticeEmail({ name: updated.name, newEmail: emailChangeTarget })).catch(() => undefined);
    }
    return this.toPublicUser(updated);
  }

  /** Change the current user's password (verifies the current one first). Returns a FRESH token
   *  pair for the calling device: every existing session is revoked first (the "someone had my
   *  password" recovery — other devices must re-authenticate), then this device is re-issued so
   *  the user who just changed their own password isn't bounced to the login screen. */
  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<TokenPair> {
    const user = await this.requireUser(userId);
    if (!(await argon2.verify(user.password, currentPassword))) {
      throw new UnauthorizedException("current password is incorrect");
    }
    const passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id });
    await this.prisma.user.update({ where: { id: userId }, data: { password: passwordHash } });
    await this.audit.log({ actor: userId, action: "auth.password.change" });
    await this.logoutAll(userId);
    return this.issueTokens(userId);
  }

  // ---- password reset (forgot / reset via emailed single-use token) --------

  /**
   * Start a password reset. ENUMERATION-SAFE: always resolves (the controller returns a fixed 200)
   * whether or not the email exists. If it does: invalidate any prior reset tokens, mint a 32-byte
   * token (only its sha256 hash is stored), and email the reset link. FAIL-SOFT: if the mailer is
   * unconfigured or the send fails, the token is dropped into the audit log so a self-host operator
   * can still recover — and the endpoint still returns 200.
   */
  async requestPasswordReset(email: string): Promise<void> {
    // Rate key is normalized (case/space-insensitive bucket); the LOOKUP uses the raw email so it
    // matches how register stores and login reads it (both case-sensitive) — otherwise a mixed-case
    // account would silently never get a link.
    const rateKey = email.trim().toLowerCase();
    // Per-email rate limit (uniform for existing/non-existing emails so 429 can't reveal existence).
    if ((await this.redis.incr(`rate:forgot:${rateKey}`, PASSWORD_RESET_RATE_WINDOW)) > PASSWORD_RESET_RATE_MAX) {
      throw new HttpException("too many reset requests — try again later", HttpStatus.TOO_MANY_REQUESTS);
    }
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) return; // silent — no enumeration

    // Only one live reset token per user: burn any prior unused ones.
    await this.prisma.verificationToken.updateMany({
      where: { userId: user.id, purpose: VerificationPurpose.PASSWORD_RESET, usedAt: null },
      data: { usedAt: new Date() },
    });
    const raw = randomBytes(32).toString("base64url");
    await this.prisma.verificationToken.create({
      data: {
        userId: user.id,
        purpose: VerificationPurpose.PASSWORD_RESET,
        tokenHash: hashToken(raw),
        email: user.email,
        expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
      },
    });
    const resetUrl = `${webBaseUrl(this.config)}/reset-password?token=${raw}`;
    // Fire-and-forget the email: never await the SMTP round-trip in the request path, so response
    // latency doesn't depend on whether the account exists (closes the enumeration TIMING oracle).
    // The token is already persisted, so the link works whenever dispatch completes. Fail-soft: an
    // unconfigured/failed mailer records the link in the audit log (server-side only, never surfaced
    // to the requester) so a self-host operator can still deliver it out of band.
    void this.mail
      .send(user.email, resetPasswordEmail({ name: user.name, resetUrl }))
      .then((sent) =>
        this.audit.log({
          actor: user.id,
          action: "auth.password.forgot",
          meta: sent ? { delivered: true } : { delivered: false, resetUrl },
        }),
      )
      .catch(() =>
        this.audit.log({ actor: user.id, action: "auth.password.forgot", meta: { delivered: false, resetUrl } }),
      );
  }

  /**
   * Complete a password reset with the emailed token (the token IS the authorization — no current
   * password needed). Single-use via an atomic consume; on success the new password is written and
   * EVERY session is revoked (logoutAll) so a stolen live session can't survive the reset.
   */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    const vt = await this.prisma.verificationToken.findUnique({ where: { tokenHash: hashToken(token) } });
    if (
      !vt ||
      vt.purpose !== VerificationPurpose.PASSWORD_RESET ||
      vt.usedAt ||
      vt.expiresAt.getTime() < Date.now()
    ) {
      throw new BadRequestException("invalid or expired reset link");
    }
    // Atomic single-use consume — a concurrent reset can't spend the same token twice.
    const consumed = await this.prisma.verificationToken.updateMany({
      where: { id: vt.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (consumed.count !== 1) throw new BadRequestException("invalid or expired reset link");

    const passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id });
    await this.prisma.user.update({ where: { id: vt.userId }, data: { password: passwordHash } });
    await this.logoutAll(vt.userId); // revoke every session — the user re-logs in with the new password
    await this.audit.log({ actor: vt.userId, action: "auth.password.reset" });
  }

  // ---- email verification (register confirm + deferred email change) --------

  /**
   * Mint + email a single-use EMAIL_VERIFY token for `targetEmail`. Mirrors requestPasswordReset:
   * only one live token per user (prior unused ones burned), only the sha256 hash is stored, and the
   * send is FIRE-AND-FORGET + FAIL-SOFT (an unconfigured/failed mailer records the link in the audit
   * log). `targetEmail` may differ from user.email during a deferred email change.
   */
  private async sendEmailVerification(userId: string, targetEmail: string, name: string | null): Promise<void> {
    await this.prisma.verificationToken.updateMany({
      where: { userId, purpose: VerificationPurpose.EMAIL_VERIFY, usedAt: null },
      data: { usedAt: new Date() },
    });
    const raw = randomBytes(32).toString("base64url");
    await this.prisma.verificationToken.create({
      data: {
        userId,
        purpose: VerificationPurpose.EMAIL_VERIFY,
        tokenHash: hashToken(raw),
        email: targetEmail,
        expiresAt: new Date(Date.now() + EMAIL_VERIFY_TTL_MS),
      },
    });
    const verifyUrl = `${webBaseUrl(this.config)}/verify-email?token=${raw}`;
    void this.mail
      .send(targetEmail, verifyEmailTemplate({ name, verifyUrl }))
      .then((sent) =>
        this.audit.log({
          actor: userId,
          action: "auth.email.verify.sent",
          meta: sent ? { delivered: true } : { delivered: false, verifyUrl },
        }),
      )
      .catch(() =>
        this.audit.log({ actor: userId, action: "auth.email.verify.sent", meta: { delivered: false, verifyUrl } }),
      );
  }

  /**
   * Confirm an emailed EMAIL_VERIFY token. Single-use via an atomic consume. Applies the token's
   * target email (a no-op for a registration confirm, the new address for an email change) and marks
   * the account verified. No logoutAll: unlike a password reset, the credential is unchanged.
   */
  async verifyEmail(token: string): Promise<void> {
    const vt = await this.prisma.verificationToken.findUnique({ where: { tokenHash: hashToken(token) } });
    if (
      !vt ||
      vt.purpose !== VerificationPurpose.EMAIL_VERIFY ||
      vt.usedAt ||
      vt.expiresAt.getTime() < Date.now()
    ) {
      throw new BadRequestException("invalid or expired verification link");
    }
    const user = await this.prisma.user.findUnique({ where: { id: vt.userId } });
    if (!user) throw new BadRequestException("invalid or expired verification link");
    // For an email change, make sure the target wasn't claimed since the token was minted.
    if (vt.email !== user.email) {
      const taken = await this.prisma.user.findUnique({ where: { email: vt.email } });
      if (taken && taken.id !== vt.userId) throw new BadRequestException("email already in use");
    }
    // Atomic single-use consume — a concurrent verify can't spend the same token twice.
    const consumed = await this.prisma.verificationToken.updateMany({
      where: { id: vt.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (consumed.count !== 1) throw new BadRequestException("invalid or expired verification link");
    try {
      await this.prisma.user.update({
        where: { id: vt.userId },
        data: { email: vt.email, emailVerified: true, emailVerifiedAt: new Date() },
      });
    } catch {
      // Unique-constraint race on the target email (claimed between the check and the write).
      throw new BadRequestException("email already in use");
    }
    await this.audit.log({ actor: vt.userId, action: "auth.email.verified" });
  }

  /** Re-send the verification email for the current user (no-op if already verified). */
  async resendVerification(userId: string): Promise<void> {
    const user = await this.requireUser(userId);
    if (user.emailVerified) return;
    await this.sendEmailVerification(userId, user.email, user.name);
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
    emailVerified: boolean;
    uiMode: string;
  }): PublicUser {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      twoFaEnabled: user.twoFaEnabled,
      emailVerified: user.emailVerified,
      uiMode: user.uiMode,
    };
  }
}
