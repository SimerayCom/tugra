import { agentSessionBaseUrl, type CoolifyServerLink } from "@tugra/shared";
import type { ImportPreflight, PreflightHost, PreflightProject } from "./foreign-fleet";
import type { ServerLink } from "../coolify-takeover/coolify-install-plan";

/** Type-level contract of the Coolify takeover plan additions: they are optional, so an API-path plan stays valid unchanged. */
describe("takeover plan additions (types)", () => {
  it("lets a plan carry the agent read fields, and leaves them out on the API path", () => {
    const api: Pick<ImportPreflight, "agentRead" | "teams" | "unreadable"> = {};
    const agent: Pick<ImportPreflight, "agentRead" | "teams" | "unreadable"> = {
      agentRead: { transport: "agent", agentServerId: "srv1", schemaVersion: "2025_x", coolifyImage: "ghcr.io/coollabsio/coolify:4.7.8", readAt: "2026-12-07T00:00:00Z", counts: { teams: 1, projects: 2, servers: 3, applications: 4, databases: 5, services: 6 } },
      teams: [{ ref: "0", name: "Root" }],
      unreadable: [{ itemRef: "app:a:1", field: "env:DB_URL", code: "bad_mac" }],
    };
    expect(Object.keys(api)).toEqual([]);
    expect(agent.unreadable?.[0].code).toBe("bad_mac");
    expect(agentSessionBaseUrl("srv1")).toBe("agent://srv1");
  });

  it("types unreadable values with a fixed code and no value field", () => {
    // @ts-expect-error a value field does not exist on an unreadable entry
    const leaky: NonNullable<ImportPreflight["unreadable"]>[number] = { itemRef: "a", field: "f", code: "bad_mac", value: "hunter2" };
    // @ts-expect-error "ok" is not a failure code
    const ok: NonNullable<ImportPreflight["unreadable"]>[number] = { itemRef: "a", field: "f", code: "ok" };
    expect([leaky, ok]).toHaveLength(2);
  });

  it("adds team to a project and match/placement hints to a host, all optional", () => {
    const project: PreflightProject = { ref: "p", name: "P", itemRefs: [] };
    const withTeam: PreflightProject = { ...project, team: { ref: "0", name: "Root" } };
    const host: PreflightHost = { ref: "h" };
    const matched: PreflightHost = { ...host, match: { status: "certain", linkedBy: "auto", evidence: [{ kind: "machine_id", equal: true }] }, suggestedPlacement: "in-place", agentOnline: true };
    expect(withTeam.team?.name).toBe("Root");
    expect(matched.match?.evidence[0].kind).toBe("machine_id");
  });

  it("keeps an old serverLinks entry valid (linkedBy and evidence are additive)", () => {
    const old: ServerLink = { teamId: "t", serverId: "s" };
    const next: CoolifyServerLink = { ...old, linkedBy: "user", evidence: [] };
    expect(next.serverId).toBe("s");
  });
});
