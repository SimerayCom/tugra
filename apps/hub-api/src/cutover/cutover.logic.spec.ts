import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CUTOVER_STATES, canTransition, caaAllowsLetsEncrypt, certNames, classifyHealth, classifyObserved, classifyPort80, counterpartOf, deriveEntries, effectiveTtl, isGeneratedHost,
  isStateful, keyMatchesCert, mergeAcmeStore, parseAcmeDiagMarkers, parseCutoverProbeMarkers, planHash, planRecords, recordSetKey, simulateApply, simulateRevert, sslModeVerdict,
  stepAction, ttlGuidance, earliestFlip, allNoop, sanitizeText,
  type CutoverState, type LedgerRecord, type ProviderRec,
} from "./cutover.logic";
import { shq } from "../deploy/deploy-script";
import { buildAcmeDiagScript, buildAcmeReadChunkScript, buildAcmeReadScript, buildAcmeWriteScript, buildCutoverLoopbackProbeScript, parseAcmeChunkOutput, parseAcmeReadOutput, parseAcmeSeedOutput } from "./cutover-scripts";

const T = { v4: ["203.0.113.7"], v6: [] as string[] };
const rec = (id: string, type: string, content: string, over: Partial<ProviderRec> = {}): ProviderRec => ({ id, type, name: "app.example.com", content, ttl: 3600, proxied: false, ...over });
const opts = { hostname: "app.example.com", targetTtl: 60, keepProxied: true, viaWildcard: false };

describe("state machine", () => {
  const LEGAL: Array<[CutoverState, CutoverState]> = [
    ["PLANNED", "CERT_PENDING"], ["PLANNED", "CERT_READY"], ["CERT_PENDING", "CERT_READY"], ["CERT_READY", "READY"], ["READY", "SWITCHING"], ["SWITCHING", "SWITCHED"],
    ["SWITCHED", "VERIFIED"], ["READY", "CERT_PENDING"], ["READY", "PLANNED"], ["SWITCHING", "READY"], ["SWITCHED", "VERIFY_FAILED"], ["VERIFY_FAILED", "SWITCHED"],
    ["SWITCHED", "REVERTING"], ["VERIFIED", "REVERTING"], ["VERIFY_FAILED", "REVERTING"], ["REVERTING", "ROLLED_BACK"], ["ROLLED_BACK", "PLANNED"],
    ["CERT_PENDING", "PLANNED"], ["CERT_READY", "PLANNED"], ["CERT_READY", "CERT_PENDING"], ["PLANNED", "BLOCKED"], ["READY", "EXCLUDED"], ["CERT_PENDING", "CONFLICT"], ["SWITCHING", "CONFLICT"],
  ];
  it.each(LEGAL)("allows %s -> %s", (a, b) => expect(canTransition(a, b)).toBe(true));
  it("allows nothing else (exhaustive table)", () => {
    const legal = new Set(LEGAL.map(([a, b]) => `${a}>${b}`));
    // the side-state fan-out from every pre-SWITCHING state, plus the few explicit extras
    const extra = new Set(["BLOCKED>PLANNED", "BLOCKED>EXCLUDED", "EXCLUDED>PLANNED", "CONFLICT>PLANNED", "CONFLICT>BLOCKED", "CONFLICT>EXCLUDED", "CONFLICT>REVERTING", "REVERTING>CONFLICT"]);
    for (const a of CUTOVER_STATES) for (const b of CUTOVER_STATES) {
      const side = ["BLOCKED", "EXCLUDED", "CONFLICT"].includes(b) && ["PLANNED", "CERT_PENDING", "CERT_READY", "READY"].includes(a);
      const expected = legal.has(`${a}>${b}`) || extra.has(`${a}>${b}`) || side;
      expect({ a, b, ok: canTransition(a, b) }).toEqual({ a, b, ok: expected });
    }
  });
  it("never reaches SWITCHING except from READY, and never skips the cert gate", () => {
    for (const a of CUTOVER_STATES) expect(canTransition(a, "SWITCHING")).toBe(a === "READY");
    expect(canTransition("PLANNED", "READY")).toBe(false);
    expect(canTransition("VERIFIED", "PLANNED")).toBe(false);
  });
});

