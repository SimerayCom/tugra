import { AgentSecretsAdapter } from "./agent-secrets.adapter";

function make(grant: { runId: string; classes: string[] } | null = { runId: "sess-1", classes: ["env", "service_compose"] }) {
  const secrets = { fetchEncrypted: jest.fn().mockResolvedValue({ values: [{ ref: "env:a", field: "value", cls: "env", enc: "tk1.x" }], unreadable: [{ itemRef: "env:b", field: "value", code: "bad_mac" }], read: 1, usedPreviousKey: false }) };
  const grants = { activeSecretsGrant: jest.fn().mockResolvedValue(grant), finishRunByRunId: jest.fn().mockResolvedValue(undefined) };
  const crypto = { decrypt: jest.fn((s: string) => `plain(${s})`) };
  const a = new AgentSecretsAdapter(secrets as never, grants as never, crypto as never);
  return { a, secrets, grants, crypto };
}

describe("AgentSecretsAdapter: the importer's door to the sealed secret pipeline", () => {
  it("the consent counts for a session only when the standing grant was made for that very session", async () => {
    const { a } = make();
    expect(await a.grantedClasses("srv", "sess-1")).toEqual(["env", "service_compose"]);
    expect(await a.grantedClasses("srv", "sess-2")).toBeNull();
    expect(await make(null).a.grantedClasses("srv", "sess-1")).toBeNull();
  });

  it("reads through fetchEncrypted with the session as the run, for the asked classes and refs, and hands back ciphertext and codes", async () => {
    const { a, secrets } = make();
    const r = await a.fetchEncrypted({ serverId: "srv", runId: "sess-1", refs: ["env:a", "env:b"], classes: ["env"], userId: "u1" });
    expect(secrets.fetchEncrypted).toHaveBeenCalledWith({ serverId: "srv", refs: ["env:a", "env:b"], classes: ["env"], userId: "u1", runId: "sess-1" });
    expect(r.values).toEqual([{ ref: "env:a", field: "value", cls: "env", enc: "tk1.x" }]);
    expect(r.unreadable).toEqual([{ itemRef: "env:b", field: "value", code: "bad_mac" }]);
    expect(r.incomplete).toBeUndefined();
  });

  it("carries an incomplete read through (a later frame failed: the rest is reported)", async () => {
    const { a, secrets } = make();
    secrets.fetchEncrypted.mockResolvedValueOnce({ values: [], unreadable: [], read: 0, usedPreviousKey: false, incomplete: { code: "rate_limited", remainingRefs: ["env:z"] } });
    const r = await a.fetchEncrypted({ serverId: "srv", runId: "sess-1", refs: ["env:z"], classes: ["env"], userId: "u1" });
    expect(r.incomplete).toEqual({ code: "rate_limited", remainingRefs: ["env:z"] });
  });

  it("ends the consent of the run through the grant service, and opens a value only through the hub's own crypto", async () => {
    const { a, grants, crypto } = make();
    await a.finishRun("srv", "sess-1");
    expect(grants.finishRunByRunId).toHaveBeenCalledWith("srv", "sess-1");
    expect(a.decrypt("tk1.x")).toBe("plain(tk1.x)");
    expect(crypto.decrypt).toHaveBeenCalledWith("tk1.x");
  });

  it("has one store registry, so the plan, a preview and the apply of one session share one read", () => {
    const { a } = make();
    expect(a.stores.forRun("srv", "sess-1", "u1")).toBe(a.stores.forRun("srv", "sess-1", "u1"));
  });
});
