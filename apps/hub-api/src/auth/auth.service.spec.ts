import { HttpException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { createHash } from "node:crypto";
import * as argon2 from "argon2";
import { AuthService } from "./auth.service";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";
import { CryptoService } from "../crypto/crypto.service";
import { TotpService } from "./totp.service";
import { AuditService } from "../audit/audit.service";
import { TeamDefaultsService } from "../teams/team-defaults.service";
import { MailService } from "../mail/mail.service";
import { InstanceSettingsService } from "../instance/instance-settings.service";

class FakeRedis {
  private kv = new Map<string, string>();
  private sets = new Map<string, Set<string>>();
  async set(k: string, v: string): Promise<void> {
    this.kv.set(k, v);
  }
  async get(k: string): Promise<string | null> {
    return this.kv.get(k) ?? null;
  }
  async del(...keys: string[]): Promise<void> {
    for (const k of keys) {
      this.kv.delete(k);
      this.sets.delete(k);
    }
  }
  async incr(k: string): Promise<number> {
    const n = (Number(this.kv.get(k)) || 0) + 1;
    this.kv.set(k, String(n));
    return n;
  }
  async sadd(k: string, m: string): Promise<void> {
    if (!this.sets.has(k)) this.sets.set(k, new Set());
    this.sets.get(k)!.add(m);
  }
  async srem(k: string, ...members: string[]): Promise<void> {
    for (const m of members) this.sets.get(k)?.delete(m);
  }
  async smembers(k: string): Promise<string[]> {
    return [...(this.sets.get(k) ?? [])];
  }
  async expire(): Promise<void> {}
}

const config = {
  get: (key: string) =>
    key === "JWT_ACCESS_SECRET"
      ? "access-secret-aaaaaaaaaaaa"
      : key === "JWT_REFRESH_SECRET"
        ? "refresh-secret-bbbbbbbbbbbb"
        : undefined,
} as unknown as ConfigService;

const mail = { send: jest.fn().mockResolvedValue(true), isConfigured: () => true } as unknown as MailService;

function makeService(
  prisma: Partial<PrismaService> = {},
  teamDefaults: { ensureDefaults: jest.Mock } = { ensureDefaults: jest.fn().mockResolvedValue(undefined) },
  // Default: a fresh instance (initializedAt null) → registration always allowed, so tests that don't care
  // about gating (login/2fa/reset/first-oauth) are unaffected. Gating tests pass a specific settings state.
  instanceSettings: { get: jest.Mock; update: jest.Mock } = {
    get: jest.fn().mockResolvedValue({ initializedAt: null, allowRegistration: false }),
    update: jest.fn().mockResolvedValue({}),
  },
): AuthService {
  return new AuthService(
    prisma as PrismaService,
    new JwtService({}),
    config,
    {} as CryptoService,
    {} as TotpService,
    { log: jest.fn() } as unknown as AuditService,
    new FakeRedis() as unknown as RedisService,
    teamDefaults as unknown as TeamDefaultsService,
    mail,
    instanceSettings as unknown as InstanceSettingsService,
  );
}

describe("AuthService tokens", () => {
  it("issues an access + refresh pair", async () => {
    const svc = makeService();
    const pair = await svc.issueTokens("user-1");
    expect(pair.accessToken).toBeTruthy();
    expect(pair.refreshToken).toBeTruthy();
    expect(pair.accessToken).not.toBe(pair.refreshToken);
  });

  it("rotates the refresh token and invalidates the old one (reuse → revoke)", async () => {
    const svc = makeService();
    const first = await svc.issueTokens("user-1");

    const rotated = await svc.refresh(first.refreshToken);
    expect(rotated.refreshToken).not.toBe(first.refreshToken);

    // Reusing the original (already-rotated) token must be rejected.
    await expect(svc.refresh(first.refreshToken)).rejects.toThrow(
      /reuse detected/,
    );

    // And reuse detection revokes the whole family, so the rotated one dies too.
    await expect(svc.refresh(rotated.refreshToken)).rejects.toThrow();
  });

  it("rejects a malformed refresh token", async () => {
    const svc = makeService();
    await expect(svc.refresh("not-a-jwt")).rejects.toThrow(
      /invalid refresh token/,
    );
  });
});

describe("AuthService login", () => {
  it("rejects a wrong password", async () => {
    const passwordHash = await argon2.hash("correct-horse", {
      type: argon2.argon2id,
    });
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: "u1", email: "a@b.c", password: passwordHash, twoFaEnabled: false }) },
    } as unknown as PrismaService;

    const svc = makeService(prisma);
    await expect(svc.login("a@b.c", "wrong-password")).rejects.toThrow(
      /invalid credentials/,
    );
  });

  it("rejects an unknown email", async () => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const svc = makeService(prisma);
    await expect(svc.login("nope@b.c", "x")).rejects.toThrow(
      /invalid credentials/,
    );
  });
});

