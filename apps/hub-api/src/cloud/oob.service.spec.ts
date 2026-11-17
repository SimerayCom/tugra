import { BadRequestException, ConflictException, ForbiddenException, HttpException, Logger, NotFoundException } from "@nestjs/common";
import { OobService, oobHttpError } from "./oob.service";
import { OobController } from "./oob.controller";
import { HetznerApiClient, HetznerApiError } from "./providers/hetzner.client";
import { CloudProviderFactory } from "./providers/provider-factory.service";
import { DigitalOceanApiClient } from "./providers/digitalocean.client";
import { VultrApiClient } from "./providers/vultr.client";
import { FAKE_CONSOLE_PASSWORD, FAKE_CONSOLE_URL, FAKE_ROOT_PASSWORD, FakeHetznerApi } from "./testing/fake-hetzner-api";
import { REQUIRE_SCOPES } from "../api-tokens/require-scopes.decorator";
import type { PrismaService } from "../prisma/prisma.service";
import type { AuditService } from "../audit/audit.service";
import type { CryptoService } from "../crypto/crypto.service";
import type { TeamAccessService } from "../common/team-access.service";

const TOKEN = "hz-token";
const baseServer = {
  id: "s1",
  teamId: "t1",
  name: "web-1",
  publicIp: "203.0.113.10",
  provider: "hetzner" as string | null,
  providerServerId: "42" as string | null,
  cloudCredentialId: "cc1" as string | null,
  providerManualLink: false,
};
const cred = { id: "cc1", teamId: "t1", name: "prod project", provider: "hetzner", apiTokenEnc: "enc:" + TOKEN };