describe("hostnames and entry derivation", () => {
  it("detects Coolify-generated hosts", () => {
    expect(isGeneratedHost("app-ek8c4gk8s8kwk8go4kwc4skc.sytrase.com")).toBe(true);
    expect(isGeneratedHost("api.sytrase.com")).toBe(false);
  });
  it("derives primary, alias and service hosts; excludes generated; blocks a cluster app", () => {
    const d = deriveEntries({ domain: "a.example.com", extraDomains: ["b.example.com", "app-ek8c4gk8s8kwk8go4kwc4skc.sytrase.com", "A.example.com"], clusterId: null }, ["svc.example.com", "bad host"]);
    expect(d.map((x) => [x.hostname, x.role, !!x.excluded])).toEqual([
      ["a.example.com", "primary", false], ["b.example.com", "alias", false], ["app-ek8c4gk8s8kwk8go4kwc4skc.sytrase.com", "alias", true], ["svc.example.com", "service", false],
    ]);
    expect(deriveEntries({ domain: "a.example.com", extraDomains: [], clusterId: "c1" }, [])[0].blockReason).toBe("cluster-app");
  });
  it("counterpart: zone-aware and heuristic", () => {
    expect(counterpartOf("example.com", "example.com")).toBe("www.example.com");
    expect(counterpartOf("www.example.com", "example.com")).toBe("example.com");
    expect(counterpartOf("app.example.com", "example.com")).toBeNull();
    expect(counterpartOf("example.com")).toBe("www.example.com");
    expect(counterpartOf("app.example.com")).toBeNull();
    expect(counterpartOf("www.example.com")).toBe("example.com");
  });
  it("stateful comes from the data tasks of the app's db/volume dependencies", () => {
    const app = { itemRef: "app:_:1", kind: "app", status: "DONE", dependsOn: ["database:_:9"] };
    expect(isStateful("app:_:1", [app])).toBe(true);
    expect(isStateful("app:_:1", [app, { itemRef: "data:database:_:9", kind: "data", status: "RUNNING", dependsOn: [] }])).toBe(true);
    expect(isStateful("app:_:1", [app, { itemRef: "data:database:_:9", kind: "data", status: "DONE", dependsOn: [] }])).toBe(false);
    expect(isStateful("app:_:2", [{ ...app, itemRef: "app:_:2", dependsOn: [] }])).toBe(false);
    const vol = { itemRef: "app:_:3", kind: "app", status: "DONE", dependsOn: ["volume:_:v1"] };
    expect(isStateful("app:_:3", [vol])).toBe(true);
    expect(isStateful("app:_:3", [vol, { itemRef: "data:vol:app:_:3:data", kind: "data", status: "DONE", dependsOn: [] }])).toBe(false);
  });
  it("counts the streamed (v2) data tasks: data:volume:<s>:<r>:<name> for app volumes, :data for a volume-mode Postgres", () => {
    const vx = { itemRef: "app:_:4", kind: "app", status: "DONE", dependsOn: ["database:_:9", "volume:_:v1"] };
    const dbVx = { itemRef: "data:volume:_:9:data", kind: "data", status: "DONE", dependsOn: [] };
    const volVx = { itemRef: "data:volume:_:4:data", kind: "data", status: "DONE", dependsOn: [] };
    expect(isStateful("app:_:4", [vx, dbVx, volVx])).toBe(false);
    expect(isStateful("app:_:4", [vx, { ...dbVx, status: "RUNNING" }, volVx])).toBe(true);
    expect(isStateful("app:_:4", [vx, dbVx, { ...volVx, status: "FAILED" }])).toBe(true);
    expect(isStateful("app:_:4", [vx, dbVx, { ...volVx, itemRef: "data:volume:_:5:data" }])).toBe(true); // another app's volume does not count
  });
});

