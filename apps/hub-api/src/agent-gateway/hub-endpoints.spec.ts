import { createPublicKey, verify, sign, generateKeyPairSync } from "node:crypto";
import { canonicalHubEndpoints, canonicalHubProof } from "@tugra/shared";
import { HubSigningService } from "./hub-signing.service";
import {
  GRACE_MAX_MS,
  RevClock,
  domainEndpoint,
  graceActive,
  graceRoutes,
  ipEndpoint,
  newGrace,
  normalizeEndpoints,
  parseGrace,
  serializeEndpoints,
  summarizeMove,
} from "./hub-endpoints";

const PIN = "sha256:" + "ab".repeat(32);

describe("endpoint list shape", () => {
  it("builds wss endpoints: a domain without a pin, an IP always pinned", () => {
    expect(domainEndpoint("app.example.com")).toEqual({ url: "wss://app.example.com/agent" });
    expect(ipEndpoint("203.0.113.7", PIN)).toEqual({ url: "wss://203.0.113.7/agent", pin: PIN });
    expect(() => ipEndpoint("203.0.113.7", "sha256:zz")).toThrow(/pin/);
    expect(() => ipEndpoint("example.com", PIN)).toThrow(/IPv4/);
  });

  it("normalizes: de-dups by url (first wins), keeps order, refuses what the agent would refuse", () => {
    const out = normalizeEndpoints([domainEndpoint("a.example.com"), ipEndpoint("203.0.113.7", PIN), domainEndpoint("a.example.com")]);
    expect(out.map((e) => e.url)).toEqual(["wss://a.example.com/agent", "wss://203.0.113.7/agent"]);
    expect(() => normalizeEndpoints([])).toThrow(/empty/);
    expect(() => normalizeEndpoints([{ url: "ws://a.example.com/agent" }])).toThrow(/wss/);
    expect(() => normalizeEndpoints([{ url: "wss://203.0.113.7/agent" }])).toThrow(/pin/);
    expect(() => normalizeEndpoints([{ url: "wss://u:p@a.example.com/agent" }])).toThrow(/credentials/);
    expect(() => normalizeEndpoints([{ url: "not a url" }])).toThrow();
  });

  it("serializes to the stable JSON array that is signed byte-for-byte", () => {
    expect(serializeEndpoints([ipEndpoint("203.0.113.7", PIN)])).toBe(`[{"url":"wss://203.0.113.7/agent","pin":"${PIN}"}]`);
  });
});

describe("RevClock", () => {
  it("is strictly increasing, even within one millisecond or when the clock stalls", () => {
    const c = new RevClock();
    const a = c.next(1000);
    const b = c.next(1000);
    const d = c.next(500);
    expect(b).toBeGreaterThan(a);
    expect(d).toBeGreaterThan(b);
    expect(c.next(5000)).toBe(5000);
  });
});

describe("signing (hub_endpoints / hubProof)", () => {
  const svc = new HubSigningService();
  const pub = createPublicKey({ key: Buffer.from(svc.publicKeySpkiBase64, "base64"), format: "der", type: "spki" });
  const check = (canonical: string, sig: string) => verify(null, Buffer.from(canonical), pub, Buffer.from(sig, "base64"));

  it("a signed list verifies for its own server+rev+bytes and for nothing else", () => {
    const json = serializeEndpoints([domainEndpoint("new.example.com")]);
    const sig = svc.sign(canonicalHubEndpoints("srvA", 123, json));
    expect(check(canonicalHubEndpoints("srvA", 123, json), sig)).toBe(true);
    expect(check(canonicalHubEndpoints("srvB", 123, json), sig)).toBe(false); // replay to another server
    expect(check(canonicalHubEndpoints("srvA", 124, json), sig)).toBe(false); // bumped rev
    expect(check(canonicalHubEndpoints("srvA", 123, serializeEndpoints([domainEndpoint("evil.example.com")])), sig)).toBe(false);
  });

  it("a forged signature (another key) does not verify", () => {
    const evil = generateKeyPairSync("ed25519").privateKey;
    const sig = sign(null, Buffer.from(canonicalHubEndpoints("srvA", 1, "[]")), evil).toString("base64");
    expect(check(canonicalHubEndpoints("srvA", 1, "[]"), sig)).toBe(false);
  });

  it("the identity proof is bound to the challenge AND the agent's nonce", () => {
    const sig = svc.sign(canonicalHubProof("challenge-1", "agent-nonce-aaaaaaaa"));
    expect(check(canonicalHubProof("challenge-1", "agent-nonce-aaaaaaaa"), sig)).toBe(true);
    expect(check(canonicalHubProof("challenge-2", "agent-nonce-aaaaaaaa"), sig)).toBe(false);
    expect(check(canonicalHubProof("challenge-1", "agent-nonce-bbbbbbbb"), sig)).toBe(false);
  });
});