describe("AuthService 2FA recovery codes", () => {
  // Build a service with custom crypto/totp mocks (makeService uses empty stubs).
  function make2fa(prisma: Partial<PrismaService>, totpVerify: jest.Mock) {
    return new AuthService(
      prisma as PrismaService,
      new JwtService({}),
      config,
      { decrypt: () => "SECRET", encrypt: (s: string) => s, hmac: (d: string) => createHash("sha256").update(d).digest("hex") } as unknown as CryptoService,
      { verify: totpVerify } as unknown as TotpService,
      { log: jest.fn() } as unknown as AuditService,
      new FakeRedis() as unknown as RedisService,
      { ensureDefaults: jest.fn() } as unknown as TeamDefaultsService,
      mail,
      { get: jest.fn(), update: jest.fn() } as unknown as InstanceSettingsService,
    );
  }

  it("enable2FA issues 10 recovery codes and stores their hashes (plaintext returned once)", async () => {
    const createMany = jest.fn().mockResolvedValue({ count: 10 });
    const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
    const userUpdate = jest.fn().mockResolvedValue({});
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: "u1", twoFaSecret: "enc" }) },
      $transaction: jest.fn(async (cb: (tx: unknown) => unknown) =>
        cb({ user: { update: userUpdate }, twoFactorRecoveryCode: { deleteMany, createMany } }),
      ),
    } as unknown as PrismaService;
    const res = await make2fa(prisma, jest.fn().mockReturnValue(true)).enable2FA("u1", "123456");
    expect(res.recoveryCodes).toHaveLength(10);
    expect(userUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ twoFaEnabled: true }) }));
    expect(deleteMany).toHaveBeenCalledWith({ where: { userId: "u1" } });
    // stored rows are HASHES, never the plaintext codes
    const rows = createMany.mock.calls[0][0].data as { codeHash: string }[];
    expect(rows).toHaveLength(10);
    for (const r of rows) expect(r.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(res.recoveryCodes[0]);
  });

  it("login falls back to a recovery code when TOTP fails, consumes it, and flags recoveryLow", async () => {
    const passwordHash = await argon2.hash("pw", { type: argon2.argon2id });
    const updateMany = jest.fn().mockResolvedValue({ count: 1 }); // the code matched + was consumed
    const count = jest.fn().mockResolvedValue(2); // 2 left → low
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: "u1", email: "a@b.c", password: passwordHash, twoFaEnabled: true, twoFaSecret: "enc" }) },
      twoFactorRecoveryCode: { updateMany, count },
    } as unknown as PrismaService;
    const res = await make2fa(prisma, jest.fn().mockReturnValue(false)).login("a@b.c", "pw", "AB12-CD34");
    expect(res).toMatchObject({ recoveryLow: true });
    expect((res as { tokens: unknown }).tokens).toBeTruthy();
    // consumed atomically: updateMany scoped to an UNUSED code
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: "u1", usedAt: null }) }));
  });

  it("login rejects when TOTP fails AND the recovery code is invalid/already used", async () => {
    const passwordHash = await argon2.hash("pw", { type: argon2.argon2id });
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: "u1", email: "a@b.c", password: passwordHash, twoFaEnabled: true, twoFaSecret: "enc" }) },
      twoFactorRecoveryCode: { updateMany: jest.fn().mockResolvedValue({ count: 0 }), count: jest.fn() },
    } as unknown as PrismaService;
    await expect(make2fa(prisma, jest.fn().mockReturnValue(false)).login("a@b.c", "pw", "WRONG-CODE")).rejects.toThrow(/2FA/);
  });

  it("login with a valid TOTP does NOT touch recovery codes", async () => {
    const passwordHash = await argon2.hash("pw", { type: argon2.argon2id });
    const updateMany = jest.fn();
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: "u1", email: "a@b.c", password: passwordHash, twoFaEnabled: true, twoFaSecret: "enc" }) },
      twoFactorRecoveryCode: { updateMany, count: jest.fn() },
    } as unknown as PrismaService;
    const res = await make2fa(prisma, jest.fn().mockReturnValue(true)).login("a@b.c", "pw", "123456");
    expect((res as { tokens: unknown }).tokens).toBeTruthy();
    expect((res as { recoveryLow?: true }).recoveryLow).toBeUndefined();
    expect(updateMany).not.toHaveBeenCalled();
  });

  const enabledUser = async () => ({
    id: "u1",
    email: "a@b.c",
    password: await argon2.hash("pw", { type: argon2.argon2id }),
    twoFaEnabled: true,
    twoFaSecret: "enc",
  });

  it("disable2FA wipes the secret + recovery codes with password + TOTP", async () => {
    const userUpdate = jest.fn().mockResolvedValue({});
    const deleteMany = jest.fn().mockResolvedValue({ count: 10 });
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(await enabledUser()) },
      $transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb({ user: { update: userUpdate }, twoFactorRecoveryCode: { deleteMany } })),
    } as unknown as PrismaService;
    await make2fa(prisma, jest.fn().mockReturnValue(true)).disable2FA("u1", "pw", "123456");
    expect(userUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ twoFaEnabled: false, twoFaSecret: null, twoFaEnabledAt: null }) }));
    expect(deleteMany).toHaveBeenCalledWith({ where: { userId: "u1" } });
  });

  it("disable2FA also accepts a recovery code as the second factor", async () => {
    const userUpdate = jest.fn().mockResolvedValue({});
    const deleteMany = jest.fn().mockResolvedValue({ count: 9 });
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(await enabledUser()) },
      twoFactorRecoveryCode: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), count: jest.fn().mockResolvedValue(9) },
      $transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb({ user: { update: userUpdate }, twoFactorRecoveryCode: { deleteMany } })),
    } as unknown as PrismaService;
    // TOTP fails → recovery-code fallback consumes one, then disable proceeds.
    await make2fa(prisma, jest.fn().mockReturnValue(false)).disable2FA("u1", "pw", "AB12-CD34");
    expect(userUpdate).toHaveBeenCalled();
  });

  it("disable2FA rejects a wrong password (before touching 2FA state)", async () => {
    const prisma = { user: { findUnique: jest.fn().mockResolvedValue(await enabledUser()) } } as unknown as PrismaService;
    await expect(make2fa(prisma, jest.fn().mockReturnValue(true)).disable2FA("u1", "WRONG", "123456")).rejects.toThrow(/password is incorrect/);
  });

  it("disable2FA rejects an invalid 2FA code", async () => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(await enabledUser()) },
      twoFactorRecoveryCode: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    } as unknown as PrismaService;
    await expect(make2fa(prisma, jest.fn().mockReturnValue(false)).disable2FA("u1", "pw", "BAD-CODE")).rejects.toThrow(/2FA/);
  });

  it("disable2FA 400s when 2FA is not enabled", async () => {
    const prisma = { user: { findUnique: jest.fn().mockResolvedValue({ id: "u1", password: await argon2.hash("pw", { type: argon2.argon2id }), twoFaEnabled: false }) } } as unknown as PrismaService;
    await expect(make2fa(prisma, jest.fn()).disable2FA("u1", "pw", "123456")).rejects.toThrow(/not enabled/);
  });

  it("regenerateRecoveryCodes replaces old codes with 10 fresh hashed ones (password + TOTP)", async () => {
    const createMany = jest.fn().mockResolvedValue({ count: 10 });
    const deleteMany = jest.fn().mockResolvedValue({ count: 8 });
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(await enabledUser()) },
      $transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb({ twoFactorRecoveryCode: { deleteMany, createMany } })),
    } as unknown as PrismaService;
    const res = await make2fa(prisma, jest.fn().mockReturnValue(true)).regenerateRecoveryCodes("u1", "pw", "123456");
    expect(res.recoveryCodes).toHaveLength(10);
    expect(deleteMany).toHaveBeenCalledWith({ where: { userId: "u1" } });
    const rows = createMany.mock.calls[0][0].data as { codeHash: string }[];
    for (const r of rows) expect(r.codeHash).toMatch(/^[0-9a-f]{64}$/); // stored hashed, never plaintext
    expect(JSON.stringify(rows)).not.toContain(res.recoveryCodes[0]);
  });

  it("recoveryCodesStatus returns the unused-code count", async () => {
    const prisma = { twoFactorRecoveryCode: { count: jest.fn().mockResolvedValue(7) } } as unknown as PrismaService;
    expect(await make2fa(prisma, jest.fn()).recoveryCodesStatus("u1")).toEqual({ remaining: 7 });
  });
});

