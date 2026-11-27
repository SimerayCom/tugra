import { ConfigService } from "@nestjs/config";
import { createHash, createPublicKey, verify } from "node:crypto";
import { TelemetryService, STATS_SIGNATURE_HEADER, PENDING_IDENTITY, type TelemetryPayload } from "./telemetry.service";
import type { CryptoService } from "../crypto/crypto.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { InstanceSettingsService } from "../instance/instance-settings.service";

const DEFAULT_URL = "https://api.tugra.io/v1/hubs/report";

// A settings double that behaves like the real singleton: get() returns the row, update() merges in place.
function makeSettings(initial: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id: "singleton",
    telemetryEnabled: true,
    hubPublicKey: null,
    hubPrivateKeyEnc: null,
    telemetryLastSentAt: null,
    ...initial,
  };
  return {
    row,
    get: jest.fn().mockImplementation(() => Promise.resolve(row)),
    update: jest.fn().mockImplementation((patch: Record<string, unknown>) => {
      Object.assign(row, patch);
      return Promise.resolve(row);
    }),
  } as unknown as InstanceSettingsService & { row: Record<string, unknown> };
}

// `settings` lets instanceSettings.updateMany mimic the atomic compare-and-set getIdentity relies on: it
// writes the key pair into the shared row ONLY while the private key is still null.
function makePrisma(counts = 0, settings?: { row: Record<string, unknown> }) {
  const count = () => jest.fn().mockResolvedValue(counts);
  return {
    $transaction: jest.fn().mockImplementation((arr: Promise<unknown>[]) => Promise.all(arr)),
    server: { count: count() },
    application: { count: count() },
    database: { count: count() },
    deployment: { count: count() },
    team: { count: count() },
    user: { count: count() },
    cluster: { count: count() },
    monitor: { count: count() },
    instanceSettings: {
      updateMany: jest.fn().mockImplementation(({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (settings && where.hubPrivateKeyEnc === null && settings.row.hubPrivateKeyEnc == null) {
          Object.assign(settings.row, data);
          return Promise.resolve({ count: 1 });
        }
        return Promise.resolve({ count: 0 });
      }),
    },
  } as unknown as PrismaService;
}

function makeConfig(env: Record<string, string | number> = {}) {
  const map: Record<string, string | number> = {
    TUGRA_STATS_URL: DEFAULT_URL,
    TUGRA_STATS_INTERVAL_MIN: 1440,
    ...env,
  };
  return { get: (k: string) => map[k] } as unknown as ConfigService;
}

// Stand-in for the secrets sealer: reversible, and visibly NOT the plaintext PEM.
const crypto = {
  encrypt: (s: string) => `sealed:${Buffer.from(s).toString("base64")}`,
  decrypt: (s: string) => Buffer.from(s.replace(/^sealed:/, ""), "base64").toString("utf8"),
} as unknown as CryptoService;

function make(config = makeConfig(), prismaCounts = 0, settings = makeSettings()) {
  return { svc: new TelemetryService(config, makePrisma(prismaCounts, settings), settings, crypto), settings };
}

describe("TelemetryService", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    delete (globalThis as { fetch?: unknown }).fetch;
  });

  it("isForcedOff reflects TUGRA_STATS=0 or the older TUGRA_TELEMETRY=0 only", () => {
    expect(make(makeConfig({ TUGRA_STATS: "0" })).svc.isForcedOff()).toBe(true);
    expect(make(makeConfig({ TUGRA_TELEMETRY: "0" })).svc.isForcedOff()).toBe(true);
    expect(make(makeConfig({ TUGRA_STATS: "1", TUGRA_TELEMETRY: "1" })).svc.isForcedOff()).toBe(false);
    expect(make(makeConfig({ TUGRA_STATS: "1", TUGRA_TELEMETRY: "0" })).svc.isForcedOff()).toBe(true); // either one wins
    expect(make().svc.isForcedOff()).toBe(false); // unset = not forced off
  });

  it("the default endpoint is api.tugra.io/v1/hubs/report; the older URL variable still overrides it", () => {
    expect(make().svc.endpoint()).toBe("https://api.tugra.io/v1/hubs/report");
    expect(make(makeConfig({ TUGRA_TELEMETRY_URL: "https://old.example.test/in" })).svc.endpoint()).toBe("https://old.example.test/in");
  });

  it("isEnabled is on by default (no env, db true) and off when EITHER switch is off", async () => {
    expect(await make().svc.isEnabled()).toBe(true);
    expect(await make(makeConfig({ TUGRA_STATS: "0" })).svc.isEnabled()).toBe(false); // env wins over a true toggle
    expect(await make(makeConfig(), 0, makeSettings({ telemetryEnabled: false })).svc.isEnabled()).toBe(false);
  });

  it("sendNow is a NO-OP that never touches the network (or creates a key) when disabled", async () => {
    const fetchMock = jest.fn();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    const { svc, settings } = make(makeConfig({ TUGRA_STATS: "0" }));
    expect(await svc.sendNow()).toEqual({ status: "disabled" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(settings.row.hubPrivateKeyEnc).toBeNull();
  });

  it("an owner opt-out in the UI sends nothing and creates no key", async () => {
    const fetchMock = jest.fn();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    const { svc, settings } = make(makeConfig(), 0, makeSettings({ telemetryEnabled: false }));
    expect(await svc.sendNow()).toEqual({ status: "disabled" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(settings.row.hubPrivateKeyEnc).toBeNull();
  });

  it("buildPayload matches the report contract and has no identifying field anywhere", async () => {
    const { svc } = make(makeConfig(), 3);
    const p = await svc.buildPayload();
    expect(Object.keys(p).sort()).toEqual(["counts", "features", "hubId", "publicKey", "sentAt", "v", "version"]);
    expect(p.v).toBe(1);
    expect(p.hubId).toMatch(/^[0-9a-f]{32}$/);
    expect(Buffer.from(p.publicKey, "base64url")).toHaveLength(32);
    expect(Object.keys(p.counts).sort()).toEqual(["applications", "databases", "servers", "services", "teams", "users"]);
    expect(p.counts.servers).toBe(3);
    expect(typeof p.features.nodeMajor).toBe("number");
    expect(new Date(p.sentAt).toISOString()).toBe(p.sentAt);
    const flat = JSON.stringify(p).toLowerCase();
    for (const banned of ["ip", "host", "domain", "email", "url", "hostname", "name", "secret", "token", "addr", "instanceid"]) {
      expect(flat).not.toContain(`"${banned}"`); // no PII-shaped KEY in the serialized payload
    }
  });

  it("hubId is the first 32 hex chars of sha256(raw public key), and the private key is stored sealed", async () => {
    const { svc, settings } = make();
    const id = await svc.getIdentity();
    const raw = Buffer.from(id.publicKey, "base64url");
    expect(id.hubId).toBe(createHash("sha256").update(raw).digest("hex").slice(0, 32));
    expect(String(settings.row.hubPrivateKeyEnc)).toMatch(/^sealed:/);
    expect(String(settings.row.hubPrivateKeyEnc)).not.toContain("PRIVATE KEY"); // not the plaintext PEM
    expect(settings.row.hubPublicKey).toBe(id.publicKey);
  });

  it("getIdentity generates once and is stable afterwards", async () => {
    const { svc } = make();
    const a = await svc.getIdentity();
    const b = await svc.getIdentity();
    expect(b.hubId).toBe(a.hubId);
    expect(b.publicKey).toBe(a.publicKey);
  });

  it("resetIdentity replaces the key pair with a new hubId", async () => {
    const { svc } = make();
    const before = await svc.getIdentity();
    const newId = await svc.resetIdentity();
    expect(newId).not.toBe(before.hubId);
    expect((await svc.getIdentity()).hubId).toBe(newId);
  });

  it("signing roundtrip: the signature verifies over the exact body bytes with the embedded public key", async () => {
    const { svc } = make(makeConfig(), 2);
    const payload = await svc.buildPayload();
    const { body, signature } = await svc.signPayload(payload);
    const parsed = JSON.parse(body) as TelemetryPayload;
    const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: parsed.publicKey }, format: "jwk" });
    expect(verify(null, Buffer.from(body, "utf8"), pub, Buffer.from(signature, "base64url"))).toBe(true);
    // any change to the body breaks it
    expect(verify(null, Buffer.from(body.replace('"servers":2', '"servers":3'), "utf8"), pub, Buffer.from(signature, "base64url"))).toBe(false);
  });

  it("sendNow posts the signed body to the default URL with the signature header and records lastSentAt on a 2xx", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 202 });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    const { svc, settings } = make();
    expect(await svc.sendNow()).toEqual({ status: "sent" });
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; headers: Record<string, string>; body: string }];
    expect(url).toBe(DEFAULT_URL);
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json");
    const parsed = JSON.parse(init.body) as TelemetryPayload;
    const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: parsed.publicKey }, format: "jwk" });
    expect(verify(null, Buffer.from(init.body, "utf8"), pub, Buffer.from(init.headers[STATS_SIGNATURE_HEADER], "base64url"))).toBe(true);
    expect(settings.row.telemetryLastSentAt).toBeInstanceOf(Date);
  });

  it("sendNow returns error (never throws, never records) on a network failure", async () => {
    (globalThis as { fetch?: unknown }).fetch = jest.fn().mockRejectedValue(new Error("offline"));
    const { svc, settings } = make();
    expect(await svc.sendNow()).toEqual({ status: "error" });
    expect(settings.row.telemetryLastSentAt).toBeNull();
  });

  it("sendNow returns error on a non-2xx (e.g. 409 key conflict) and does not record a send", async () => {
    (globalThis as { fetch?: unknown }).fetch = jest.fn().mockResolvedValue({ ok: false, status: 409 });
    const { svc, settings } = make();
    expect(await svc.sendNow()).toEqual({ status: "error" });
    expect(settings.row.telemetryLastSentAt).toBeNull();
  });

  it("status reports forcedOff with the toggle shown separately", async () => {
    const st = await make(makeConfig({ TUGRA_STATS: "0" })).svc.status();
    expect(st.forcedOff).toBe(true);
    expect(st.enabled).toBe(false); // env overrides
    expect(st.dbEnabled).toBe(true); // but the raw toggle is still surfaced
    expect(st.endpoint).toBe(DEFAULT_URL);
  });

  it("status() does NOT create the identity as a side effect (opening Settings creates nothing)", async () => {
    const { svc, settings } = make();
    const st = await svc.status();
    expect(st.hubId).toBeNull();
    expect(st.payload.hubId).toBe(PENDING_IDENTITY);
    expect(settings.row.hubPrivateKeyEnc).toBeNull();
    expect(settings.row.hubPublicKey).toBeNull();
  });

  it("status() shows the real hubId once the identity exists", async () => {
    const { svc } = make();
    const id = await svc.getIdentity();
    const st = await svc.status();
    expect(st.hubId).toBe(id.hubId);
    expect(st.payload.publicKey).toBe(id.publicKey);
  });

  it("sendNow NEVER throws: a DB error in isEnabled() fails closed to error with no network call", async () => {
    const fetchMock = jest.fn();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    const settings = { get: jest.fn().mockRejectedValue(new Error("db down")), update: jest.fn() } as unknown as InstanceSettingsService;
    const svc = new TelemetryService(makeConfig(), makePrisma(), settings, crypto);
    await expect(svc.sendNow()).resolves.toEqual({ status: "error" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sendNow still reports 'sent' when the lastSentAt write fails after a real 2xx (delivery wins)", async () => {
    const { svc, settings } = make();
    const realUpdate = settings.update as jest.Mock;
    realUpdate.mockRejectedValue(new Error("write blip"));
    (globalThis as { fetch?: unknown }).fetch = jest.fn().mockResolvedValue({ ok: true, status: 202 });
    expect(await svc.sendNow()).toEqual({ status: "sent" });
  });

  it("a runtime toggle flip between sends changes behaviour without a restart", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 202 });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    const { svc } = make();
    expect((await svc.sendNow()).status).toBe("sent");
    await svc.setEnabled(false); // owner opts out at runtime
    expect(await svc.sendNow()).toEqual({ status: "disabled" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
