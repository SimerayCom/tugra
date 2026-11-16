import {
  assertContainerId,
  assertRestartPolicy,
  buildSwapInspectScript,
  buildSwapReverseScript,
  buildSwapStatusScript,
  buildSwapStopSourceScript,
  canSwapTransition,
  parseSwapInspect,
  parseSwapState,
  swapIsPastPlanning,
  swapPlanHash,
  verifyCoolifyProxyIdentity,
  SWAP_STATES,
} from "./proxy-swap";
import { expectGolden } from "./testing/golden";

const ID = "a".repeat(64);
const inspectOut = (o: Partial<Record<"ID" | "NAME" | "IMAGE" | "RESTART" | "RUNNING" | "PORTS", string>> = {}) =>
  [`TUGRA_SWAP_ID=${o.ID ?? ID}`, `TUGRA_SWAP_NAME=${o.NAME ?? "/coolify-proxy"}`, `TUGRA_SWAP_IMAGE=${o.IMAGE ?? "traefik:v3.1"}`, `TUGRA_SWAP_RESTART=${o.RESTART ?? "always"}`, `TUGRA_SWAP_RUNNING=${o.RUNNING ?? "true"}`, `TUGRA_SWAP_PORTS=${o.PORTS ?? "80>80/tcp,443>443/tcp,8080>8080/tcp,"}`, "TUGRA_SWAP_END"].join("\n");

describe("swap scripts (golden)", () => {
  it("inspect is read-only and addresses the container by name", () => {
    const s = buildSwapInspectScript();
    expectGolden("swap-inspect.sh", s);
    expect(s).not.toMatch(/docker (stop|rm|kill|update|start)/);
    expect(s).toContain("docker container inspect");
  });

  it("stop sets restart=no FIRST, skips the stop when that fails, never removes", () => {
    const s = buildSwapStopSourceScript(ID);
    expectGolden("swap-stop-source.sh", s);
    expect(s.indexOf("docker update --restart=no")).toBeLessThan(s.indexOf("docker stop"));
    expect(s).toContain("exit 0; fi");
    expect(s).not.toMatch(/docker rm|docker kill|volume rm/);
  });

  it("reverse stops tugra-proxy, restores the RECORDED policy, starts the same id, never removes", () => {
    const s = buildSwapReverseScript(ID, "unless-stopped");
    expectGolden("swap-reverse.sh", s);
    expect(s.indexOf("docker stop tugra-proxy")).toBeLessThan(s.indexOf('docker start "$ID"'));
    expect(s).toContain("--restart=unless-stopped");
    expect(s).not.toMatch(/docker rm|docker kill|volume rm/);
  });

  it("status is read-only", () => {
    const s = buildSwapStatusScript(ID);
    expectGolden("swap-status.sh", s);
    expect(s).not.toMatch(/docker (stop|rm|kill|update|start) /);
  });

  it("every script input is validated: a container id and a restart policy cannot carry shell", () => {
    for (const bad of ["", "abc", `${ID}; reboot`, ID.toUpperCase(), `${ID}a`, "$(id)"]) {
      expect(() => buildSwapStopSourceScript(bad)).toThrow();
      expect(() => buildSwapReverseScript(bad, "no")).toThrow();
      expect(() => buildSwapStatusScript(bad)).toThrow();
      expect(() => assertContainerId(bad)).toThrow();
    }
    expect(() => buildSwapReverseScript(ID, "always; reboot")).toThrow();
    expect(() => assertRestartPolicy("on-failure:3")).toThrow();
    for (const p of ["no", "always", "unless-stopped", "on-failure"]) expect(assertRestartPolicy(p)).toBe(p);
  });
});

describe("parseSwapInspect + identity", () => {
  it("parses the coolify proxy and verifies the identity", () => {
    const p = parseSwapInspect(inspectOut());
    expect(p).toMatchObject({ absent: false, name: "/coolify-proxy", snapshot: { containerId: ID, name: "coolify-proxy", image: "traefik:v3.1", restartPolicy: "always", running: true, ports: ["80>80/tcp", "443>443/tcp", "8080>8080/tcp"] } });
    expect(verifyCoolifyProxyIdentity(p!)).toMatchObject({ ok: true });
  });

  it("an empty restart policy name means `no`", () => {
    const p = parseSwapInspect(inspectOut({ RESTART: "" }));
    expect(p && !p.absent && p.snapshot.restartPolicy).toBe("no");
  });

  it("absent is absent, and absent is not an identity", () => {
    const p = parseSwapInspect("TUGRA_SWAP_ABSENT\n");
    expect(p).toEqual({ absent: true });
    expect(verifyCoolifyProxyIdentity(p!)).toEqual({ ok: false, code: "absent" });
  });

  it("cut or malformed output is null (never `absent`)", () => {
    expect(parseSwapInspect(inspectOut().replace("\nTUGRA_SWAP_END", ""))).toBeNull();
    expect(parseSwapInspect(`${inspectOut()}\n…(truncated)`)).toBeNull();
    expect(parseSwapInspect(inspectOut({ ID: "xyz" }))).toBeNull();
    expect(parseSwapInspect(inspectOut({ RUNNING: "maybe" }))).toBeNull();
    expect(parseSwapInspect(inspectOut({ RESTART: "sometimes" }))).toBeNull();
    expect(parseSwapInspect(inspectOut({ PORTS: "80;443," }))).toBeNull();
    expect(parseSwapInspect(inspectOut({ IMAGE: "traefik v3; reboot" }))).toBeNull();
  });

  it("refuses anything that is not exactly the source's proxy: wrong name, wrong image, :80/:443 not published", () => {
    const check = (o: Parameters<typeof inspectOut>[0]) => verifyCoolifyProxyIdentity(parseSwapInspect(inspectOut(o))!);
    expect(check({ NAME: "/not-coolify-proxy" })).toEqual({ ok: false, code: "name" });
    expect(check({ IMAGE: "nginx:1.27" })).toEqual({ ok: false, code: "image" });
    expect(check({ PORTS: "443>443/tcp," })).toEqual({ ok: false, code: "ports" });
    expect(check({ PORTS: "" })).toEqual({ ok: false, code: "ports" });
    expect(check({ PORTS: "80>80/udp,443>443/udp," })).toEqual({ ok: false, code: "ports" });
    expect(check({ PORTS: "8080>80/tcp,8443>443/tcp," })).toEqual({ ok: false, code: "ports" });
    expect(check({ IMAGE: "ghcr.io/traefik/traefik:v3" })).toMatchObject({ ok: true });
  });
});