describe("AuthService.updateProfile", () => {
  const me = { id: "u1", email: "a@b.c", name: "Old", twoFaEnabled: false, emailVerified: true, uiMode: "fleet", password: "h" };

  it("updates the display name", async () => {
    const update = jest.fn().mockResolvedValue({ ...me, name: "New" });
    const prisma = { user: { findUnique: jest.fn().mockResolvedValue(me), update } } as unknown as PrismaService;
    const res = await makeService(prisma).updateProfile("u1", { name: "New" });
    expect(res.name).toBe("New");
    expect(update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { name: "New" } });
  });

  it("switches the UI mode and exposes it on the public user", async () => {
    const update = jest.fn().mockResolvedValue({ ...me, uiMode: "home" });
    const prisma = { user: { findUnique: jest.fn().mockResolvedValue(me), update } } as unknown as PrismaService;
    const res = await makeService(prisma).updateProfile("u1", { uiMode: "home" });
    expect(res.uiMode).toBe("home");
    expect(update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { uiMode: "home" } });
  });

  it("requires the current password to change the email (sudo re-auth)", async () => {
    const passwordHash = await argon2.hash("pw", { type: argon2.argon2id });
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ ...me, password: passwordHash }), update: jest.fn() },
    } as unknown as PrismaService;
    // Missing or wrong current password → rejected before anything is written.
    await expect(makeService(prisma).updateProfile("u1", { email: "new@x.c" })).rejects.toThrow(/current password/);
    await expect(
      makeService(prisma).updateProfile("u1", { email: "new@x.c", currentPassword: "wrong" }),
    ).rejects.toThrow(/current password/);
  });

  it("rejects an email already used by someone else", async () => {
    const passwordHash = await argon2.hash("pw", { type: argon2.argon2id });
    const meWithPw = { ...me, password: passwordHash };
    const findUnique = jest.fn(({ where }: { where: { id?: string; email?: string } }) =>
      Promise.resolve(where.id ? meWithPw : where.email === "taken@x.c" ? { id: "other" } : null),
    );
    const prisma = { user: { findUnique, update: jest.fn() } } as unknown as PrismaService;
    await expect(
      makeService(prisma).updateProfile("u1", { email: "taken@x.c", currentPassword: "pw" }),
    ).rejects.toThrow(/already in use/);
  });
});