describe("planRecords", () => {
  it("updates a same-name A in place, keeping the id and the proxied flag", () => {
    const r = planRecords([rec("r1", "A", "198.51.100.1", { proxied: true, ttl: 1 })], T, opts);
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]).toMatchObject({ recordId: "r1", type: "A", old: { content: "198.51.100.1", proxied: true }, new: { content: "203.0.113.7", proxied: true, ttl: 1 } });
    expect(r.warnings).toContain("proxied-kept");
  });
  it("keepProxied=false turns orange to grey explicitly", () => {
    const r = planRecords([rec("r1", "A", "198.51.100.1", { proxied: true, ttl: 1 })], T, { ...opts, keepProxied: false });
    expect(r.steps[0].new).toEqual({ content: "203.0.113.7", ttl: 60, proxied: false });
    expect(r.warnings).toContain("proxied-dropped");
  });
  it("uses the target TTL for an unproxied record", () => {
    expect(planRecords([rec("r1", "A", "198.51.100.1")], T, opts).steps[0].new).toEqual({ content: "203.0.113.7", ttl: 60, proxied: false });
  });
  it("deletes a stale AAAA when the target has no IPv6, and updates it when it has", () => {
    const before = [rec("a", "A", "198.51.100.1"), rec("q", "AAAA", "2001:db8::1")];
    const r = planRecords(before, T, opts);
    expect(r.steps.find((s) => s.type === "AAAA")).toMatchObject({ recordId: "q", new: null, old: { content: "2001:db8::1" } });
    expect(r.warnings).toContain("stale-aaaa-deleted");
    const v6 = planRecords(before, { v4: T.v4, v6: ["2001:db8::7"] }, opts);
    expect(v6.steps.find((s) => s.type === "AAAA")).toMatchObject({ recordId: "q", new: { content: "2001:db8::7" } });
  });
  it("replaces a CNAME with A records (delete first)", () => {
    const r = planRecords([rec("c", "CNAME", "old.other.net")], T, opts);
    expect(r.steps.map((s) => [s.type, stepAction(s)])).toEqual([["CNAME", "delete"], ["A", "create"]]);
    expect(r.warnings).toContain("cname-replaced");
  });
  it("blocks a tunnel CNAME and a target without IPv4", () => {
    expect(planRecords([rec("c", "CNAME", "abc.cfargotunnel.com", { proxied: true })], T, opts).blocked).toBe("tunnel-routed");
    expect(planRecords([rec("a", "A", "198.51.100.1")], { v4: [], v6: [] }, opts).blocked).toBe("no-target-ip");
  });
  it("creates an explicit record for a wildcard-only host", () => {
    const r = planRecords([], T, { ...opts, viaWildcard: true });
    expect(r.steps).toEqual([{ type: "A", name: "app.example.com", recordId: null, old: null, new: { content: "203.0.113.7", ttl: 60, proxied: false }, written: false }]);
    expect(r.warnings).toContain("wildcard-explicit-record");
  });
  it("round-robin: updates, creates and deletes to match the target set", () => {
    const before = [rec("a", "A", "198.51.100.1"), rec("b", "A", "198.51.100.2"), rec("c", "A", "198.51.100.3")];
    const r = planRecords(before, { v4: ["203.0.113.7", "203.0.113.8"], v6: [] }, opts);
    expect(r.steps.map((s) => stepAction(s)).sort()).toEqual(["delete", "update", "update"]);
    expect(r.warnings).toContain("surplus-a-deleted");
    const grow = planRecords([rec("a", "A", "198.51.100.1")], { v4: ["203.0.113.7", "203.0.113.8"], v6: [] }, opts);
    expect(grow.steps.map((s) => stepAction(s)).sort()).toEqual(["create", "update"]);
  });
  it("is a noop when the records already match", () => {
    const r = planRecords([rec("a", "A", "203.0.113.7", { ttl: 60 })], T, opts);
    expect(allNoop(r.steps)).toBe(true);
  });
  it("never touches TXT/MX/CAA records at the name", () => {
    const r = planRecords([rec("a", "A", "198.51.100.1"), rec("t", "TXT", "v=spf1 -all"), rec("m", "MX", "mail.example.com")], T, opts);
    expect(r.steps.every((s) => ["A", "AAAA", "CNAME"].includes(s.type))).toBe(true);
    expect(r.steps.some((s) => s.recordId === "t" || s.recordId === "m")).toBe(false);
  });
  it("property: apply then revert is byte-identical for generated record sets", () => {
    const ips4 = ["198.51.100.1", "198.51.100.2", "203.0.113.7"];
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    for (let i = 0; i < 300; i++) {
      const before: ProviderRec[] = [];
      const kind = rnd(4);
      if (kind === 0) before.push(rec("c0", "CNAME", "old.other.net", { ttl: [1, 300, 3600][rnd(3)], proxied: rnd(2) === 1 }));
      else for (let k = 0; k < rnd(4); k++) before.push(rec(`a${k}`, "A", ips4[rnd(3)], { ttl: [1, 300, 3600][rnd(3)], proxied: rnd(2) === 1 }));
      if (kind !== 0 && rnd(2)) before.push(rec("aaaa", "AAAA", "2001:db8::1"));
      const target = { v4: rnd(2) ? ["203.0.113.7"] : ["203.0.113.7", "203.0.113.8"], v6: rnd(3) === 0 ? ["2001:db8::7"] : [] };
      const r = planRecords(before, target, { ...opts, keepProxied: rnd(2) === 1, viaWildcard: before.length === 0 });
      if (r.blocked) continue;
      const steps: LedgerRecord[] = r.steps.map((s) => ({ ...s, written: true }));
      const applied = simulateApply(before, steps);
      expect(recordSetKey(simulateRevert(applied, steps))).toBe(recordSetKey(before));
    }
  });
});

