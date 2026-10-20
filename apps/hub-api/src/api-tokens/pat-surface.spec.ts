import "reflect-metadata";
import { TeamsController } from "../teams/teams.controller";
import { NotificationsController } from "../notifications/notifications.controller";
import { RegistriesController } from "../registries/registries.controller";
import { GitSourcesController } from "../git-sources/git-sources.controller";
import { CloudCredentialsController } from "../cloud/cloud-credentials.controller";
import { AuditController } from "../audit/audit.controller";
import { SavedViewsController } from "../saved-views/saved-views.controller";
import { ApiTokensController } from "./api-tokens.controller";
import { ApiAuthGuard } from "./api-auth.guard";
import { ScopesGuard } from "./scopes.guard";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { REQUIRE_SCOPES } from "./require-scopes.decorator";

// NestJS stores class-level @UseGuards(...) under this metadata key.
const GUARDS = "__guards__";
function guards(ctrl: unknown): unknown[] {
  return (Reflect.getMetadata(GUARDS, ctrl as object) ?? []) as unknown[];
}

describe("PAT surface parity", () => {
  const CONVERTED: Array<[string, unknown]> = [
    ["TeamsController", TeamsController],
    ["NotificationsController", NotificationsController],
    ["RegistriesController", RegistriesController],
    ["GitSourcesController", GitSourcesController],
    ["CloudCredentialsController", CloudCredentialsController],
    ["AuditController", AuditController],
    ["SavedViewsController", SavedViewsController],
  ];

  it.each(CONVERTED)("%s is reachable by a PAT (ApiAuthGuard + ScopesGuard), no longer session-only", (_name, ctrl) => {
    const g = guards(ctrl);
    expect(g).toContain(ApiAuthGuard);
    expect(g).toContain(ScopesGuard);
    expect(g).not.toContain(JwtAuthGuard);
  });

  it("api-tokens management STAYS session-only — a PAT must not mint, list or revoke PATs", () => {
    const g = guards(ApiTokensController);
    expect(g).toContain(JwtAuthGuard);
    expect(g).not.toContain(ApiAuthGuard);
    expect(g).not.toContain(ScopesGuard);
  });

  it("team routes that expose raw invite tokens require read:secrets", () => {
    expect(Reflect.getMetadata(REQUIRE_SCOPES, TeamsController.prototype.invitations)).toEqual(["read:secrets"]);
    expect(Reflect.getMetadata(REQUIRE_SCOPES, TeamsController.prototype.myInvitations)).toEqual(["read:secrets"]);
  });

  it("privilege-affecting team mutations require admin scope (not plain write)", () => {
    for (const m of ["invite", "setRole", "createRole", "updateRole", "setMemberAccess"] as const) {
      expect(Reflect.getMetadata(REQUIRE_SCOPES, TeamsController.prototype[m])).toEqual(["admin"]);
    }
  });
});