describe("AuthService.changePassword", () => {
  it("rejects when the current password is wrong", async () => {
    const passwordHash = await argon2.hash("correct-horse", { type: argon2.argon2id });
    const prisma = { user: { findUnique: jest.fn().mockResolvedValue({ id: "u1", password: passwordHash }), update: jest.fn() } } as unknown as PrismaService;
    await expect(makeService(prisma).changePassword("u1", "wrong", "newpass1234")).rejects.toThrow(/current password/);
  });

  it("hashes and stores the new password when the current one is correct", async () => {
    const passwordHash = await argon2.hash("correct-horse", { type: argon2.argon2id });
    const update = jest.fn().mockResolvedValue({});
    const prisma = { user: { findUnique: jest.fn().mockResolvedValue({ id: "u1", password: passwordHash }), update } } as unknown as PrismaService;
    await makeService(prisma).changePassword("u1", "correct-horse", "newpass1234");
    const data = update.mock.calls[0][0].data;
    expect(data.password).toBeTruthy();
    expect(data.password).not.toBe("newpass1234"); // stored hashed, not plaintext
  });
});

describe("AuthService session hardening", () => {
  it("locks an email out after too many failed attempts (per-email, IP-independent)", async () => {
    // Unknown email → no argon2 cost, but each miss still counts toward the lockout.
    const prisma = { user: { findUnique: jest.fn().mockResolvedValue(null) } } as unknown as PrismaService;
    const svc = makeService(prisma);
    // 10 misses trip the lock; the 11th attempt is refused with 423 BEFORE credentials are checked.
    for (let i = 0; i < 10; i++) {
      await expect(svc.login("ghost@x.io", "guess")).rejects.toThrow(/invalid credentials/);
    }
    try {
      await svc.login("ghost@x.io", "guess");
      throw new Error("expected a lockout");
    } catch (e) {
      expect((e as HttpException).getStatus()).toBe(423); // 423 Locked
    }
    // A DIFFERENT email is unaffected (lock is scoped per-email, not global).
    await expect(svc.login("someone-else@x.io", "guess")).rejects.toThrow(/invalid credentials/);
  });

  it("logoutAll revokes every session across all devices/families", async () => {
    const svc = makeService();
    const deviceA = await svc.issueTokens("u1");
    const deviceB = await svc.issueTokens("u1"); // a second, independent family
    const other = await svc.issueTokens("u2"); // a different user — must survive

    await svc.logoutAll("u1");

    await expect(svc.refresh(deviceA.refreshToken)).rejects.toThrow();
    await expect(svc.refresh(deviceB.refreshToken)).rejects.toThrow();
    // u2's session is untouched.
    const rotated = await svc.refresh(other.refreshToken);
    expect(rotated.refreshToken).toBeTruthy();
  });

  it("changing the password revokes all existing sessions", async () => {
    const passwordHash = await argon2.hash("old-pass-1234", { type: argon2.argon2id });
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: "u1", password: passwordHash }), update: jest.fn().mockResolvedValue({}) },
    } as unknown as PrismaService;
    const svc = makeService(prisma);
    const session = await svc.issueTokens("u1");

    await svc.changePassword("u1", "old-pass-1234", "new-pass-5678");

    await expect(svc.refresh(session.refreshToken)).rejects.toThrow();
  });

  it("revokes even a LEGACY refresh token that carries no generation stamp (deploy-transition gap)", async () => {
    // A token minted before the generation mechanism: valid rt: entry, but its JWT has no `gen`
    // claim. It must still be caught by logout-all (revocation is by generation, not by an index
    // the token is missing from).
    const redis = new FakeRedis();
    const jwt = new JwtService({});
    const secret = "refresh-secret-bbbbbbbbbbbb"; // matches the shared config mock
    const svc = new AuthService(
      {} as PrismaService,
      jwt,
      config,
      {} as CryptoService,
      {} as TotpService,
      { log: jest.fn() } as unknown as AuditService,
      redis as unknown as RedisService,
      { ensureDefaults: jest.fn() } as unknown as TeamDefaultsService,
      mail,
      { get: jest.fn(), update: jest.fn() } as unknown as InstanceSettingsService,
    );
    const legacy = async (jti: string) => {
      const token = await jwt.signAsync({ sub: "u1", jti, family: `fam-${jti}`, type: "refresh" }, { secret, expiresIn: 3600 });
      await redis.set(`rt:${jti}`, "u1");
      return token;
    };

    // Before any revocation a legacy token still works (gen absent ⇒ 0 == current 0).
    expect((await svc.refresh(await legacy("legacy-1"))).refreshToken).toBeTruthy();

    // After logout-all bumps the generation, a legacy token (gen 0 < 1) is refused.
    const stale = await legacy("legacy-2");
    await svc.logoutAll("u1");
    await expect(svc.refresh(stale)).rejects.toThrow(/session revoked/);
  });
});

