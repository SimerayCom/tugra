import { ConfigService } from "@nestjs/config";
import { TelemetryService } from "./telemetry.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { InstanceSettingsService } from "../instance/instance-settings.service";

// A settings double that behaves like the real singleton: get() returns the row, update() merges in place.
function makeSettings(initial: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id: "singleton",
    telemetryEnabled: true,
    telemetryInstanceId: null,
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

// `settings` (optional) lets instanceSettings.updateMany mimic the atomic compare-and-set getInstanceId
// relies on: it writes the id into the shared row ONLY when still null (so re-reads are stable).
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
        if (settings && where.telemetryInstanceId === null && settings.row.telemetryInstanceId == null) {
          settings.row.telemetryInstanceId = data.telemetryInstanceId;
          return Promise.resolve({ count: 1 });
        }
        return Promise.resolve({ count: 0 });
      }),
    },
  } as unknown as PrismaService;
}

function makeConfig(env: Record<string, string | number> = {}) {
  const map: Record<string, string | number> = {
    TUGRA_TELEMETRY_URL: "https://telemetry.example.test/v1/ingest",
    TUGRA_TELEMETRY_INTERVAL_MIN: 1440,
    ...env,
  };
  return { get: (k: string) => map[k] } as unknown as ConfigService;
}

