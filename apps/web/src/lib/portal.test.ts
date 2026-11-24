import { describe, it, expect } from "vitest";
import { clientTeams, hasClientTeam, isPortalAllowed, isPortalOnly } from "./portal";
import type { Team } from "./types";

const team = (over: Partial<Team>): Team => ({ id: "t", name: "T", role: "OWNER", memberCount: 1, ...over });

describe("portal accounts", () => {
  const personal = team({ id: "p", memberCount: 1 });
  const acme = team({ id: "a", name: "Acme", role: "VIEWER", memberCount: 4, clientAccess: "view" });

  it("finds the teams the caller is a Client of", () => {
    expect(clientTeams([personal, acme]).map((t) => t.id)).toEqual(["a"]);
    expect(hasClientTeam([personal])).toBe(false);
    expect(hasClientTeam([personal, acme])).toBe(true);
  });

  it("a Client with only their solo personal team is portal-only", () => {
    expect(isPortalOnly([personal, acme])).toBe(true);
    expect(isPortalOnly([acme])).toBe(true);
  });

  it("anyone who runs a real team keeps the full app", () => {
    expect(isPortalOnly([personal, acme, team({ id: "o", memberCount: 3 })])).toBe(false);
    expect(isPortalOnly([personal])).toBe(false);
    expect(isPortalOnly([])).toBe(false);
  });

  it("only the portal and settings are open to a portal-only account", () => {
    expect(isPortalAllowed("/portal")).toBe(true);
    expect(isPortalAllowed("/settings/security")).toBe(true);
    expect(isPortalAllowed("/servers")).toBe(false);
    expect(isPortalAllowed("/portalx")).toBe(false);
  });
});