describe("AuthService.register — registration gating", () => {
  function registerPrisma() {
    const userCreate = jest.fn().mockResolvedValue({ id: "u1", email: "a@x.io", name: null, emailVerified: false, twoFaEnabled: false, uiMode: "fleet" });
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const invFind = jest.fn().mockResolvedValue(null);
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(null), create: userCreate },
      teamInvitation: { findFirst: invFind },
      $transaction: jest.fn(async (cb: (tx: unknown) => unknown) =>
        cb({
          user: { create: userCreate },
          team: { create: jest.fn().mockResolvedValue({ id: "t1" }) },
          membership: { create: jest.fn().mockResolvedValue({}) },
          instanceSettings: { updateMany },
        }),
      ),
    } as unknown as PrismaService;
    return { prisma, userCreate, updateMany, invFind };
  }
  const settings = (over: Record<string, unknown>) => ({
    get: jest.fn().mockResolvedValue({ initializedAt: null, allowRegistration: false, ...over }),
    update: jest.fn().mockResolvedValue({}),
  });

  it("the FIRST user (initializedAt null) is allowed and becomes the instance owner", async () => {
    const { prisma, userCreate, updateMany } = registerPrisma();
    const svc = makeService(prisma, undefined, settings({ initializedAt: null }));
    jest.spyOn(svc, "issueTokens").mockResolvedValue({ accessToken: "a", refreshToken: "b" });
    await svc.register("a@x.io", "password123");
    expect(updateMany).toHaveBeenCalledWith({ where: { id: "singleton", initializedAt: null }, data: { initializedAt: expect.any(Date) } });
    expect(userCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ isInstanceOwner: true }) });
  });

  it("a subsequent register is 403 when registration is closed and there is no invite", async () => {
    const { prisma } = registerPrisma();
    const svc = makeService(prisma, undefined, settings({ initializedAt: new Date(), allowRegistration: false }));
    await expect(svc.register("b@x.io", "password123")).rejects.toThrow(/registration is disabled/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("registration is allowed when allowRegistration is open (created as a non-owner)", async () => {
    const { prisma, userCreate, updateMany } = registerPrisma();
    updateMany.mockResolvedValue({ count: 0 }); // already initialized → not the first user
    const svc = makeService(prisma, undefined, settings({ initializedAt: new Date(), allowRegistration: true }));
    jest.spyOn(svc, "issueTokens").mockResolvedValue({ accessToken: "a", refreshToken: "b" });
    await svc.register("c@x.io", "password123");
    expect(userCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ isInstanceOwner: false }) });
  });

  it("an invited email bypasses the closed gate — case-insensitively (invites are stored lowercased)", async () => {
    const { prisma, userCreate, invFind } = registerPrisma();
    invFind.mockResolvedValue({ id: "inv1", email: "mixed@x.io" }); // a pending, non-expired invitation
    const svc = makeService(prisma, undefined, settings({ initializedAt: new Date(), allowRegistration: false }));
    jest.spyOn(svc, "issueTokens").mockResolvedValue({ accessToken: "a", refreshToken: "b" });
    // The invitee signs up with their natural (mixed-case) address; the lookup must normalize to match.
    await svc.register("Mixed@X.io", "password123");
    expect(invFind).toHaveBeenCalledWith({ where: { email: "mixed@x.io", expiresAt: { gt: expect.any(Date) } } });
    expect(userCreate).toHaveBeenCalled();
  });
});

