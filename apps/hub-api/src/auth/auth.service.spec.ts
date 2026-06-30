import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import * as argon2 from "argon2";
import { AuthService } from "./auth.service";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";
import { CryptoService } from "../crypto/crypto.service";
import { TotpService } from "./totp.service";
import { AuditService } from "../audit/audit.service";

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
  async sadd(k: string, m: string): Promise<void> {
    if (!this.sets.has(k)) this.sets.set(k, new Set());
    this.sets.get(k)!.add(m);
  }
  async srem(k: string, m: string): Promise<void> {
    this.sets.get(k)?.delete(m);
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

function makeService(prisma: Partial<PrismaService> = {}): AuthService {
  return new AuthService(
    prisma as PrismaService,
    new JwtService({}),
    config,
    {} as CryptoService,
    {} as TotpService,
    { log: jest.fn() } as unknown as AuditService,
    new FakeRedis() as unknown as RedisService,
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

describe("AuthService.updateProfile", () => {
  const me = { id: "u1", email: "a@b.c", name: "Old", twoFaEnabled: false, password: "h" };

  it("updates the display name", async () => {
    const update = jest.fn().mockResolvedValue({ ...me, name: "New" });
    const prisma = { user: { findUnique: jest.fn().mockResolvedValue(me), update } } as unknown as PrismaService;
    const res = await makeService(prisma).updateProfile("u1", { name: "New" });
    expect(res.name).toBe("New");
    expect(update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { name: "New" } });
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
    const svc = makeService(prisma);
    const issue = jest.spyOn(svc, "issueTokens");

    const pair = await svc.loginWithGithub("gh@x.io", "GH");

    expect(userCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ email: "gh@x.io", name: "GH" }) });
    expect(memberCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ role: "OWNER" }) });
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
