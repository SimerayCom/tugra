import "reflect-metadata";
import { NotFoundException } from "@nestjs/common";
import type { ModuleRef } from "@nestjs/core";
import { CatalogController } from "./catalog.controller";
import { TemplateCatalogService } from "./template-catalog.service";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { REQUIRE_SCOPES } from "../api-tokens/require-scopes.decorator";
import { RedactSecretsInterceptor } from "../api-tokens/redact-secrets.interceptor";
import { APPLICATIONS_SERVICE } from "../applications/applications.tokens";
import type { PrismaService } from "../prisma/prisma.service";
import type { AuthUser } from "../auth/strategies/jwt.strategy";

// The bundled catalog is served synchronously from the constructor (no IO) — so a stub prisma suffices.
function realCatalog(): TemplateCatalogService {
  return new TemplateCatalogService({
    catalogSnapshot: { findUnique: jest.fn() },
  } as unknown as PrismaService);
}

const GUARDS = "__guards__";
const guards = (c: unknown) => (Reflect.getMetadata(GUARDS, c as object) ?? []) as unknown[];

describe("API-9 — CatalogController (public app-store API)", () => {
  it("is reachable by a PAT (ApiAuthGuard + ScopesGuard), not session-only", () => {
    const g = guards(CatalogController);
    expect(g).toContain(ApiAuthGuard);
    expect(g).toContain(ScopesGuard);
    expect(g).not.toContain(JwtAuthGuard);
  });

  it("deploy requires the `deploy` scope (a write-only token must not stand up infra)", () => {
    expect(Reflect.getMetadata(REQUIRE_SCOPES, CatalogController.prototype.deploy)).toEqual(["deploy"]);
  });

  // The deploy 201 is an AppView, which carries a decrypted `webhookSecret` for deploy-permitted callers.
  // Without this interceptor a `deploy`-scoped PAT lacking `read:secrets` would read it (the sibling
  // apps controller redacts it at the class level — this must match). Regression guard for API-9 review.
  it("redacts `webhookSecret` for scope-limited PATs (matches ApplicationsController)", () => {
    const interceptors = (Reflect.getMetadata("__interceptors__", CatalogController) ?? []) as unknown[];
    const redactor = interceptors.find((i) => i instanceof RedactSecretsInterceptor);
    expect(redactor).toBeDefined();
    expect((redactor as unknown as { fields: string[] }).fields).toContain("webhookSecret");
  });

  it("the read routes carry NO @RequireScopes (method default GET → read)", () => {
    expect(Reflect.getMetadata(REQUIRE_SCOPES, CatalogController.prototype.list)).toBeUndefined();
    expect(Reflect.getMetadata(REQUIRE_SCOPES, CatalogController.prototype.get)).toBeUndefined();
  });

  describe("list / get", () => {
    const ctrl = () => new CatalogController(realCatalog(), {} as ModuleRef);

    it("list() returns the whole gallery", () => {
      const out = ctrl().list();
      expect(Array.isArray(out)).toBe(true);
      expect(out.length).toBeGreaterThan(0);
      expect(out.some((e) => e.slug === "redis")).toBe(true);
    });

    it("get() returns one entry by slug", () => {
      const e = ctrl().get("redis");
      expect(e.slug).toBe("redis");
      expect(e.name).toBeTruthy();
    });

    it("get() 404s an unknown slug", () => {
      expect(() => ctrl().get("does-not-exist")).toThrow(NotFoundException);
    });

    // Secret-leak guard: the public API must serve the TemplateMeta projection ONLY — never the raw
    // TemplateDef (composeFile / secrets / env / install internals). Guards against a future swap of
    // metaList() for all()/get().
    it("NEVER exposes composeFile, secrets or install internals", () => {
      const forbidden = ["composeFile", "secrets", "env", "variables", "mounts", "exposure", "web"];
      const entries = [...ctrl().list(), ctrl().get("redis")];
      for (const e of entries) {
        for (const key of forbidden) {
          expect(e).not.toHaveProperty(key);
        }
      }
    });
  });

  describe("deploy", () => {
    it("delegates to ApplicationsService.createFromTemplate via the lazy token", async () => {
      const createFromTemplate = jest.fn().mockResolvedValue({ id: "app_1", name: "r" });
      const get = jest.fn().mockReturnValue({ createFromTemplate });
      const moduleRef = { get } as unknown as ModuleRef;
      const ctrl = new CatalogController(realCatalog(), moduleRef);

      const body = { name: "r", serverId: "srv_1", deploy: true };
      const user: AuthUser = { userId: "u_1", scopes: ["deploy"] };
      const res = await ctrl.deploy(user, "redis", body);

      expect(get).toHaveBeenCalledWith(APPLICATIONS_SERVICE, { strict: false });
      expect(createFromTemplate).toHaveBeenCalledWith("u_1", "redis", body);
      expect(res).toEqual({ id: "app_1", name: "r" });
    });
  });
});
