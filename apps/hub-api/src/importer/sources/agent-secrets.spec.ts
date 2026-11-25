import { AgentSecretStore, AgentSecretStores, type SecretRefPlan } from "./agent-secrets";
import { fakePort } from "../__fixtures__/agent-secrets-port";

const refs = (): SecretRefPlan => ({ env: ["env:a", "env:b"], shared_env: ["shared_env:s"], notification: ["notification:1"], db_credentials: ["database:d"] });
const OPENED = { "env:a|value": "AAA", "env:b|value": "BBB", "shared_env:s|value": "SSS", "notification:1|telegram_token": "TTT", "database:d|postgres_password": "PGPASS", "database:d|postgres_conf": "CONF" };

describe("AgentSecretStore", () => {
  it("reads a consented class once, hands values out only through get, and asks the sealed service for THIS run", async () => {
    const port = fakePort({ opened: OPENED });
    const s = new AgentSecretStore(port, "srv", "sess-1", "u1");
    expect(s.get("env:a", "value")).toBeUndefined();
    expect(await s.ensure(["env"], refs)).toEqual({ env: "loaded" });
    expect(s.get("env:a", "value")).toBe("AAA");
    expect(s.get("env:b", "value")).toBe("BBB");
    expect(port.calls).toEqual([{ classes: ["env"], refs: ["env:a", "env:b"], runId: "sess-1", userId: "u1" }]);
    expect(JSON.stringify(s)).not.toMatch(/AAA|BBB|tk1\./); // the store's own state never serialises a value
  });

  it("does not ask twice for the same refs, but asks for refs that came later", async () => {
    const port = fakePort({ opened: OPENED });
    const s = new AgentSecretStore(port, "srv", "sess-1", "u1");
    await s.ensure(["env"], refs);
    await s.ensure(["env"], refs);
    expect(port.calls).toHaveLength(1);
    await s.ensure(["env"], () => ({ env: ["env:a", "env:b", "env:c"] }));
    expect(port.calls).toHaveLength(2);
    expect(port.calls[1].refs).toEqual(["env:c"]);
  });

  it("reads one class once however many ask at the same time (single flight)", async () => {
    const port = fakePort({ opened: OPENED, delayMs: 20 });
    const s = new AgentSecretStore(port, "srv", "sess-1", "u1");
    const out = await Promise.all([s.ensure(["env"], refs), s.ensure(["env"], refs), s.ensure(["env", "shared_env"], refs)]);
    expect(out.map((o) => o.env)).toEqual(["loaded", "loaded", "loaded"]);
    expect(port.calls.filter((c) => c.classes.includes("env"))).toHaveLength(1);
    expect(port.calls.filter((c) => c.classes.includes("shared_env"))).toHaveLength(1);
  });

  it("asks for nothing the consent does not cover (a class left off is not_consented and no call is made)", async () => {
    const port = fakePort({ opened: OPENED, granted: ["env"] });
    const s = new AgentSecretStore(port, "srv", "sess-1", "u1");
    expect(await s.ensure(["env", "notification", "shared_env"], refs)).toEqual({ env: "loaded", notification: "not_consented", shared_env: "not_consented" });
    expect(port.calls.map((c) => c.classes)).toEqual([["env"]]);
    expect(s.get("notification:1", "telegram_token")).toBeUndefined();
  });

  it("without any consent nothing is asked and nothing is held", async () => {
    const port = fakePort({ opened: OPENED, granted: null });
    const s = new AgentSecretStore(port, "srv", "sess-1", "u1");
    expect(await s.consentedClasses()).toEqual([]);
    expect(await s.ensure(["env"], refs)).toEqual({ env: "not_consented" });
    expect(port.calls).toEqual([]);
  });

  it("a consent that ends in the middle of the read leaves the class absent (never a throw into the import)", async () => {
    const port = fakePort({ opened: OPENED, throwOn: "env" });
    const s = new AgentSecretStore(port, "srv", "sess-1", "u1");
    await expect(s.ensure(["env"], refs)).resolves.toEqual({ env: "not_consented" });
    expect(s.get("env:a", "value")).toBeUndefined();
  });

  it("a partial read is reported, keeps what was read, and is asked for again only for what is left", async () => {
    const port = fakePort({ opened: OPENED, incompleteOn: "env" });
    const s = new AgentSecretStore(port, "srv", "sess-1", "u1");
    expect(await s.ensure(["env"], refs)).toEqual({ env: "incomplete" });
    expect(s.get("env:a", "value")).toBe("AAA");
    port.calls.length = 0;
    await s.ensure(["env"], refs);
    expect(port.calls[0].refs).toEqual(["env:b"]);
  });

  it("keeps the fixed code of a value that could not be opened, and counts it", async () => {
    const port = fakePort({ opened: { "env:b|value": "BBB" }, codes: { "env:a|value": "bad_mac" } });
    const s = new AgentSecretStore(port, "srv", "sess-1", "u1");
    await s.ensure(["env"], refs);
    expect(s.get("env:a", "value")).toBeUndefined();
    expect(s.codeOf("env:a", "value")).toBe("bad_mac");
    expect(s.unreadableCount()).toBe(1);
    expect(s.unreadable()).toEqual([{ itemRef: "env:a", field: "value", code: "bad_mac" }]);
  });

  it("drops a database password on arrival (only the engine's config text is kept)", async () => {
    const port = fakePort({ opened: OPENED });
    const s = new AgentSecretStore(port, "srv", "sess-1", "u1");
    await s.ensure(["db_credentials"], refs);
    expect(s.get("database:d", "postgres_conf")).toBe("CONF");
    expect(s.get("database:d", "postgres_password")).toBeUndefined();
  });

  it("onlyFields gives out the named fields and nothing else (what the plan may see)", async () => {
    const port = fakePort({ opened: { "service:x|docker_compose_raw": "YAML", "service:x|other": "NO" } });
    const s = new AgentSecretStore(port, "srv", "sess-1", "u1");
    await s.ensure(["service_compose"], () => ({ service_compose: ["service:x"] }));
    const plan = s.onlyFields(new Set(["docker_compose_raw"]));
    expect(plan.get("service:x", "docker_compose_raw")).toBe("YAML");
    expect(plan.get("service:x", "other")).toBeUndefined();
  });

  it("reset forgets every value and every read; finish also ends the consent of the run", async () => {
    const port = fakePort({ opened: OPENED });
    const s = new AgentSecretStore(port, "srv", "sess-1", "u1");
    await s.ensure(["env"], refs);
    s.reset();
    expect(s.get("env:a", "value")).toBeUndefined();
    await s.ensure(["env"], refs);
    expect(port.calls).toHaveLength(2);
    await s.finish();
    expect(s.get("env:a", "value")).toBeUndefined();
    expect(port.finished).toEqual([["srv", "sess-1"]]);
  });
});