describe("TelemetryService", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    delete (globalThis as { fetch?: unknown }).fetch;
  });

  it("isForcedOff reflects TUGRA_TELEMETRY=0 only", () => {
    expect(new TelemetryService(makeConfig({ TUGRA_TELEMETRY: "0" }), makePrisma(), makeSettings()).isForcedOff()).toBe(true);
    expect(new TelemetryService(makeConfig({ TUGRA_TELEMETRY: "1" }), makePrisma(), makeSettings()).isForcedOff()).toBe(false);
    expect(new TelemetryService(makeConfig({}), makePrisma(), makeSettings()).isForcedOff()).toBe(false); // unset = not forced off
  });

  it("isEnabled is on by default (no env, db true) and off when EITHER switch is off", async () => {
    expect(await new TelemetryService(makeConfig(), makePrisma(), makeSettings()).isEnabled()).toBe(true);
    // env hard-off wins even when the db toggle is on
    expect(await new TelemetryService(makeConfig({ TUGRA_TELEMETRY: "0" }), makePrisma(), makeSettings({ telemetryEnabled: true })).isEnabled()).toBe(false);
    // owner toggle off
    expect(await new TelemetryService(makeConfig(), makePrisma(), makeSettings({ telemetryEnabled: false })).isEnabled()).toBe(false);
  });

  it("sendNow is a NO-OP that never touches the network when disabled (fail-closed)", async () => {
    const fetchMock = jest.fn();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    const svc = new TelemetryService(makeConfig({ TUGRA_TELEMETRY: "0" }), makePrisma(), makeSettings());
    expect(await svc.sendNow()).toEqual({ status: "disabled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("buildPayload contains ONLY anonymous aggregates — no IP/host/domain/email/name field anywhere", async () => {
    const svc = new TelemetryService(makeConfig(), makePrisma(3), makeSettings());
    const payload = await svc.buildPayload();
    expect(payload.instanceId).toMatch(/[0-9a-f-]{36}/); // a random uuid, not anything identifying
    expect(payload.counts.servers).toBe(3);
    expect(payload.counts.containers).toBe(6); // applications(3) + databases(3)
    expect(typeof payload.nodeMajor).toBe("number");
    const flat = JSON.stringify(payload).toLowerCase();
    for (const banned of ["ip", "host", "domain", "email", "url", "hostname", "name", "secret", "token", "addr"]) {
      // no PII-shaped KEY should appear in the serialized payload
      expect(flat).not.toContain(`"${banned}"`);
    }
  });

  it("getInstanceId mints once (atomic compare-and-set) and persists it, then is stable", async () => {
    const settings = makeSettings();
    const svc = new TelemetryService(makeConfig(), makePrisma(0, settings), settings);
    const a = await svc.getInstanceId();
    const b = await svc.getInstanceId();
    expect(a).toBe(b);
    expect(settings.row.telemetryInstanceId).toBe(a);
  });

  it("sendNow posts the payload and records lastSentAt on a 2xx", async () => {
    const settings = makeSettings();
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    const svc = new TelemetryService(makeConfig(), makePrisma(), settings);
    expect(await svc.sendNow()).toEqual({ status: "sent" });
    expect(fetchMock).toHaveBeenCalledWith("https://telemetry.example.test/v1/ingest", expect.objectContaining({ method: "POST" }));
    expect(settings.row.telemetryLastSentAt).toBeInstanceOf(Date);
  });

  it("sendNow returns error (never throws, never records) on a network failure", async () => {
    const settings = makeSettings();
    (globalThis as { fetch?: unknown }).fetch = jest.fn().mockRejectedValue(new Error("offline"));
    const svc = new TelemetryService(makeConfig(), makePrisma(), settings);
    expect(await svc.sendNow()).toEqual({ status: "error" });
    expect(settings.row.telemetryLastSentAt).toBeNull();
  });

  it("sendNow returns error on a non-2xx and does not record a send", async () => {
    const settings = makeSettings();
    (globalThis as { fetch?: unknown }).fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 });
    const svc = new TelemetryService(makeConfig(), makePrisma(), settings);
    expect(await svc.sendNow()).toEqual({ status: "error" });
    expect(settings.row.telemetryLastSentAt).toBeNull();
  });

  it("status reports forcedOff with the toggle shown separately", async () => {
    const svc = new TelemetryService(makeConfig({ TUGRA_TELEMETRY: "0" }), makePrisma(), makeSettings({ telemetryEnabled: true }));
    const st = await svc.status();
    expect(st.forcedOff).toBe(true);
    expect(st.enabled).toBe(false); // env overrides
    expect(st.dbEnabled).toBe(true); // but the raw toggle is still surfaced
  });

  it("status() does NOT mint an instance id as a side effect (opening Settings creates nothing)", async () => {
    const settings = makeSettings(); // telemetryInstanceId starts null
    const svc = new TelemetryService(makeConfig(), makePrisma(), settings);
    const st = await svc.status();
    expect(st.instanceId).toBeNull(); // still unminted
    expect(st.payload.instanceId).toBe("(generated on first send)"); // placeholder, not a real uuid
    expect(settings.row.telemetryInstanceId).toBeNull();
  });

  it("sendNow NEVER throws: a DB error in isEnabled() fails closed to error with no network call", async () => {
    const fetchMock = jest.fn();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    const settings = {
      get: jest.fn().mockRejectedValue(new Error("db down")),
      update: jest.fn(),
    } as unknown as InstanceSettingsService;
    const svc = new TelemetryService(makeConfig(), makePrisma(), settings);
    await expect(svc.sendNow()).resolves.toEqual({ status: "error" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sendNow still reports 'sent' when the lastSentAt write fails after a real 2xx (delivery wins)", async () => {
    const settings = makeSettings();
    (settings.update as jest.Mock).mockRejectedValue(new Error("write blip"));
    (globalThis as { fetch?: unknown }).fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const svc = new TelemetryService(makeConfig(), makePrisma(), settings);
    expect(await svc.sendNow()).toEqual({ status: "sent" });
  });

  it("a runtime toggle flip between sends changes behaviour without a restart", async () => {
    const settings = makeSettings({ telemetryEnabled: true });
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    const svc = new TelemetryService(makeConfig(), makePrisma(), settings);
    expect((await svc.sendNow()).status).toBe("sent");
    await svc.setEnabled(false); // owner opts out at runtime
    expect(await svc.sendNow()).toEqual({ status: "disabled" });
    expect(fetchMock).toHaveBeenCalledTimes(1); // the second send never hit the network
  });
});
