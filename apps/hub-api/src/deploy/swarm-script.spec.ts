import {
  buildSwarmInfoScript,
  buildSwarmInitScript,
  buildSwarmJoinTokenScript,
  buildSwarmJoinScript,
  buildSwarmLeaveScript,
  buildNodeLsScript,
  buildSwarmTokenRotateScript,
  buildNodeDrainScript,
  buildNodeRemoveScript,
  buildNodeInspectAllScript,
  buildNodeLabelUpdateScript,
  SWARM_JOIN_TIMEOUT_SEC,
} from "./swarm-script";

describe("swarm-script builders", () => {
  it("info script queries the local swarm state as JSON", () => {
    expect(buildSwarmInfoScript()).toBe("docker info --format '{{json .Swarm}}'");
  });

  it("init advertises a validated IP and pins the listen addr to the mgmt port", () => {
    const s = buildSwarmInitScript("10.0.0.5");
    expect(s).toContain("docker swarm init");
    expect(s).toContain("--advertise-addr '10.0.0.5'");
    expect(s).toContain("--listen-addr '0.0.0.0:2377'");
  });

  it("init accepts an IPv6 literal", () => {
    expect(buildSwarmInitScript("2001:db8::1")).toContain("--advertise-addr '2001:db8::1'");
  });

  it("init THROWS on a non-IP advertise addr (injection / garbage) — before any agent sees it", () => {
    expect(() => buildSwarmInitScript("10.0.0.1; rm -rf /")).toThrow(/IP literal/);
    expect(() => buildSwarmInitScript("evil\nhost")).toThrow(/IP literal/);
    expect(() => buildSwarmInitScript("notanip")).toThrow(/IP literal/);
    expect(() => buildSwarmInitScript("")).toThrow(/IP literal/);
  });

  it("join-token requests exactly the role asked for (worker is what the service uses)", () => {
    expect(buildSwarmJoinTokenScript("worker")).toBe("docker swarm join-token -q worker");
    expect(buildSwarmJoinTokenScript("manager")).toBe("docker swarm join-token -q manager");
  });

  it("join is time-bounded, quotes the token, and dials manager:2377", () => {
    const s = buildSwarmJoinScript("SWMTKN-1-abc", "10.0.0.5");
    expect(s).toContain(`timeout ${SWARM_JOIN_TIMEOUT_SEC} docker swarm join`);
    expect(s).toContain("--token 'SWMTKN-1-abc'");
    expect(s).toContain("'10.0.0.5:2377'");
  });

  it("join never emits an unquoted token (shell-injection via a crafted token is neutralized)", () => {
    const s = buildSwarmJoinScript("x'; rm -rf / #", "10.0.0.5");
    // The single quote is escaped to '\'' — the token stays a single shell word; `; rm` never runs.
    expect(s).toContain("--token 'x'\\''; rm -rf / #'");
    expect(s).not.toContain("--token x'; rm");
  });

  it("join THROWS on a non-IP manager addr", () => {
    expect(() => buildSwarmJoinScript("tok", "10.0.0.5 && evil")).toThrow(/IP literal/);
    expect(() => buildSwarmJoinScript("tok", "")).toThrow(/IP literal/);
  });

  it("leave: plain for workers, --force for the manager", () => {
    expect(buildSwarmLeaveScript(false)).toBe("docker swarm leave");
    expect(buildSwarmLeaveScript(true)).toBe("docker swarm leave --force");
  });

  it("node ls emits one JSON object per line for reconcile", () => {
    expect(buildNodeLsScript()).toBe("docker node ls --format '{{json .}}'");
  });

  it("token rotate invalidates the worker join token", () => {
    expect(buildSwarmTokenRotateScript("worker")).toBe("docker swarm join-token --rotate -q worker");
  });

  it("node drain marks unschedulable then polls node ps to convergence, with a bounded timeout branch", () => {
    const s = buildNodeDrainScript("node_x", 9);
    expect(s).toContain("docker node update --availability drain 'node_x'");
    expect(s).toContain("docker node ps 'node_x' --filter desired-state=running");
    expect(s).toContain('echo "TUGRA_DRAIN: clean"; exit 0');
    expect(s).toContain('echo "TUGRA_DRAIN: timeout"; exit 2');
    expect(s).toContain("sleep 3"); // 9s / 3s interval = a bounded 3-iteration loop
  });

  it("node drain shq-quotes an id containing a quote", () => {
    expect(buildNodeDrainScript("a'b")).toContain("'a'\\''b'");
  });

  it("node rm force-removes by id with proper quoting", () => {
    expect(buildNodeRemoveScript("node_x")).toBe("docker node rm --force 'node_x'");
    expect(buildNodeRemoveScript("a'b")).toBe("docker node rm --force 'a'\\''b'");
  });

  it("node inspect-all lists every node as JSON (richer than node ls — carries labels/role)", () => {
    expect(buildNodeInspectAllScript()).toBe("docker node inspect $(docker node ls -q) --format '{{json .}}'");
  });

  it("node label update composes --label-add (adds) then --label-rm (removes), nodeId last + quoted", () => {
    expect(buildNodeLabelUpdateScript("nodeid1", { zone: "east" }, ["old"])).toBe("docker node update --label-add 'zone=east' --label-rm 'old' 'nodeid1'");
    // shell-safety: a value containing a quote is escaped
    expect(buildNodeLabelUpdateScript("n", { k: "a'b" }, [])).toContain("--label-add 'k=a'\\''b'");
  });
});
