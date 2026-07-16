import { ExecutionContext, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { ApiAuthGuard } from "./api-auth.guard";
import type { ApiTokensService } from "./api-tokens.service";
import type { InstanceSettingsService } from "../instance/instance-settings.service";

const PAT = "tugra_pat_abc123";

function ctxFor(remoteAddress: string | undefined, forwardedFor?: string): ExecutionContext {
  const req = {
    headers: { authorization: `Bearer ${PAT}`, ...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}) },
    socket: { remoteAddress },
    user: undefined as unknown,
  };
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

function guard(settings: { apiEnabled: boolean; apiAllowedIps: string[] }, validated = { userId: "u1", scopes: ["read"], tokenId: "t1" } as unknown) {
  const tokens = { validate: jest.fn().mockResolvedValue(validated) } as unknown as ApiTokensService;
  const instance = { get: jest.fn().mockResolvedValue(settings) } as unknown as InstanceSettingsService;
  return new ApiAuthGuard(tokens, instance);
}

describe("ApiAuthGuard — PAT-only API gating", () => {
  afterEach(() => {
    delete process.env.HUB_TRUSTED_PROXY;
  });

  it("allows a valid PAT when the API is enabled and no allowlist is set", async () => {
    const ctx = ctxFor("1.2.3.4");
    await expect(guard({ apiEnabled: true, apiAllowedIps: [] }).canActivate(ctx)).resolves.toBe(true);
    expect(ctx.switchToHttp().getRequest().user).toEqual({ userId: "u1", scopes: ["read"], tokenId: "t1" });
  });

  it("blocks every PAT when the API is disabled (kill-switch)", async () => {
    await expect(guard({ apiEnabled: false, apiAllowedIps: [] }).canActivate(ctxFor("1.2.3.4"))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("blocks a PAT whose source IP is outside the allowlist", async () => {
    await expect(
      guard({ apiEnabled: true, apiAllowedIps: ["10.0.0.0/8"] }).canActivate(ctxFor("1.2.3.4")),
    ).rejects.toThrow(/not allowed/);
  });

  it("allows a PAT whose source IP is inside the allowlist", async () => {
    await expect(
      guard({ apiEnabled: true, apiAllowedIps: ["1.2.3.0/24"] }).canActivate(ctxFor("1.2.3.4")),
    ).resolves.toBe(true);
  });

  it("denies when an allowlist is set but the client IP can't be determined", async () => {
    await expect(
      guard({ apiEnabled: true, apiAllowedIps: ["1.2.3.0/24"] }).canActivate(ctxFor(undefined)),
    ).rejects.toThrow(/not allowed/);
  });

  it("uses the rightmost X-Forwarded-For entry only when HUB_TRUSTED_PROXY=true", async () => {
    process.env.HUB_TRUSTED_PROXY = "true";
    // proxy appends the real client (rightmost); a spoofed leftmost entry is ignored
    await expect(
      guard({ apiEnabled: true, apiAllowedIps: ["1.2.3.0/24"] }).canActivate(ctxFor("10.9.9.9", "9.9.9.9, 1.2.3.4")),
    ).resolves.toBe(true);
  });

  it("ignores X-Forwarded-For when the proxy is untrusted (default)", async () => {
    // trustProxy off → the socket peer (10.9.9.9) is used, not the spoofable XFF
    await expect(
      guard({ apiEnabled: true, apiAllowedIps: ["1.2.3.0/24"] }).canActivate(ctxFor("10.9.9.9", "1.2.3.4")),
    ).rejects.toThrow(/not allowed/);
  });

  it("rejects an invalid/expired PAT before any gating", async () => {
    await expect(guard({ apiEnabled: true, apiAllowedIps: [] }, null).canActivate(ctxFor("1.2.3.4"))).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