describe("planHash", () => {
  const steps = (content = "198.51.100.1"): LedgerRecord[] => planRecords([rec("a", "A", content)], T, opts).steps;
  const base = (over = {}) => planHash("op1", { targetTtl: 60, keepProxied: true }, [{ id: "e2", hostname: "b", steps: steps() }, { id: "e1", hostname: "a", steps: steps() }, ...(Object.keys(over).length ? [] : [])]);
  it("is deterministic, order-insensitive and sensitive to old content / ttl / target", () => {
    const a = planHash("op1", { targetTtl: 60, keepProxied: true }, [{ id: "e1", hostname: "a", steps: steps() }, { id: "e2", hostname: "b", steps: steps() }]);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(base()).toBe(a);
    expect(planHash("op1", { targetTtl: 60, keepProxied: true }, [{ id: "e1", hostname: "a", steps: steps("198.51.100.9") }, { id: "e2", hostname: "b", steps: steps() }])).not.toBe(a);
    expect(planHash("op1", { targetTtl: 120, keepProxied: true }, [{ id: "e1", hostname: "a", steps: steps() }, { id: "e2", hostname: "b", steps: steps() }])).not.toBe(a);
    expect(planHash("op2", { targetTtl: 60, keepProxied: true }, [{ id: "e1", hostname: "a", steps: steps() }, { id: "e2", hostname: "b", steps: steps() }])).not.toBe(a);
    expect(planHash("op1", { targetTtl: 60, keepProxied: false }, [{ id: "e1", hostname: "a", steps: steps() }, { id: "e2", hostname: "b", steps: steps() }])).not.toBe(a);
    const s = steps();
    s[0] = { ...s[0], recordId: "other" };
    expect(planHash("op1", { targetTtl: 60, keepProxied: true }, [{ id: "e1", hostname: "a", steps: s }, { id: "e2", hostname: "b", steps: steps() }])).not.toBe(a);
  });
});