describe("AgentSecretStores", () => {
  it("gives one store per (server, run) and ends the run's consent when it finishes", async () => {
    const port = fakePort({ opened: OPENED });
    const stores = new AgentSecretStores(port);
    const a = stores.forRun("srv", "sess-1", "u1");
    expect(stores.forRun("srv", "sess-1", "u1")).toBe(a);
    expect(stores.forRun("srv", "sess-2", "u1")).not.toBe(a);
    expect(stores.size).toBe(2);
    await a.ensure(["env"], refs);
    await stores.finish("srv", "sess-1");
    expect(stores.size).toBe(1);
    expect(port.finished).toEqual([["srv", "sess-1"]]);
    expect(stores.forRun("srv", "sess-1", "u1").get("env:a", "value")).toBeUndefined(); // a new store: nothing carried over
  });

  it("ends the consent even when no store is in memory (a restarted hub)", async () => {
    const port = fakePort();
    const stores = new AgentSecretStores(port);
    await stores.finish("srv", "sess-9");
    expect(port.finished).toEqual([["srv", "sess-9"]]);
  });

  it("drops a store that was idle for 30 minutes", () => {
    const port = fakePort();
    const stores = new AgentSecretStores(port);
    const old = stores.forRun("srv", "sess-1", "u1");
    old.lastUsed = Date.now() - 31 * 60_000;
    stores.forRun("srv", "sess-2", "u1");
    expect(stores.size).toBe(1);
  });
});

