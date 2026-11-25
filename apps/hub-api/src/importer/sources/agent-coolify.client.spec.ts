import { AgentCoolifyClient } from "./agent-coolify.client";
import { AgentCoolifySource } from "./agent-coolify.source";
import { fixtureRead } from "../__fixtures__/agent-coolify.fixture";

describe("AgentCoolifyClient", () => {
  it("serves every get of one instance from ONE read (one snapshot), concurrent or not", async () => {
    const read = jest.fn(async () => fixtureRead());
    const c = new AgentCoolifyClient({ read }, "srv-agent");
    await Promise.all([c.get("/servers"), c.get("/applications"), c.get("/databases"), c.getText("/version")]);
    await c.get("/projects");
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith("srv-agent");
  });

  it("a new instance reads again (the drift check, the freeze and the final data pass build a new source)", async () => {
    const read = jest.fn(async () => fixtureRead());
    await new AgentCoolifyClient({ read }, "s").get("/servers");
    await new AgentCoolifyClient({ read }, "s").get("/servers");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("a failed read is not remembered: the next call tries again, and the error text is passed through unchanged", async () => {
    const read = jest.fn().mockRejectedValueOnce(new Error("agent_offline")).mockResolvedValue(fixtureRead());
    const c = new AgentCoolifyClient({ read }, "s");
    await expect(c.get("/servers")).rejects.toThrow("agent_offline");
    await expect(c.get("/servers")).resolves.toHaveLength(3);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("answers the version only when the image names one, and 404s any other text path", async () => {
    const c = new AgentCoolifyClient({ read: async () => fixtureRead() }, "s");
    await expect(c.getText("/version")).resolves.toBe("4.0.0-beta.463");
    await expect(c.getText("/other")).rejects.toMatchObject({ status: 404 });
    await expect(new AgentCoolifyClient({ read: async () => fixtureRead({ image: null }) }, "s").getText("/version")).rejects.toMatchObject({ status: 404 });
  });
});

describe("AgentCoolifySource", () => {
  const source = (read: () => Promise<ReturnType<typeof fixtureRead>> = async () => fixtureRead()) => new AgentCoolifySource(new AgentCoolifyClient({ read }, "srv-agent"));

  it("verifies by reading, with the version from the image; a failed read is a plain not-ok", async () => {
    expect(await source().verify()).toEqual({ ok: true, version: "4.0.0-beta.463" });
    expect(await source(async () => Promise.reject(new Error("Could not read Coolify (no_coolify)"))).verify()).toEqual({ ok: false, detail: "Could not read Coolify (no_coolify)" });
  });

  it("adds the agent facts as a separate block: counts, versions, teams; and says nothing for an empty read", async () => {
    const add = await source().agentPlan();
    expect(add.agentRead).toMatchObject({ transport: "agent", agentServerId: "srv-agent", coolifyImage: "ghcr.io/coollabsio/coolify:4.0.0-beta.463", counts: { applications: 4 } });
    expect(add.teams).toHaveLength(2);
    expect(add).not.toHaveProperty("unreadable"); // the sealed pipeline (lane B) fills it
  });

  it("one read serves discover and the plan block together", async () => {
    const read = jest.fn(async () => fixtureRead());
    const s = source(read);
    await s.discover();
    await s.agentPlan();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("offers no data movement of its own (volume bytes and database dumps are the migrator's)", () => {
    expect(source().capabilities()).toEqual({ apiRead: true, sshRead: false, dbDataDump: false, volumeRead: false });
  });

  it("asks for no token: the compose-needs-a-token warning is reworded", async () => {
    const f = await source().discover();
    expect(f.warnings.some((w) => /read:sensitive/.test(w))).toBe(false);
  });
});