describe("probe classification", () => {
  it.each([
    [200, false, true, "ok"], [301, false, true, "redirect"], [401, false, true, "auth"], [403, false, true, "auth"], [404, false, true, "app-404"],
    [404, true, false, "traefik-404"], [502, false, false, "server-error"], [503, false, false, "server-error"], [null, false, false, "unreachable"], [418, false, false, "other"],
  ])("status %s traefik404=%s", (status, t, pass, kind) => expect(classifyHealth(status as number | null, t)).toMatchObject({ pass, kind }));
  it("port 80 must redirect to https", () => {
    expect(classifyPort80(301, "https://a.com/")).toBe(true);
    expect(classifyPort80(200, null)).toBe(false);
    expect(classifyPort80(301, "http://a.com/")).toBe(false);
  });
  it("observed DNS classes", () => {
    expect(classifyObserved(["203.0.113.7"], T, { proxied: false, tunnel: false })).toBe("target");
    expect(classifyObserved(["198.51.100.1"], T, { proxied: false, tunnel: false })).toBe("source");
    expect(classifyObserved(["198.51.100.1", "203.0.113.7"], T, { proxied: false, tunnel: false })).toBe("mixed");
    expect(classifyObserved([], T, { proxied: false, tunnel: false })).toBe("unknown");
    expect(classifyObserved(["104.16.0.1"], T, { proxied: true, tunnel: false })).toBe("proxied");
    expect(classifyObserved(["104.16.0.1"], T, { proxied: true, tunnel: true })).toBe("tunnel");
  });
  it("Cloudflare SSL mode verdicts", () => {
    expect([sslModeVerdict("strict"), sslModeVerdict("full"), sslModeVerdict("flexible"), sslModeVerdict("off"), sslModeVerdict("unknown"), sslModeVerdict(null)]).toEqual(["ok", "weak", "bad", "bad", "unknown", "unknown"]);
  });
  it("CAA policy", () => {
    expect(caaAllowsLetsEncrypt([])).toBe(true);
    expect(caaAllowsLetsEncrypt(['0 issue "letsencrypt.org"'])).toBe(true);
    expect(caaAllowsLetsEncrypt(['0 issue "digicert.com"'])).toBe(false);
    expect(caaAllowsLetsEncrypt(['0 issuewild "digicert.com"'])).toBe(true);
    expect(caaAllowsLetsEncrypt(['0 issue "digicert.com"', '0 issue "letsencrypt.org; validationmethods=dns-01"'])).toBe(true);
  });
});

