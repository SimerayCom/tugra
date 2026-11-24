import "reflect-metadata";
import { CostsController } from "./costs.controller";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { REQUIRE_SCOPES } from "../api-tokens/require-scopes.decorator";
import { CreateBaselineSchema, RescaleSchema, SetServerCostSchema } from "./costs.dto";

const GUARDS = "__guards__";

describe("CostsController surface", () => {
  it("is reachable by a PAT or a session, behind the scope guard", () => {
    const g = (Reflect.getMetadata(GUARDS, CostsController) ?? []) as unknown[];
    expect(g).toContain(ApiAuthGuard);
    expect(g).toContain(ScopesGuard);
    expect(g).not.toContain(JwtAuthGuard);
  });

  it("the actions that touch a provider or shut a server down need the deploy scope; reads stay on the default read scope", () => {
    const scopes = (name: keyof CostsController) => Reflect.getMetadata(REQUIRE_SCOPES, CostsController.prototype[name]);
    expect(scopes("sync")).toEqual(["deploy"]);
    expect(scopes("startRescale")).toEqual(["deploy"]);
    expect(scopes("report")).toBeUndefined();
    expect(scopes("adviceList")).toBeUndefined();
    expect(scopes("rescaleStatus")).toBeUndefined();
  });
});

describe("costs DTOs", () => {
  it("a typed price must be a non-negative number with a 3-letter currency, and nothing else", () => {
    expect(SetServerCostSchema.safeParse({ monthly: 12.5, currency: "EUR" }).success).toBe(true);
    expect(SetServerCostSchema.safeParse({ monthly: -1, currency: "EUR" }).success).toBe(false);
    expect(SetServerCostSchema.safeParse({ monthly: 1, currency: "euro" }).success).toBe(false);
    expect(SetServerCostSchema.safeParse({ monthly: 1, currency: "EUR", extra: 1 }).success).toBe(false);
  });

  it("a baseline is either the current prices or a typed total with its currency", () => {
    expect(CreateBaselineSchema.safeParse({ teamId: "t1" }).success).toBe(true);
    expect(CreateBaselineSchema.safeParse({ teamId: "t1", monthly: 100, currency: "EUR", label: "Before" }).success).toBe(true);
    expect(CreateBaselineSchema.safeParse({ teamId: "t1", monthly: 100 }).success).toBe(false);
  });

  it("a rescale names a plain plan id and the typed server name", () => {
    expect(RescaleSchema.safeParse({ planSlug: "cx33", confirmName: "web-1" }).success).toBe(true);
    expect(RescaleSchema.safeParse({ planSlug: "cx33; rm", confirmName: "web-1" }).success).toBe(false);
    expect(RescaleSchema.safeParse({ planSlug: "cx33" }).success).toBe(false);
  });
});