function make(over: { server?: Partial<typeof baseServer> | null; cred?: unknown; perms?: string[] | null; deny?: boolean } = {}) {
  const order: string[] = [];
  const api = new FakeHetznerApi().add({ id: 42, name: "web-1", status: "running", ipv4: "203.0.113.10" }).add({ id: 77, name: "db-1", status: "running", ipv4: "198.51.100.7" }).install();
  // Record the moment the provider is first touched, to prove the audit entry is written BEFORE it.
  const rawFetch = (globalThis as { fetch: typeof fetch }).fetch;
  (globalThis as { fetch: typeof fetch }).fetch = ((...a: Parameters<typeof fetch>) => {
    order.push("provider");
    return rawFetch(...a);
  }) as typeof fetch;
  const server = over.server === null ? null : { ...baseServer, ...over.server };
  const prisma = {
    server: {
      findUnique: jest.fn().mockResolvedValue(server),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
    cloudCredential: { findUnique: jest.fn().mockImplementation(async ({ where }: { where: { id: string } }) => ("cred" in over ? over.cred : where.id === "cc1" ? cred : null)) },
  };
  const audit = { log: jest.fn().mockImplementation(async (e: { action: string }) => void order.push(`audit:${e.action}`)) };
  const crypto = { decrypt: jest.fn().mockImplementation((s: string) => s.replace(/^enc:/, "")), encrypt: jest.fn() };
  const perms = new Set(over.perms === undefined ? ["servers:ops", "servers:manage"] : (over.perms ?? []));
  const access = {
    requirePermission: jest.fn().mockImplementation(async (_u: string, _t: string, p: string) => {
      if (over.deny || !perms.has(p)) throw new ForbiddenException("insufficient permission");
    }),
    membershipPermissions: jest.fn().mockResolvedValue(over.perms === null ? null : perms),
  };
  const providers = new CloudProviderFactory(new HetznerApiClient(), new DigitalOceanApiClient(), new VultrApiClient());
  const svc = new OobService(prisma as unknown as PrismaService, access as unknown as TeamAccessService, audit as unknown as AuditService, crypto as unknown as CryptoService, providers);
  return { svc, api, prisma, audit, crypto, access, order };
}

describe("OobService", () => {
  let ctx: ReturnType<typeof make>;
  afterEach(() => ctx?.api.uninstall());

  describe("authorisation + link gates (the provider is never touched)", () => {
    it.each([
      ["power", (c: ReturnType<typeof make>) => c.svc.power("u1", "s1", { action: "power_on" })],
      ["enableRescue", (c: ReturnType<typeof make>) => c.svc.enableRescue("u1", "s1")],
      ["disableRescue", (c: ReturnType<typeof make>) => c.svc.disableRescue("u1", "s1")],
      ["console", (c: ReturnType<typeof make>) => c.svc.console("u1", "s1")],
    ])("%s without servers:ops is refused: no provider call, no audit entry", async (_n, run) => {
      ctx = make({ perms: ["servers:manage"] });
      await expect(run(ctx)).rejects.toBeInstanceOf(ForbiddenException);
      expect(ctx.access.requirePermission).toHaveBeenCalledWith("u1", "t1", "servers:ops");
      expect(ctx.api.requests).toHaveLength(0);
      expect(ctx.audit.log).not.toHaveBeenCalled();
    });

    it("an unknown server is a 404", async () => {
      ctx = make({ server: null });
      await expect(ctx.svc.power("u1", "nope", { action: "power_on" })).rejects.toBeInstanceOf(NotFoundException);
    });

    it("a server with no cloud link is a 409 oob_not_linked", async () => {
      ctx = make({ server: { provider: null, providerServerId: null, cloudCredentialId: null } });
      await expect(ctx.svc.power("u1", "s1", { action: "power_on" })).rejects.toMatchObject({ response: { code: "oob_not_linked" } });
      expect(ctx.api.requests).toHaveLength(0);
    });

    it("a provider without an out-of-band client yet (DigitalOcean) is a clear 400", async () => {
      ctx = make({ server: { provider: "digitalocean" } });
      await expect(ctx.svc.power("u1", "s1", { action: "power_on" })).rejects.toThrow(/not available for digitalocean/);
    });

    it("a deleted credential (the link survives with a null credential id) is a 409 oob_credential_missing", async () => {
      ctx = make({ server: { cloudCredentialId: null } });
      await expect(ctx.svc.power("u1", "s1", { action: "power_on" })).rejects.toMatchObject({ response: { code: "oob_credential_missing" } });
    });

    it("a credential of ANOTHER team is never used", async () => {
      ctx = make({ cred: { ...cred, teamId: "other-team" } });
      await expect(ctx.svc.power("u1", "s1", { action: "power_on" })).rejects.toMatchObject({ response: { code: "oob_credential_missing" } });
      expect(ctx.api.requests).toHaveLength(0);
    });
  });

  describe("typed confirmation", () => {
    it.each(["power_off", "reboot", "shutdown"] as const)("%s needs the server's exact name: missing, empty and wrong are refused before anything happens", async (action) => {
      ctx = make();
      for (const confirmName of [undefined, "", "web-2", "WEB-1", " web-1"]) {
        await expect(ctx.svc.power("u1", "s1", { action, confirmName })).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(ctx.api.requests).toHaveLength(0);
      expect(ctx.audit.log).not.toHaveBeenCalled();
    });

    it.each([
      ["power_off", "poweroff"],
      ["reboot", "reset"],
      ["shutdown", "shutdown"],
    ] as const)("%s with the right name reaches the provider's %s endpoint", async (action, endpoint) => {
      ctx = make();
      const r = await ctx.svc.power("u1", "s1", { action, confirmName: "web-1" });
      expect(ctx.api.requests.map((x) => x.path)).toEqual([`/servers/42/actions/${endpoint}`]);
      expect(r).toMatchObject({ ok: true, action, providerAction: { status: "running", command: endpoint } });
    });

    it("power_on, disable_rescue, enable_rescue and console need no typed name", async () => {
      ctx = make();
      await ctx.svc.power("u1", "s1", { action: "power_on" });
      await ctx.svc.disableRescue("u1", "s1");
      await ctx.svc.enableRescue("u1", "s1");
      await ctx.svc.console("u1", "s1");
      expect(ctx.api.requests.map((x) => x.path)).toEqual([
        "/servers/42/actions/poweron",
        "/servers/42/actions/disable_rescue",
        "/servers/42/actions/enable_rescue",
        "/servers/42/actions/request_console",
      ]);
    });
  });

  describe("audit before the call, with the stored credential's token", () => {
    it("writes the audit entry BEFORE the provider is touched, and sends the decrypted token as a bearer", async () => {
      ctx = make();
      await ctx.svc.power("u1", "s1", { action: "reboot", confirmName: "web-1" });
      expect(ctx.order).toEqual(["audit:server.oob.power.reboot", "provider"]);
      expect(ctx.audit.log).toHaveBeenCalledWith({ actor: "u1", action: "server.oob.power.reboot", target: "s1", meta: { provider: "hetzner", providerServerId: "42", action: "reboot" } });
      expect(ctx.api.requests[0].authorization).toBe(`Bearer ${TOKEN}`);
      expect(ctx.crypto.decrypt).toHaveBeenCalledWith("enc:" + TOKEN);
    });

    it("a provider failure is mapped, and noted in a second `.failed` audit entry (no message, no secret)", async () => {
      ctx = make();
      ctx.api.failNext = { status: 423, code: "locked", message: "server is locked" };
      await expect(ctx.svc.power("u1", "s1", { action: "power_on" })).rejects.toMatchObject({ response: { code: "oob_locked", statusCode: 409 } });
      expect(ctx.order).toEqual(["audit:server.oob.power.power_on", "provider", "audit:server.oob.power.power_on.failed"]);
      expect(ctx.audit.log).toHaveBeenLastCalledWith(expect.objectContaining({ action: "server.oob.power.power_on.failed", meta: expect.objectContaining({ httpStatus: 409 }) }));
    });
  });

  describe("secrets are returned once and never logged or persisted", () => {
    it("enableRescue returns the root password; the audit entry, the DB writes, Logger and console never see it", async () => {
      ctx = make();
      const spies = [jest.spyOn(Logger.prototype, "log"), jest.spyOn(Logger.prototype, "warn"), jest.spyOn(Logger.prototype, "error"), jest.spyOn(Logger.prototype, "debug"), jest.spyOn(console, "log"), jest.spyOn(console, "error"), jest.spyOn(console, "warn")];
      spies.forEach((s) => s.mockImplementation(() => undefined));
      try {
        const r = await ctx.svc.enableRescue("u1", "s1");
        expect(r).toMatchObject({ ok: true, action: "enable_rescue", rootPassword: FAKE_ROOT_PASSWORD, expiresInMinutes: 60 });
        expect(JSON.stringify(ctx.audit.log.mock.calls)).not.toContain(FAKE_ROOT_PASSWORD);
        expect(JSON.stringify(ctx.prisma.server.update.mock.calls)).not.toContain(FAKE_ROOT_PASSWORD);
        expect(ctx.prisma.server.update).not.toHaveBeenCalled();
        for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(FAKE_ROOT_PASSWORD);
      } finally {
        spies.forEach((s) => s.mockRestore());
      }
    });

    it("console returns the wss url + password once; nothing is audited, stored or logged", async () => {
      ctx = make();
      const spy = jest.spyOn(console, "log").mockImplementation(() => undefined);
      try {
        const r = await ctx.svc.console("u1", "s1");
        expect(r).toMatchObject({ ok: true, action: "console", wssUrl: FAKE_CONSOLE_URL, password: FAKE_CONSOLE_PASSWORD, validForSeconds: 60 });
        const traces = JSON.stringify([ctx.audit.log.mock.calls, ctx.prisma.server.update.mock.calls, spy.mock.calls]);
        expect(traces).not.toContain(FAKE_CONSOLE_PASSWORD);
        expect(traces).not.toContain("token=");
        expect(traces).not.toContain(TOKEN);
      } finally {
        spy.mockRestore();
      }
    });

    it("a failing call never puts the API token or a secret in the error it throws", async () => {
      ctx = make();
      ctx.api.failNext = { status: 0, code: "", message: "" };
      const err = (await ctx.svc.enableRescue("u1", "s1").catch((e) => e)) as HttpException;
      expect(JSON.stringify(err.getResponse())).not.toContain(TOKEN);
      expect(err.getStatus()).toBe(502);
    });
  });

  describe("error mapping (oobHttpError)", () => {
    const cases: Array<[number, string | undefined, number, string]> = [
      [0, undefined, 502, "oob_provider_unreachable"],
      [401, "unauthorized", 424, "oob_credential_rejected"],
      [403, "forbidden", 424, "oob_credential_rejected"],
      [403, "maintenance", 503, "oob_provider_maintenance"],
      [404, "not_found", 409, "oob_provider_server_missing"],
      [423, "locked", 409, "oob_locked"],
      [423, "protected", 409, "oob_protected"],
      [422, "unsupported_error", 422, "oob_unsupported"],
      [422, "invalid_input", 422, "oob_unsupported"],
      [422, "service_error", 502, "oob_provider_error"],
      [429, "rate_limit_exceeded", 429, "oob_rate_limited"],
      [504, "timeout", 504, "oob_provider_timeout"],
      [500, "server_error", 502, "oob_provider_error"],
    ];
    it.each(cases)("provider %i/%s -> HTTP %i %s (a provider 401/403 is never passed through as Tugra auth failure)", (status, code, http, mapped) => {
      const e = oobHttpError("hetzner", new HetznerApiError("hetzner: boom", status, code ? { code } : undefined));
      expect(e.getStatus()).toBe(http);
      expect(e.getResponse()).toMatchObject({ code: mapped, statusCode: http });
      expect([401, 403]).not.toContain(e.getStatus());
    });
    it("a non-provider error becomes a 502, keeping a readable message", () => {
      const e = oobHttpError("hetzner", new Error("weird"));
      expect(e.getStatus()).toBe(502);
    });
  });

  describe("status", () => {
    it("not linked: reports linked=false and calls nothing", async () => {
      ctx = make({ server: { provider: null, providerServerId: null, cloudCredentialId: null } });
      await expect(ctx.svc.status("u1", "s1")).resolves.toMatchObject({ linked: false, supported: false, state: null, canManage: true, canOps: true });
      expect(ctx.api.requests).toHaveLength(0);
    });
    it("linked: returns the live provider state", async () => {
      ctx = make();
      ctx.api.servers.get(42)!.rescue_enabled = true;
      await expect(ctx.svc.status("u1", "s1")).resolves.toMatchObject({
        linked: true,
        provider: "hetzner",
        supported: true,
        manual: false,
        credentialName: "prod project",
        state: { status: "running", rescueEnabled: true, locked: false, publicIpv4: "203.0.113.10" },
        stateError: null,
      });
    });
    it("a provider error is a stateError (the link is still reported), not an exception", async () => {
      ctx = make();
      ctx.api.failNext = { status: 429, code: "rate_limit_exceeded", message: "slow down" };
      const s = await ctx.svc.status("u1", "s1");
      expect(s).toMatchObject({ linked: true, state: null });
      expect(s.stateError).toMatch(/rate limiting/);
    });
    it("a deleted credential is credentialMissing, not linked", async () => {
      ctx = make({ server: { cloudCredentialId: null } });
      await expect(ctx.svc.status("u1", "s1")).resolves.toMatchObject({ linked: false, credentialMissing: true, providerServerId: "42" });
    });
    it("a non-member is refused; a member without servers:ops can read the status but is told so", async () => {
      ctx = make({ perms: null });
      await expect(ctx.svc.status("u1", "s1")).rejects.toBeInstanceOf(ForbiddenException);
      ctx.api.uninstall();
      ctx = make({ perms: [] });
      await expect(ctx.svc.status("u1", "s1")).resolves.toMatchObject({ canOps: false, canManage: false, linked: true });
    });
  });

  describe("linking an existing server", () => {
    const unlinked = { provider: null, providerServerId: null, cloudCredentialId: null };

    it("candidates lists the credential's VMs, flags the IP match and the ones already taken", async () => {
      ctx = make({ server: unlinked });
      ctx.prisma.server.findMany.mockResolvedValue([{ providerServerId: "77" }]);
      const list = await ctx.svc.candidates("u1", "s1", "cc1");
      expect(list.find((c) => c.providerServerId === "42")).toMatchObject({ matchesIp: true, taken: false, name: "web-1" });
      expect(list.find((c) => c.providerServerId === "77")).toMatchObject({ matchesIp: false, taken: true });
    });

    it("links when the public IP matches: manual link written, never destroyable, audited", async () => {
      ctx = make({ server: unlinked });
      await ctx.svc.link("u1", "s1", { cloudCredentialId: "cc1", providerServerId: "42" });
      expect(ctx.prisma.server.update).toHaveBeenCalledWith({ where: { id: "s1" }, data: { provider: "hetzner", providerServerId: "42", cloudCredentialId: "cc1", providerManualLink: true } });
      expect(ctx.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "server.oob.link", meta: expect.objectContaining({ ipVerified: true, providerServerId: "42" }) }));
    });

    it("an IP mismatch is refused (409 oob_link_unverified, naming the provider server) unless its name is typed", async () => {
      ctx = make({ server: unlinked });
      await expect(ctx.svc.link("u1", "s1", { cloudCredentialId: "cc1", providerServerId: "77" })).rejects.toMatchObject({ response: { code: "oob_link_unverified", providerServerName: "db-1" } });
      await expect(ctx.svc.link("u1", "s1", { cloudCredentialId: "cc1", providerServerId: "77", confirmProviderName: "wrong" })).rejects.toBeInstanceOf(ConflictException);
      expect(ctx.prisma.server.update).not.toHaveBeenCalled();
      await ctx.svc.link("u1", "s1", { cloudCredentialId: "cc1", providerServerId: "77", confirmProviderName: "db-1" });
      expect(ctx.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "server.oob.link", meta: expect.objectContaining({ ipVerified: false }) }));
    });

    it("an unknown public IP also needs the typed provider name", async () => {
      ctx = make({ server: { ...unlinked, publicIp: null as unknown as string } });
      await expect(ctx.svc.link("u1", "s1", { cloudCredentialId: "cc1", providerServerId: "42" })).rejects.toMatchObject({ response: { code: "oob_link_unverified" } });
    });

    it("a cloud server already linked to another Tugra server is refused", async () => {
      ctx = make({ server: unlinked });
      ctx.prisma.server.findFirst.mockResolvedValue({ id: "other" });
      await expect(ctx.svc.link("u1", "s1", { cloudCredentialId: "cc1", providerServerId: "42" })).rejects.toThrow(/already linked to another server/);
    });

    it("a provider server that does not exist is a clear error and nothing is written", async () => {
      ctx = make({ server: unlinked });
      await expect(ctx.svc.link("u1", "s1", { cloudCredentialId: "cc1", providerServerId: "999" })).rejects.toMatchObject({ response: { code: "oob_provider_server_missing" } });
      expect(ctx.prisma.server.update).not.toHaveBeenCalled();
    });

    it("needs servers:manage (not just ops), and a credential of the same team", async () => {
      ctx = make({ server: unlinked, perms: ["servers:ops"] });
      await expect(ctx.svc.link("u1", "s1", { cloudCredentialId: "cc1", providerServerId: "42" })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(ctx.svc.candidates("u1", "s1", "cc1")).rejects.toBeInstanceOf(ForbiddenException);
      ctx.api.uninstall();
      ctx = make({ server: unlinked, cred: { ...cred, teamId: "x" } });
      await expect(ctx.svc.link("u1", "s1", { cloudCredentialId: "cc1", providerServerId: "42" })).rejects.toBeInstanceOf(NotFoundException);
    });

    it("a server Tugra provisioned cannot be re-linked or unlinked; a hand link can be unlinked", async () => {
      ctx = make();
      await expect(ctx.svc.link("u1", "s1", { cloudCredentialId: "cc1", providerServerId: "42" })).rejects.toThrow(/provisioned by Tugra/);
      await expect(ctx.svc.unlink("u1", "s1")).rejects.toThrow(/provisioned by Tugra/);
      ctx.api.uninstall();
      ctx = make({ server: { providerManualLink: true } });
      await ctx.svc.unlink("u1", "s1");
      expect(ctx.prisma.server.update).toHaveBeenCalledWith({ where: { id: "s1" }, data: { provider: null, providerServerId: null, cloudCredentialId: null, providerManualLink: false } });
      expect(ctx.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "server.oob.unlink" }));
    });

    it("unlink on a server that is not linked is a 400", async () => {
      ctx = make({ server: unlinked });
      await expect(ctx.svc.unlink("u1", "s1")).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});

describe("OobController route gates", () => {
  const scopesOf = (fn: unknown) => Reflect.getMetadata(REQUIRE_SCOPES, fn as object) as string[] | undefined;
  const p = OobController.prototype;

  it("every acting route needs the deploy scope; the two that return a secret also need read:secrets", () => {
    expect(scopesOf(p.power)).toEqual(["deploy"]);
    expect(scopesOf(p.disableRescue)).toEqual(["deploy"]);
    expect(scopesOf(p.candidates)).toEqual(["deploy"]);
    expect(scopesOf(p.link)).toEqual(["deploy"]);
    expect(scopesOf(p.unlink)).toEqual(["deploy"]);
    expect(scopesOf(p.enableRescue)).toEqual(["deploy", "read:secrets"]);
    expect(scopesOf(p.console)).toEqual(["deploy", "read:secrets"]);
    expect(scopesOf(p.status)).toBeUndefined(); // a read: the default GET scope
  });

  it("the secret-returning routes are never cacheable", () => {
    const headers = (fn: unknown) => Reflect.getMetadata("__headers__", fn as object) as Array<{ name: string; value: string }> | undefined;
    expect(headers(p.enableRescue)).toEqual(expect.arrayContaining([{ name: "Cache-Control", value: "no-store" }]));
    expect(headers(p.console)).toEqual(expect.arrayContaining([{ name: "Cache-Control", value: "no-store" }]));
  });

  it("delegates with the caller and the server id", async () => {
    const svc = { status: jest.fn().mockResolvedValue({}), power: jest.fn().mockResolvedValue({}), enableRescue: jest.fn(), disableRescue: jest.fn(), console: jest.fn(), candidates: jest.fn(), link: jest.fn(), unlink: jest.fn() };
    const c = new OobController(svc as never);
    const user = { userId: "u1" } as never;
    await c.status(user, "s1");
    await c.power(user, "s1", { action: "reboot", confirmName: "web-1" });
    await c.enableRescue(user, "s1");
    await c.console(user, "s1");
    await c.candidates(user, "s1", "cc1");
    expect(svc.status).toHaveBeenCalledWith("u1", "s1");
    expect(svc.power).toHaveBeenCalledWith("u1", "s1", { action: "reboot", confirmName: "web-1" });
    expect(svc.candidates).toHaveBeenCalledWith("u1", "s1", "cc1");
  });
});