describe("marker parsers and scripts", () => {
  it("only an anchored marker line counts", () => {
    expect(parseCutoverProbeMarkers("noise\nTUGRA_CUTOVER_PROBE status=204\n")).toEqual({ status: 204 });
    expect(parseCutoverProbeMarkers("TUGRA_CUTOVER_PROBE status=000")).toEqual({ status: null });
    expect(parseCutoverProbeMarkers("x TUGRA_CUTOVER_PROBE status=200")).toBeNull();
    expect(parseCutoverProbeMarkers("TUGRA_CUTOVER_PROBE status=200 trailing")).toBeNull();
    expect(parseAcmeDiagMarkers("TUGRA_ACME_HAS host=a.example.com n=2\nTUGRA_ACME_ERR=unable to obtain\nxTUGRA_ACME_ERR=forged")).toEqual({ has: 2, err: "unable to obtain" });
    expect(parseAcmeDiagMarkers("TUGRA_ACME_HAS host=A;rm n=2")).toEqual({ has: null, err: null });
  });
  it("quotes hostile input and carries no response body", () => {
    const evil = "a.com'; rm -rf / #";
    const s = buildCutoverLoopbackProbeScript({ host: evil, path: "/x" });
    expect(s).toContain(`H=${shq(evil)}`);
    expect(s).not.toMatch(/-o -\b/);
    expect(buildAcmeDiagScript(evil)).toContain(`H=${shq(evil)}`);
  });
  it("acme read/write scripts", () => {
    expect(buildAcmeReadScript()).toContain("docker stop tugra-proxy");
    expect(parseAcmeReadOutput("TUGRA_ACME_SIZE=5\nTUGRA_ACME_B64_BEGIN\naGVs\nbG8=\nTUGRA_ACME_B64_END\n")).toEqual({ size: 5, b64: "aGVsbG8=", tooBig: false });
    expect(parseAcmeReadOutput("TUGRA_ACME_SIZE=900000\nTUGRA_ACME_TOOBIG")).toMatchObject({ tooBig: true });
    expect(parseAcmeReadOutput("TUGRA_ACME_SIZE=0")).toEqual({ size: 0, b64: null, tooBig: false });
    expect(parseAcmeReadOutput("nothing")).toBeNull();
    expect(() => buildAcmeWriteScript("not base64!", 1)).toThrow();
    const w = buildAcmeWriteScript("aGVsbG8=", 2);
    expect(w).toContain("chmod 600");
    expect(w).toContain("mv /etc/tugra/letsencrypt/acme.json.tmp /etc/tugra/letsencrypt/acme.json");
    expect(parseAcmeSeedOutput(w.split("\n").pop()!.replace(/^echo "|"$/g, ""))).toBe(2);
  });
  it("acme read fails closed on a truncated, short or unchecked output", () => {
    // the agent cut the output: BEGIN without END, with its truncation marker
    expect(parseAcmeReadOutput("TUGRA_ACME_SIZE=90000\nTUGRA_ACME_B64_BEGIN\nAAAA\n…(truncated)")).toBeNull();
    expect(parseAcmeReadOutput("TUGRA_ACME_SIZE=5\nTUGRA_ACME_B64_BEGIN\naGVs")).toBeNull();
    // decoded length differs from the probed size
    expect(parseAcmeReadOutput("TUGRA_ACME_SIZE=9\nTUGRA_ACME_B64_BEGIN\naGVsbG8=\nTUGRA_ACME_B64_END")).toBeNull();
    // a non-empty file with neither a body nor a checksum is never "absent"
    expect(parseAcmeReadOutput("TUGRA_ACME_SIZE=5")).toBeNull();
    expect(parseAcmeReadOutput(`TUGRA_ACME_SIZE=5\nTUGRA_ACME_SHA256=${"a".repeat(64)}`)).toBeNull(); // small files must carry the body
    // a big store is announced bodiless with its checksum, to be read in chunks
    expect(parseAcmeReadOutput(`TUGRA_ACME_SIZE=90000\nTUGRA_ACME_SHA256=${"a".repeat(64)}`)).toEqual({ size: 90000, b64: null, tooBig: false, sha256: "a".repeat(64) });
    expect(buildAcmeReadScript()).toContain("TUGRA_ACME_SHA256");
  });
  it("acme chunk scripts: bounded range in, complete chunk out", () => {
    expect(buildAcmeReadChunkScript(36864, 100)).toContain("tail -c +36865 /etc/tugra/letsencrypt/acme.json | head -c 100 | base64");
    expect(() => buildAcmeReadChunkScript(-1, 10)).toThrow();
    expect(() => buildAcmeReadChunkScript(0, 0)).toThrow();
    expect(() => buildAcmeReadChunkScript(0, 36 * 1024 + 1)).toThrow();
    expect(parseAcmeChunkOutput("aGVsbG8=\nTUGRA_ACME_CHUNK_END\n")?.toString()).toBe("hello");
    expect(parseAcmeChunkOutput("aGVsbG8=\n…(truncated)")).toBeNull();
    expect(parseAcmeChunkOutput("aGVsbG8=")).toBeNull();
    expect(parseAcmeChunkOutput("not base64!\nTUGRA_ACME_CHUNK_END")).toBeNull();
  });
});

