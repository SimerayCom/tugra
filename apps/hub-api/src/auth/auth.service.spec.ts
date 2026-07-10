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

function makeService(
  prisma: Partial<PrismaService> = {},
  teamDefaults: { ensureDefaults: jest.Mock } = { ensureDefaults: jest.fn().mockResolvedValue(undefined) },
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
});

describe("AuthService.updateProfile", () => {
  const me = { id: "u1", email: "a@b.c", name: "Old", twoFaEnabled: false, uiMode: "fleet", password: "h" };

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

  it("rejects an email already used by someone else", async () => {
    const findUnique = jest.fn(({ where }: { where: { id?: string; email?: string } }) =>
      Promise.resolve(where.id ? me : where.email === "taken@x.c" ? { id: "other" } : null),
    );
    const prisma = { user: { findUnique, update: jest.fn() } } as unknown as PrismaService;
    await expect(makeService(prisma).updateProfile("u1", { email: "taken@x.c" })).rejects.toThrow(/already in use/);
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

describe("AuthService.loginWithGithub", () => {
  it("creates a user + team + membership on first GitHub sign-in", async () => {
    const userCreate = jest.fn().mockResolvedValue({ id: "u1", email: "gh@x.io", name: "GH" });
    const teamCreate = jest.fn().mockResolvedValue({ id: "t1" });
    const memberCreate = jest.fn().mockResolvedValue({});
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(async (cb: (tx: unknown) => unknown) =>
        cb({ user: { create: userCreate }, team: { create: teamCreate }, membership: { create: memberCreate } }),
      ),
    } as unknown as PrismaService;
    const teamDefaults = { ensureDefaults: jest.fn().mockResolvedValue(undefined) };
    const svc = makeService(prisma, teamDefaults);
    const issue = jest.spyOn(svc, "issueTokens");

    const pair = await svc.loginWithGithub("gh@x.io", "GH");

    expect(userCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ email: "gh@x.io", name: "GH" }) });
    expect(memberCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ role: "OWNER" }) });
    // The new team is bootstrapped with its default project + env inside the tx.
    expect(teamDefaults.ensureDefaults).toHaveBeenCalledWith("t1", expect.anything());
    expect(issue).toHaveBeenCalledWith("u1");
    expect(pair.accessToken).toBeTruthy();
  });

  it("logs an existing user in without creating anything", async () => {
    const tx = jest.fn();
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: "u9", email: "gh@x.io" }) },
      $transaction: tx,
    } as unknown as PrismaService;
    const svc = makeService(prisma);
    const issue = jest.spyOn(svc, "issueTokens");

    await svc.loginWithGithub("gh@x.io");

    expect(tx).not.toHaveBeenCalled();
    expect(issue).toHaveBeenCalledWith("u9");
  });
});