describe("AuthService.loginWithGithub", () => {
  it("creates a user + team + membership on first GitHub sign-in (and owns the instance)", async () => {
    const userCreate = jest.fn().mockResolvedValue({ id: "u1", email: "gh@x.io", name: "GH" });
    const teamCreate = jest.fn().mockResolvedValue({ id: "t1" });
    const memberCreate = jest.fn().mockResolvedValue({});
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(async (cb: (tx: unknown) => unknown) =>
        cb({ user: { create: userCreate }, team: { create: teamCreate }, membership: { create: memberCreate }, instanceSettings: { updateMany } }),
      ),
    } as unknown as PrismaService;
    const teamDefaults = { ensureDefaults: jest.fn().mockResolvedValue(undefined) };
    const svc = makeService(prisma, teamDefaults);
    const issue = jest.spyOn(svc, "issueTokens");

    const pair = await svc.loginWithGithub("gh@x.io", "GH");

    expect(userCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ email: "gh@x.io", name: "GH", isInstanceOwner: true }) });
    expect(memberCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ role: "OWNER" }) });
    // The new team is bootstrapped with its default project + env inside the tx.
    expect(teamDefaults.ensureDefaults).toHaveBeenCalledWith("t1", expect.anything());
    expect(issue).toHaveBeenCalledWith("u1");
    expect(pair.accessToken).toBeTruthy();
  });

  it("logs an existing (already-verified) user in without creating or updating anything", async () => {
    const tx = jest.fn();
    const update = jest.fn();
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: "u9", email: "gh@x.io", emailVerified: true }), update },
      $transaction: tx,
    } as unknown as PrismaService;
    const svc = makeService(prisma);
    const issue = jest.spyOn(svc, "issueTokens");

    await svc.loginWithGithub("gh@x.io");

    expect(tx).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(issue).toHaveBeenCalledWith("u9");
  });

  it("heals a pre-existing unverified account by marking it verified (GitHub proved ownership)", async () => {
    const update = jest.fn().mockResolvedValue({ id: "u9", email: "gh@x.io", emailVerified: true });
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: "u9", email: "gh@x.io", emailVerified: false }), update },
      $transaction: jest.fn(),
    } as unknown as PrismaService;
    const svc = makeService(prisma);
    jest.spyOn(svc, "issueTokens").mockResolvedValue({ accessToken: "a", refreshToken: "b" });

    await svc.loginWithGithub("gh@x.io");

    expect(update).toHaveBeenCalledWith({
      where: { id: "u9" },
      data: expect.objectContaining({ emailVerified: true }),
    });
  });

  it("gates a NEW GitHub user when registration is closed and there is no invite (403, no create)", async () => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(null) },
      teamInvitation: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(),
    } as unknown as PrismaService;
    const instanceSettings = {
      get: jest.fn().mockResolvedValue({ initializedAt: new Date(), allowRegistration: false }),
      update: jest.fn(),
    };
    const svc = makeService(prisma, undefined, instanceSettings);
    await expect(svc.loginWithGithub("new@x.io")).rejects.toThrow(/registration is disabled/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("AuthService password reset", () => {
  it("forgot: creates a hashed single-use token and emails the reset link (existing user)", async () => {
    const create = jest.fn().mockResolvedValue({});
    const invalidate = jest.fn().mockResolvedValue({ count: 0 });
    const findUnique = jest.fn().mockResolvedValue({ id: "u1", email: "Mixed@Case.com", name: "A" });
    const prisma = {
      user: { findUnique },
      verificationToken: { updateMany: invalidate, create },
    } as unknown as PrismaService;
    (mail.send as jest.Mock).mockClear();
    (mail.send as jest.Mock).mockResolvedValue(true);
    await makeService(prisma).requestPasswordReset("Mixed@Case.com");
    // Looks up by the RAW email (matches register/login, which are case-sensitive) — NOT lowercased,
    // so a mixed-case account isn't silently skipped.
    expect(findUnique).toHaveBeenCalledWith({ where: { email: "Mixed@Case.com" } });
    // prior reset tokens are burned first
    expect(invalidate).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: "u1", purpose: "PASSWORD_RESET", usedAt: null }) }),
    );
    // what's STORED is a sha256 hash, never the raw token
    const data = create.mock.calls[0][0].data;
    expect(data.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(data.purpose).toBe("PASSWORD_RESET");
    // the emailed link carries a raw token (distinct from the stored hash)
    const [, email] = (mail.send as jest.Mock).mock.calls[0];
    expect(email.html).toContain("/reset-password?token=");
    expect(email.html).not.toContain(data.tokenHash);
  });

  it("forgot: silent + still resolves for an unknown email (no enumeration)", async () => {
    const create = jest.fn();
    const prisma = { user: { findUnique: jest.fn().mockResolvedValue(null) }, verificationToken: { create } } as unknown as PrismaService;
    await expect(makeService(prisma).requestPasswordReset("ghost@x.io")).resolves.toBeUndefined();
    expect(create).not.toHaveBeenCalled();
  });

  it("forgot: fail-soft — a mailer failure still resolves (link goes to the audit log)", async () => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: "u1", email: "a@b.c", name: null }) },
      verificationToken: { updateMany: jest.fn().mockResolvedValue({ count: 0 }), create: jest.fn().mockResolvedValue({}) },
    } as unknown as PrismaService;
    (mail.send as jest.Mock).mockClear();
    (mail.send as jest.Mock).mockResolvedValue(false);
    await expect(makeService(prisma).requestPasswordReset("a@b.c")).resolves.toBeUndefined();
    (mail.send as jest.Mock).mockResolvedValue(true); // restore for other tests
  });

  it("reset: valid token updates the password, consumes the token, and revokes all sessions", async () => {
    const userUpdate = jest.fn().mockResolvedValue({});
    const consume = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      verificationToken: {
        findUnique: jest.fn().mockResolvedValue({ id: "vt1", userId: "u1", purpose: "PASSWORD_RESET", usedAt: null, expiresAt: new Date(Date.now() + 10000) }),
        updateMany: consume,
      },
      user: { update: userUpdate },
    } as unknown as PrismaService;
    const svc = makeService(prisma);
    const revoke = jest.spyOn(svc, "logoutAll");
    await svc.resetPassword("raw-token", "new-pass-1234");
    expect(consume).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "vt1", usedAt: null } }));
    const data = userUpdate.mock.calls[0][0].data;
    expect(data.password).toBeTruthy();
    expect(data.password).not.toBe("new-pass-1234"); // stored hashed
    expect(revoke).toHaveBeenCalledWith("u1");
  });

  it("reset: rejects an unknown or expired token", async () => {
    const unknown = { verificationToken: { findUnique: jest.fn().mockResolvedValue(null) } } as unknown as PrismaService;
    await expect(makeService(unknown).resetPassword("bogus", "new-pass-1234")).rejects.toThrow(/invalid or expired/);
    const expired = {
      verificationToken: { findUnique: jest.fn().mockResolvedValue({ id: "vt", userId: "u1", purpose: "PASSWORD_RESET", usedAt: null, expiresAt: new Date(Date.now() - 1000) }) },
    } as unknown as PrismaService;
    await expect(makeService(expired).resetPassword("x", "new-pass-1234")).rejects.toThrow(/invalid or expired/);
  });

  it("forgot: per-email rate limit trips a 429 after too many requests", async () => {
    const prisma = { user: { findUnique: jest.fn().mockResolvedValue(null) } } as unknown as PrismaService;
    const svc = makeService(prisma); // one FakeRedis (counter) for the whole test
    for (let i = 0; i < 5; i++) await svc.requestPasswordReset("spam@x.io");
    await expect(svc.requestPasswordReset("spam@x.io")).rejects.toThrow(/too many/);
  });
});