describe("ttl math", () => {
  it("auto counts as 300 s, a day stays a day, flip waits one old TTL", () => {
    expect(effectiveTtl(1)).toBe(300);
    expect(effectiveTtl(86400)).toBe(86400);
    const flip = new Date("2026-11-20T12:00:00Z");
    const g = ttlGuidance(86400, flip);
    expect(g.waitSeconds).toBe(86400);
    expect(g.lowerBefore.toISOString()).toBe(new Date(flip.getTime() - (86400 + 600) * 1000).toISOString());
    expect(g.floor).toBe(60);
    const lowered = new Date("2026-11-20T10:00:00Z");
    expect(earliestFlip(lowered, 3600, false).toISOString()).toBe("2026-11-20T11:00:00.000Z");
    expect(earliestFlip(lowered, 3600, true).toISOString()).toBe(lowered.toISOString());
    expect(earliestFlip(lowered, 1, false).toISOString()).toBe("2026-11-20T10:05:00.000Z");
  });
  it("sanitizes to printable ASCII", () => {
    expect(sanitizeText("a\u0000b\ncé", 10)).toBe("a b c");
  });
});

describe("acme.json merge + cert helpers", () => {
  let dir: string;
  const pem = (name: string, days: number) => {
    const key = path.join(dir, `${name}.key`);
    const crt = path.join(dir, `${name}.crt`);
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", crt, "-days", String(days), "-subj", `/CN=${name}`, "-addext", `subjectAltName=DNS:${name},DNS:www.${name}`], { stdio: "ignore" });
    return { certPem: fs.readFileSync(crt, "utf8"), keyPem: fs.readFileSync(key, "utf8") };
  };
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cutover-acme-"));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("keeps the target's Account and unknown keys, appends seeded certs, adds no Account when absent", () => {
    const s = pem("a.example.com", 90);
    const existing = JSON.stringify({ le: { Account: { Email: "x@y.z", marker: "keep" }, Certificates: [], extra: 1 }, other: { a: 1 } });
    const m = mergeAcmeStore(existing, [{ main: "a.example.com", sans: ["www.a.example.com"], ...s }], "le");
    const out = JSON.parse(m.json);
    expect(m.added).toBe(1);
    expect(out.le.Account.marker).toBe("keep");
    expect(out.le.extra).toBe(1);
    expect(out.other).toEqual({ a: 1 });
    expect(out.le.Certificates[0]).toMatchObject({ domain: { main: "a.example.com", sans: ["www.a.example.com"] }, Store: "default" });
    expect(Buffer.from(out.le.Certificates[0].certificate, "base64").toString()).toBe(s.certPem);
    const fresh = JSON.parse(mergeAcmeStore(null, [{ main: "a.example.com", ...s }], "le").json);
    expect(fresh.le.Account).toBeUndefined();
    expect(fresh.le.Certificates).toHaveLength(1);
  });
  it("skips short-lived certs and keeps the later notAfter on a duplicate main", () => {
    const shortLived = pem("s.example.com", 5);
    expect(mergeAcmeStore(null, [{ main: "s.example.com", ...shortLived }], "le").skipped).toEqual([{ main: "s.example.com", reason: "short-lived" }]);
    const longer = pem("d.example.com", 200);
    const shorter = pem("d.example.com", 60);
    const first = mergeAcmeStore(null, [{ main: "d.example.com", ...shorter }], "le").json;
    const replaced = mergeAcmeStore(first, [{ main: "d.example.com", ...longer }], "le");
    expect(replaced.added).toBe(1);
    expect(JSON.parse(replaced.json).le.Certificates).toHaveLength(1);
    const kept = mergeAcmeStore(replaced.json, [{ main: "d.example.com", ...shorter }], "le");
    expect(kept.added).toBe(0);
    expect(kept.skipped[0].reason).toBe("older-than-existing");
  });
  it("refuses to overwrite a corrupt existing file", () => {
    expect(() => mergeAcmeStore("{not json", [], "le")).toThrow();
    expect(() => mergeAcmeStore("[1]", [], "le")).toThrow();
  });
  it("key matching and names", () => {
    const a = pem("m.example.com", 90);
    const b = pem("n.example.com", 90);
    expect(keyMatchesCert(a.certPem, a.keyPem)).toBe(true);
    expect(keyMatchesCert(a.certPem, b.keyPem)).toBe(false);
    expect(keyMatchesCert("junk", "junk")).toBe(false);
    expect(certNames(a.certPem).sort()).toEqual(["m.example.com", "www.m.example.com"]);
  });
});
