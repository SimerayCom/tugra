import { BadRequestException } from "@nestjs/common";
import { HubDeadmanService, FAIL_ALERT_STREAK } from "./hub-deadman.service";
import { assertPingUrl, pingHostHint, pingOnce } from "./hub-deadman-ping";

const NOW = new Date("2026-12-03T12:00:00Z");
const min = (n: number) => new Date(NOW.getTime() - n * 60_000);

function make(cfg: Record<string, unknown> | null) {
  const state = { row: cfg };
  const update = jest.fn(async ({ data }: { data: Record<string, unknown> }) => { state.row = { ...state.row, ...data }; return state.row; });
  const upsert = jest.fn(async ({ create, update: u }: { create: Record<string, unknown>; update: Record<string, unknown> }) => { state.row = { ...(state.row ?? create), ...u }; return state.row; });
  const prisma = {
    hubDeadmanConfig: { findUnique: jest.fn(async () => state.row), update, upsert },
    server: { findFirst: jest.fn().mockResolvedValue({ teamId: "t1" }) },
  };
  const crypto = { encrypt: (v: string) => `enc(${v})`, decrypt: (v: string) => v.replace(/^enc\((.*)\)$/, "$1") };
  const notifications = { fireForEvent: jest.fn().mockResolvedValue(undefined) };
  const svc = new HubDeadmanService(prisma as never, { log: jest.fn() } as never, crypto as never, notifications as never);
  const ping = jest.fn().mockResolvedValue({ ok: true, status: 200, error: null });
  svc.ping = ping;
  return { svc, update, upsert, notifications, ping, state };
}

const base = { id: "singleton", enabled: true, urlEnc: "enc(https://hc.example.com/ping/secret-token)", intervalMinutes: 5, lastTickAt: min(1), lastPingAt: min(6), lastOkAt: min(6), lastError: null, failStreak: 0, alertedAt: null };

describe("HubDeadmanService.tick", () => {
  it("does nothing while switched off", async () => {
    const t = make({ ...base, enabled: false });
    await t.svc.tick(NOW);
    expect(t.ping).not.toHaveBeenCalled();
    expect(t.update).not.toHaveBeenCalled();
  });

  it("pings when due and records the success", async () => {
    const t = make(base);
    await t.svc.tick(NOW);
    expect(t.ping).toHaveBeenCalledWith("https://hc.example.com/ping/secret-token");
    expect(t.update.mock.calls[0][0].data).toMatchObject({ lastOkAt: NOW, failStreak: 0, lastError: null });
    expect(t.notifications.fireForEvent).not.toHaveBeenCalled();
  });

  it("only ticks (no ping) when the next check-in is not due yet", async () => {
    const t = make({ ...base, lastPingAt: min(1) });
    await t.svc.tick(NOW);
    expect(t.ping).not.toHaveBeenCalled();
    expect(t.update.mock.calls[0][0].data).toEqual({ lastTickAt: NOW });
  });

  it("says so through the notification path after a gap longer than three intervals (the hub was down)", async () => {
    const t = make({ ...base, lastTickAt: min(40) });
    await t.svc.tick(NOW);
    expect(t.notifications.fireForEvent).toHaveBeenCalledWith("t1", "hub_outage", { kind: "gap", minutes: "40" });
    expect(t.ping).toHaveBeenCalled(); // checks in immediately after coming back
  });

  it("alerts once when check-ins keep failing, and clears on recovery", async () => {
    const t = make({ ...base, failStreak: FAIL_ALERT_STREAK - 1 });
    t.ping.mockResolvedValue({ ok: false, status: null, error: "unreachable" });
    await t.svc.tick(NOW);
    expect(t.notifications.fireForEvent).toHaveBeenCalledWith("t1", "hub_outage", { kind: "failing", failures: String(FAIL_ALERT_STREAK) });
    expect(t.update.mock.calls[0][0].data).toMatchObject({ failStreak: FAIL_ALERT_STREAK, lastError: "unreachable", alertedAt: NOW });
    // the next failed tick does not repeat the alert
    t.notifications.fireForEvent.mockClear();
    await t.svc.tick(new Date(NOW.getTime() + 6 * 60_000));
    expect(t.notifications.fireForEvent).not.toHaveBeenCalled();
    // recovery resets the streak and re-arms the alert
    t.ping.mockResolvedValue({ ok: true, status: 200, error: null });
    await t.svc.tick(new Date(NOW.getTime() + 12 * 60_000));
    expect(t.state.row).toMatchObject({ failStreak: 0, alertedAt: null });
  });
});

describe("HubDeadmanService config", () => {
  it("encrypts the address, never returns it, and shows only the host", async () => {
    const t = make(null);
    const v = await t.svc.update("u1", { enabled: true, intervalMinutes: 5, url: "https://hc.example.com/ping/secret-token" });
    expect(t.upsert.mock.calls[0][0].create.urlEnc).toBe("enc(https://hc.example.com/ping/secret-token)");
    expect(v.urlHost).toBe("hc.example.com");
    expect(JSON.stringify(v)).not.toContain("secret-token");
  });
  it("refuses to turn on without an address and refuses blocked addresses", async () => {
    await expect(make(null).svc.update("u1", { enabled: true, intervalMinutes: 5 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(make(null).svc.update("u1", { enabled: true, intervalMinutes: 5, url: "http://169.254.169.254/latest" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(make(null).svc.update("u1", { enabled: true, intervalMinutes: 5, url: "http://127.0.0.1:9/x" })).rejects.toBeInstanceOf(BadRequestException);
  });
  it("keeps the stored address when url is absent and clears it on null", async () => {
    const t = make(base);
    await t.svc.update("u1", { enabled: false, intervalMinutes: 10 });
    expect(t.upsert.mock.calls[0][0].update.urlEnc).toBe(base.urlEnc);
    await t.svc.update("u1", { enabled: false, intervalMinutes: 10, url: null });
    expect(t.upsert.mock.calls[1][0].update.urlEnc).toBeNull();
  });
});

describe("ping helpers", () => {
  it("assertPingUrl applies the SSRF guard", () => {
    expect(() => assertPingUrl("https://hc.example.com/x")).not.toThrow();
    expect(() => assertPingUrl("http://[::1]/x")).toThrow();
    expect(() => assertPingUrl("ftp://example.com/x")).toThrow();
    expect(() => assertPingUrl("https://user:pw@example.com/x")).toThrow();
  });
  it("pingHostHint returns the host only", () => {
    expect(pingHostHint("https://hc.example.com:8443/ping/token?x=1")).toBe("hc.example.com:8443");
    expect(pingHostHint("nope")).toBeNull();
  });
  it("pingOnce refuses a blocked address without a request and never echoes the URL", async () => {
    const r = await pingOnce("http://127.0.0.1:1/token-xyz");
    expect(r).toEqual({ ok: false, status: null, error: "invalid-url" });
  });
});