describe("grace", () => {
  const T0 = 1_700_000_000_000;
  const primary = domainEndpoint("new.example.com");

  it("keeps the old domain and the IP route for /agent while active, and never longer than 7 days", () => {
    const g = newGrace(primary, [domainEndpoint("old.example.com"), ipEndpoint("203.0.113.7", PIN), primary], T0, 30 * 24 * 3600_000);
    expect(g.expiresAt - g.startedAt).toBe(GRACE_MAX_MS);
    expect(g.fallbacks.map((f) => f.url)).toEqual(["wss://old.example.com/agent", "wss://203.0.113.7/agent"]); // primary not duplicated
    expect(graceRoutes(g, T0 + 1)).toEqual({ hosts: ["old.example.com"], ip: true });
  });

  it("an IP primary does not make the IP route a 'grace' of its own", () => {
    const g = newGrace(ipEndpoint("203.0.113.7", PIN), [domainEndpoint("old.example.com")], T0);
    expect(graceRoutes(g, T0 + 1)).toEqual({ hosts: ["old.example.com"], ip: true }); // the IP is the destination: the proxy keeps its /agent route
  });

  it("ends on expiry or when the owner confirms; before that it is active", () => {
    const g = newGrace(primary, [domainEndpoint("old.example.com")], T0);
    expect(graceActive(g, T0 + 1000)).toBe(true);
    expect(graceActive(g, g.expiresAt)).toBe(false);
    expect(graceActive({ ...g, confirmedAt: T0 + 5 }, T0 + 10)).toBe(false);
    expect(graceRoutes({ ...g, confirmedAt: T0 + 5 }, T0 + 10)).toEqual({ hosts: [], ip: false });
    expect(graceRoutes(null, T0)).toEqual({ hosts: [], ip: false });
  });

  it("parses the JSON column defensively", () => {
    const g = newGrace(primary, [domainEndpoint("old.example.com")], T0);
    expect(parseGrace(JSON.parse(JSON.stringify(g)))).toEqual(g);
    for (const bad of [null, undefined, 5, {}, { v: 2 }, { ...g, primary: { url: "ws://x/agent" } }, { ...g, startedAt: "x" }]) {
      expect(parseGrace(bad)).toBeNull();
    }
  });
});

describe("summarizeMove", () => {
  const want = "wss://new.example.com/agent";
  it("moved = reports the new endpoint; the rest are listed with why", () => {
    const r = summarizeMove(want, [
      { id: "1", name: "web-1", online: true, supported: true, active: want, error: null },
      { id: "2", name: "web-2", online: true, supported: true, active: "wss://old.example.com/agent", error: null },
      { id: "3", name: "web-3", online: false, supported: false, active: "wss://old.example.com/agent", error: null },
      { id: "4", name: "web-4", online: true, supported: false, active: null, error: null },
      { id: "5", name: "web-5", online: true, supported: true, active: "wss://old.example.com/agent", error: "hub endpoint is plain ws://" },
    ]);
    expect(r.total).toBe(5);
    expect(r.moved).toBe(1);
    expect(r.pending.map((p) => [p.id, p.reason])).toEqual([["2", "waiting"], ["3", "offline"], ["4", "old_agent"], ["5", "waiting"]]);
    expect(r.pending[3]!.error).toContain("plain ws");
  });
});