describe("parseSwapState", () => {
  it("parses source/target state and the published ports", () => {
    expect(parseSwapState("TUGRA_SWAP_SOURCE_RUNNING=false\nTUGRA_SWAP_TARGET=running\nTUGRA_SWAP_TARGET_PORTS=80>80/tcp,443>443/tcp,\nTUGRA_SWAP_STATUS_END")).toEqual({ sourceRunning: false, target: "running", targetPorts: ["80>80/tcp", "443>443/tcp"], updateFailed: false });
    expect(parseSwapState("TUGRA_SWAP_SOURCE_RUNNING=absent\n")).toMatchObject({ sourceRunning: "absent", target: "absent", targetPorts: [] });
  });

  it("the update-failed marker is reported and means nothing was stopped", () => {
    expect(parseSwapState("TUGRA_SWAP_UPDATE_FAILED\n")).toMatchObject({ updateFailed: true });
  });

  it("anything cut or malformed is null", () => {
    expect(parseSwapState("")).toBeNull();
    expect(parseSwapState("TUGRA_SWAP_SOURCE_RUNNING=maybe")).toBeNull();
    expect(parseSwapState("TUGRA_SWAP_SOURCE_RUNNING=true\n…(truncated)")).toBeNull();
    expect(parseSwapState("TUGRA_SWAP_SOURCE_RUNNING=true\nTUGRA_SWAP_TARGET=RUNNING;x")).toBeNull();
    expect(parseSwapState("TUGRA_SWAP_SOURCE_RUNNING=true\nTUGRA_SWAP_TARGET=running\nTUGRA_SWAP_TARGET_PORTS=bad,")).toBeNull();
  });
});

describe("swap state machine", () => {
  it("moves forward one step at a time and every non-final state can reverse", () => {
    expect(canSwapTransition("PLANNED", "STOPPING_SOURCE_PROXY")).toBe(true);
    expect(canSwapTransition("STOPPING_SOURCE_PROXY", "STARTING_TARGET_PROXY")).toBe(true);
    expect(canSwapTransition("STARTING_TARGET_PROXY", "LIVE")).toBe(true);
    expect(canSwapTransition("PLANNED", "LIVE")).toBe(false);
    for (const s of ["PLANNED", "STOPPING_SOURCE_PROXY", "STARTING_TARGET_PROXY", "LIVE"] as const) expect(canSwapTransition(s, "REVERSING")).toBe(true);
    expect(canSwapTransition("REVERSING", "REVERSED")).toBe(true);
  });

  it("REVERSED is final and LIVE never goes back to a forward state", () => {
    for (const s of SWAP_STATES) if (s !== "REVERSED") expect(canSwapTransition("REVERSED", s)).toBe(false);
    expect(canSwapTransition("LIVE", "STOPPING_SOURCE_PROXY")).toBe(false);
    expect(canSwapTransition("REVERSING", "LIVE")).toBe(false);
  });

  it("PLANNED and REVERSED are the only states before/after which no command was issued", () => {
    expect(SWAP_STATES.filter(swapIsPastPlanning)).toEqual(["STOPPING_SOURCE_PROXY", "STARTING_TARGET_PROXY", "LIVE", "REVERSING"]);
  });
});

describe("swapPlanHash", () => {
  const base = { runId: "r1", serverId: "s1", proxy: { containerId: ID, image: "traefik:v3.1", ports: ["443>443/tcp", "80>80/tcp"] }, hosts: [{ hostname: "b.example.com", stateful: true }, { hostname: "a.example.com", stateful: false }] };
  it("is stable under host and port order and changes with anything that was reviewed", () => {
    const h = swapPlanHash(base);
    expect(h).toMatch(/^[a-f0-9]{64}$/);
    expect(swapPlanHash({ ...base, hosts: [...base.hosts].reverse(), proxy: { ...base.proxy, ports: ["80>80/tcp", "443>443/tcp"] } })).toBe(h);
    expect(swapPlanHash({ ...base, proxy: { ...base.proxy, containerId: "b".repeat(64) } })).not.toBe(h);
    expect(swapPlanHash({ ...base, proxy: { ...base.proxy, image: "traefik:v3.2" } })).not.toBe(h);
    expect(swapPlanHash({ ...base, serverId: "s2" })).not.toBe(h);
    expect(swapPlanHash({ ...base, hosts: [...base.hosts, { hostname: "c.example.com", stateful: false }] })).not.toBe(h);
    expect(swapPlanHash({ ...base, hosts: [{ hostname: "b.example.com", stateful: false }, { hostname: "a.example.com", stateful: false }] })).not.toBe(h);
  });
});
