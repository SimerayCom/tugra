import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { UpdateService } from "./update.service";
import { MAX_MANIFEST_BYTES, MAX_SIG_BYTES } from "./update-manifest";

function keypair(): { priv: KeyObject; pubB64: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { priv: privateKey, pubB64: publicKey.export({ format: "der", type: "spki" }).toString("base64") };
}
function detachedSig(priv: KeyObject, raw: string): string {
  return sign(null, Buffer.from(raw), priv).toString("base64");
}
function manifest(entries: Record<string, { version: string }>, notice?: unknown): string {
  return JSON.stringify(notice === undefined ? { tugra: entries } : { tugra: entries, notice });
}

/** A mutable InstanceSettings stub with a jest-spied update(). */
function settingsStub(
  over: Partial<{
    updateChannel: string | null;
    cachedLatestVersion: string | null;
    cachedLatestChannel: string | null;
    autoUpdate: boolean;
    cachedNotice: unknown;
    updateLastCheckedAt: Date | null;
    updateLastCheckError: string | null;
  }> = {},
) {
  // updateChannel defaults to an explicit "stable" pin so the pre-existing stable-manifest cases keep their
  // meaning; the auto-channel cases pass `updateChannel: null`.
  const rec = {
    updateChannel: "stable" as string | null,
    cachedLatestVersion: null as string | null,
    cachedLatestChannel: null as string | null,
    autoUpdate: false,
    cachedNotice: null as unknown,
    updateLastCheckedAt: null as Date | null,
    updateLastCheckError: null as string | null,
    ...over,
  };
  const update = jest.fn(async (patch: Record<string, unknown>) => {
    Object.assign(rec, patch);
    return rec;
  });
  return { rec, service: { get: async () => rec, update } as unknown as import("../instance/instance-settings.service").InstanceSettingsService, update };
}

function configStub(vars: Record<string, string | number | undefined>): ConfigService {
  return { get: (k: string) => vars[k] } as unknown as ConfigService;
}

describe("UpdateService", () => {
  const { priv, pubB64 } = keypair();
  const CFG: Record<string, string | number | undefined> = { UPDATE_MANIFEST_URL: "https://get.tugra.io/versions.json", UPDATE_PUBLISHER_KEY: "" };
  const savedVersion = process.env.TUGRA_VERSION;

  beforeEach(() => {
    CFG.UPDATE_PUBLISHER_KEY = pubB64;
    delete process.env.TUGRA_VERSION; // appVersion() → "0.0.0-dev"
  });
  afterEach(() => {
    if (savedVersion === undefined) delete process.env.TUGRA_VERSION;
    else process.env.TUGRA_VERSION = savedVersion;
    jest.restoreAllMocks();
  });

  /** Wire a service with fetchText spied to serve a given manifest/sig by URL suffix. */
  function withManifest(raw: string, sig: string, settings = settingsStub(), cfg = CFG) {
    const st = settings;
    const svc = new UpdateService(configStub(cfg), st.service);
    jest.spyOn(svc as unknown as { fetchText: (u: string) => Promise<string> }, "fetchText").mockImplementation(
      async (url: string) => (url.endsWith(".sig") ? sig : raw),
    );
    return { svc, st };
  }

  it("returns unconfigured (and never fetches) when URL/key are unset", async () => {
    const st = settingsStub();
    const svc = new UpdateService(configStub({}), st.service);
    const spy = jest.spyOn(svc as unknown as { fetchText: () => Promise<string> }, "fetchText");
    expect(await svc.checkRemote()).toEqual({ status: "unconfigured" });
    expect(spy).not.toHaveBeenCalled();
    expect(st.update).not.toHaveBeenCalled();
  });

  it("caches latest and reports updateAvailable=true when the manifest is newer", async () => {
    const raw = manifest({ stable: { version: "0.2.0" } });
    const { svc, st } = withManifest(raw, detachedSig(priv, raw));
    const res = await svc.checkRemote();
    expect(res).toMatchObject({ status: "ok", channel: "stable", latest: "0.2.0", updateAvailable: true });
    expect(st.update).toHaveBeenCalledWith(expect.objectContaining({ cachedLatestVersion: "0.2.0" }));
    expect(st.rec.cachedLatestVersion).toBe("0.2.0");
  });

  it("DOWNGRADE GUARD: caches but reports updateAvailable=false when the manifest is OLDER than the running build", async () => {
    process.env.TUGRA_VERSION = "0.5.0";
    const raw = manifest({ stable: { version: "0.2.0" } });
    const { svc, st } = withManifest(raw, detachedSig(priv, raw));
    const res = await svc.checkRemote();
    expect(res).toMatchObject({ status: "ok", latest: "0.2.0", updateAvailable: false });
    expect(st.update).toHaveBeenCalledWith(expect.objectContaining({ cachedLatestVersion: "0.2.0" })); // cache written, but no update offered
  });

  it("is non-destructive when the manifest lacks the tracked channel (keeps prior cache, no update)", async () => {
    const settings = settingsStub({ cachedLatestVersion: "0.1.0" });
    const raw = manifest({ beta: { version: "0.3.0-beta.1" } }); // no "stable" entry
    const { svc, st } = withManifest(raw, detachedSig(priv, raw), settings);
    const res = await svc.checkRemote();
    expect(res).toMatchObject({ status: "ok", channel: "stable", latest: "0.1.0" });
    // version cache preserved (a notice-only persist may still run, but never touches cachedLatestVersion)
    expect(st.update).not.toHaveBeenCalledWith(expect.objectContaining({ cachedLatestVersion: expect.anything() }));
    expect(st.rec.cachedLatestVersion).toBe("0.1.0");
  });

  it("does NOT cache an unparseable version (fail-safe, no update)", async () => {
    const raw = manifest({ stable: { version: "not-a-version" } });
    const { svc, st } = withManifest(raw, detachedSig(priv, raw));
    const res = await svc.checkRemote();
    expect(res).toMatchObject({ status: "ok", updateAvailable: false });
    expect(st.update).not.toHaveBeenCalledWith(expect.objectContaining({ cachedLatestVersion: expect.anything() }));
  });

  it("returns error and does not touch the cache on a bad signature", async () => {
    const other = keypair();
    const raw = manifest({ stable: { version: "9.9.9" } });
    const { svc, st } = withManifest(raw, detachedSig(other.priv, raw)); // signed by the WRONG key
    const res = await svc.checkRemote();
    expect(res).toEqual({ status: "error", reason: "bad signature" });
    expect(st.update).not.toHaveBeenCalledWith(expect.objectContaining({ cachedLatestVersion: expect.anything() }));
    expect(st.rec.updateLastCheckError).toBe("bad signature");
    expect(st.rec.updateLastCheckedAt).toBeNull();
  });

  it("never throws when settings.get() fails — returns {status:error} (DB blip leaves cache untouched)", async () => {
    const st = settingsStub();
    (st.service.get as unknown) = jest.fn().mockRejectedValue(new Error("DB down"));
    const svc = new UpdateService(configStub(CFG), st.service);
    const res = await svc.checkRemote();
    expect(res).toEqual({ status: "error", reason: "settings" });
    expect(st.update).not.toHaveBeenCalledWith(expect.objectContaining({ cachedLatestVersion: expect.anything() })); // cache untouched
  });

  it("never throws when settings.update() fails — returns {status:error}", async () => {
    const st = settingsStub();
    st.update.mockRejectedValueOnce(new Error("write failed"));
    const raw = manifest({ stable: { version: "0.2.0" } });
    const svc = new UpdateService(configStub(CFG), st.service);
    jest.spyOn(svc as unknown as { fetchText: (u: string) => Promise<string> }, "fetchText").mockImplementation(
      async (url: string) => (url.endsWith(".sig") ? detachedSig(priv, raw) : raw),
    );
    const res = await svc.checkRemote();
    expect(res).toEqual({ status: "error", reason: "persist" });
  });

  it("never throws on a fetch failure — returns {status:error}", async () => {
    const st = settingsStub();
    const svc = new UpdateService(configStub(CFG), st.service);
    jest.spyOn(svc as unknown as { fetchText: () => Promise<string> }, "fetchText").mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await svc.checkRemote();
    expect(res).toEqual({ status: "error", reason: "fetch" });
    expect(st.update).not.toHaveBeenCalledWith(expect.objectContaining({ cachedLatestVersion: expect.anything() }));
  });

  it("getStatus reads cache + running version WITHOUT any remote fetch", async () => {
    const st = settingsStub({ cachedLatestVersion: "0.2.0" });
    const svc = new UpdateService(configStub({ ...CFG, UPDATE_CHANGELOG_URL: "https://get.tugra.io/changelog" }), st.service);
    const spy = jest.spyOn(svc as unknown as { fetchText: () => Promise<string> }, "fetchText");
    const out = await svc.getStatus();
    expect(out).toEqual({
      current: "0.0.0-dev",
      latest: "0.2.0",
      channel: "stable",
      channelSource: "explicit",
      updateAvailable: true,
      changelogUrl: "https://get.tugra.io/changelog",
      autoUpdate: false,
      notice: null,
      checksEnabled: true,
      checkIntervalMin: 60,
      lastCheckedAt: null,
      lastCheckError: null,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("getMemberVersion exposes only version/channel/latest/updateAvailable (no preferences or notice)", async () => {
    const st = settingsStub({ cachedLatestVersion: "0.2.0", autoUpdate: true });
    const svc = new UpdateService(configStub({ ...CFG, UPDATE_CHANGELOG_URL: "https://get.tugra.io/changelog" }), st.service);
    const out = await svc.getMemberVersion();
    expect(out).toEqual({ current: "0.0.0-dev", latest: "0.2.0", channel: "stable", updateAvailable: true });
  });

  it("getStatus exposes the channel source, interval, last-check time and last error", async () => {
    const at = new Date("2026-11-15T10:00:00.000Z");
    const st = settingsStub({ updateChannel: null, updateLastCheckedAt: at, updateLastCheckError: "fetch" });
    const svc = new UpdateService(configStub({ ...CFG, UPDATE_CHECK_INTERVAL_MIN: 15 }), st.service);
    const out = await svc.getStatus();
    expect(out).toMatchObject({ channel: "beta", channelSource: "auto", checksEnabled: true, lastCheckedAt: at.toISOString(), lastCheckError: "fetch" });
    expect(out.checkIntervalMin).toBe(15);
  });

  it("getStatus reports checksEnabled=false when hard-off or unconfigured", async () => {
    const st = settingsStub();
    expect((await new UpdateService(configStub({ ...CFG, TUGRA_UPDATE_CHECKS: "0" }), st.service).getStatus()).checksEnabled).toBe(false);
    expect((await new UpdateService(configStub({}), st.service).getStatus()).checksEnabled).toBe(false);
  });

  it("getStatus with an empty cache reports latest=null, updateAvailable=false", async () => {
    const st = settingsStub();
    const svc = new UpdateService(configStub(CFG), st.service);
    const out = await svc.getStatus();
    expect(out).toMatchObject({ latest: null, updateAvailable: false, changelogUrl: null, notice: null });
  });

  it("caches a signed notice and surfaces it in getStatus", async () => {
    const notice = { id: "n1", message: "beta.2 fixes X", severity: "warning", url: "https://tugra.io/x" };
    const raw = manifest({ stable: { version: "0.2.0" } }, notice);
    const { svc, st } = withManifest(raw, detachedSig(priv, raw));
    await svc.checkRemote();
    expect(st.update).toHaveBeenCalledWith(expect.objectContaining({ cachedNotice: notice }));
    const out = await svc.getStatus();
    expect(out.notice).toEqual({ id: "n1", message: "beta.2 fixes X", severity: "warning", url: "https://tugra.io/x" });
  });

  it("clears the cached notice when the manifest carries none", async () => {
    const settings = settingsStub({ cachedNotice: { id: "old", message: "x", severity: "info" } });
    const raw = manifest({ stable: { version: "0.2.0" } }); // no notice
    const { svc } = withManifest(raw, detachedSig(priv, raw), settings);
    await svc.checkRemote();
    expect((await svc.getStatus()).notice).toBeNull();
  });

  it("surfaces a notice even when the tracked channel has no entry", async () => {
    const notice = { id: "n2", message: "maintenance window tonight", severity: "info" };
    const raw = manifest({ beta: { version: "0.3.0-beta.1" } }, notice); // no "stable" entry
    const { svc, st } = withManifest(raw, detachedSig(priv, raw));
    await svc.checkRemote();
    expect(st.rec.cachedNotice).toEqual(notice);
    expect((await svc.getStatus()).notice).toMatchObject({ id: "n2", severity: "info" });
  });

  it("getStatus drops an expired notice", async () => {
    const st = settingsStub({ cachedNotice: { id: "old", message: "x", severity: "info", expiresAt: "2000-01-01T00:00:00Z" } });
    const svc = new UpdateService(configStub(CFG), st.service);
    expect((await svc.getStatus()).notice).toBeNull();
  });

  it("getStatus ignores a malformed cached notice", async () => {
    const st = settingsStub({ cachedNotice: { message: 123 } });
    const svc = new UpdateService(configStub(CFG), st.service);
    expect((await svc.getStatus()).notice).toBeNull();
  });

  describe("hard off + automatic channel", () => {
    it("TUGRA_UPDATE_CHECKS=0 returns unconfigured and never fetches, even with URL + key set", async () => {
      const st = settingsStub();
      const svc = new UpdateService(configStub({ ...CFG, TUGRA_UPDATE_CHECKS: "0" }), st.service);
      const spy = jest.spyOn(svc as unknown as { fetchText: () => Promise<string> }, "fetchText");
      expect(svc.isForcedOff()).toBe(true);
      expect(svc.isConfigured()).toBe(false);
      expect(await svc.checkRemote()).toEqual({ status: "unconfigured" });
      expect(await svc.verifyLatestEntry()).toEqual({ status: "unconfigured" });
      expect(spy).not.toHaveBeenCalled();
      expect(st.update).not.toHaveBeenCalled();
    });

    it("a key without a URL is unconfigured, not forced off", () => {
      const svc = new UpdateService(configStub({ UPDATE_PUBLISHER_KEY: pubB64 }), settingsStub().service);
      expect(svc.isForcedOff()).toBe(false);
      expect(svc.isConfigured()).toBe(false);
    });

    it("a beta build with updateChannel=null reads the beta entry", async () => {
      process.env.TUGRA_VERSION = "0.1.0-beta.16";
      const raw = manifest({ beta: { version: "0.1.0-beta.17" } });
      const { svc } = withManifest(raw, detachedSig(priv, raw), settingsStub({ updateChannel: null }));
      expect(await svc.checkRemote()).toMatchObject({ status: "ok", channel: "beta", latest: "0.1.0-beta.17", updateAvailable: true });
      expect(await svc.verifyLatestEntry()).toMatchObject({ status: "ok", channel: "beta" });
    });

    it("a stable build with updateChannel=null reads the stable entry", async () => {
      process.env.TUGRA_VERSION = "0.1.0";
      const raw = manifest({ stable: { version: "0.1.1" }, beta: { version: "0.2.0-beta.1" } });
      const { svc } = withManifest(raw, detachedSig(priv, raw), settingsStub({ updateChannel: null }));
      expect(await svc.checkRemote()).toMatchObject({ status: "ok", channel: "stable", latest: "0.1.1", updateAvailable: true });
    });

    it("an explicit stable pin on a beta build reads stable (no entry -> keeps the cache)", async () => {
      process.env.TUGRA_VERSION = "0.1.0-beta.16";
      const raw = manifest({ beta: { version: "0.1.0-beta.17" } });
      const settings = settingsStub({ updateChannel: "stable", cachedLatestVersion: "0.1.0-beta.16" });
      const { svc, st } = withManifest(raw, detachedSig(priv, raw), settings);
      expect(await svc.checkRemote()).toMatchObject({ status: "ok", channel: "stable", latest: "0.1.0-beta.16", updateAvailable: false });
      expect(st.rec.cachedLatestVersion).toBe("0.1.0-beta.16");
    });

    it("the \"auto\" sentinel stored in the DB is automatic, not a pin named auto", async () => {
      process.env.TUGRA_VERSION = "0.1.0-beta.16";
      const raw = manifest({ beta: { version: "0.1.0-beta.17" } });
      const { svc, st } = withManifest(raw, detachedSig(priv, raw), settingsStub({ updateChannel: "auto" }));
      expect(await svc.checkRemote()).toMatchObject({ status: "ok", channel: "beta", latest: "0.1.0-beta.17", updateAvailable: true });
      expect(st.rec.cachedLatestChannel).toBe("beta");
      expect(await svc.getStatus()).toMatchObject({ channel: "beta", channelSource: "auto" });
    });

    it("a cache read from another channel is ignored after the owner pins Stable (no beta advertised forever)", async () => {
      process.env.TUGRA_VERSION = "0.1.0-beta.16";
      // The auto (beta) channel cached beta.17; then the owner pinned Stable, which has no manifest entry yet.
      const settings = settingsStub({ updateChannel: "stable", cachedLatestVersion: "0.1.0-beta.17", cachedLatestChannel: "beta" });
      const raw = manifest({ beta: { version: "0.1.0-beta.17" } });
      const { svc } = withManifest(raw, detachedSig(priv, raw), settings);
      expect(await svc.getStatus()).toMatchObject({ channel: "stable", channelSource: "explicit", latest: null, updateAvailable: false });
      expect(await svc.checkRemote()).toMatchObject({ status: "ok", channel: "stable", updateAvailable: false });
      // …while a cache with no recorded channel (pre-bookkeeping rows) is still honoured
      const legacy = settingsStub({ updateChannel: "stable", cachedLatestVersion: "0.2.0", cachedLatestChannel: null });
      const { svc: svc2 } = withManifest(raw, detachedSig(priv, raw), legacy);
      expect(await svc2.getStatus()).toMatchObject({ latest: "0.2.0", updateAvailable: true });
    });
  });

  describe("last-check bookkeeping", () => {
    it("a successful check stamps updateLastCheckedAt and clears updateLastCheckError", async () => {
      const raw = manifest({ stable: { version: "0.2.0" } });
      const settings = settingsStub({ updateLastCheckError: "fetch" });
      const { svc, st } = withManifest(raw, detachedSig(priv, raw), settings);
      const before = Date.now();
      await svc.checkRemote();
      expect(st.rec.updateLastCheckError).toBeNull();
      expect(st.rec.updateLastCheckedAt).toBeInstanceOf(Date);
      expect((st.rec.updateLastCheckedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
      expect(st.update).toHaveBeenCalledTimes(1); // folded into the existing write, no extra round trip
    });

    it("stamps on the no-entry branch too (the check itself worked)", async () => {
      const raw = manifest({ beta: { version: "0.3.0-beta.1" } }); // no stable entry
      const settings = settingsStub({ updateLastCheckError: "fetch" });
      const { svc, st } = withManifest(raw, detachedSig(priv, raw), settings);
      await svc.checkRemote();
      expect(st.rec.updateLastCheckedAt).toBeInstanceOf(Date);
      expect(st.rec.updateLastCheckError).toBeNull();
    });

    it("stamps when the signed entry has an unparseable version (verify still succeeded)", async () => {
      const raw = manifest({ stable: { version: "nope" } });
      const { svc, st } = withManifest(raw, detachedSig(priv, raw));
      await svc.checkRemote();
      expect(st.rec.updateLastCheckedAt).toBeInstanceOf(Date);
    });

    it("a failed fetch records updateLastCheckError='fetch' and leaves updateLastCheckedAt untouched", async () => {
      const prior = new Date("2026-11-01T00:00:00Z");
      const st = settingsStub({ updateLastCheckedAt: prior });
      const svc = new UpdateService(configStub(CFG), st.service);
      jest.spyOn(svc as unknown as { fetchText: () => Promise<string> }, "fetchText").mockRejectedValue(new Error("ECONNREFUSED"));
      expect(await svc.checkRemote()).toEqual({ status: "error", reason: "fetch" });
      expect(st.update).toHaveBeenCalledWith({ updateLastCheckError: "fetch" });
      expect(st.rec.updateLastCheckedAt).toBe(prior);
    });

    it("a failing error-write never throws", async () => {
      const st = settingsStub();
      st.update.mockRejectedValue(new Error("db down"));
      const svc = new UpdateService(configStub(CFG), st.service);
      jest.spyOn(svc as unknown as { fetchText: () => Promise<string> }, "fetchText").mockRejectedValue(new Error("ECONNREFUSED"));
      await expect(svc.checkRemote()).resolves.toEqual({ status: "error", reason: "fetch" });
    });

    it("a synchronously-throwing error-write never throws either", async () => {
      const st = settingsStub();
      st.update.mockImplementation(() => {
        throw new Error("boom");
      });
      const svc = new UpdateService(configStub(CFG), st.service);
      jest.spyOn(svc as unknown as { fetchText: () => Promise<string> }, "fetchText").mockRejectedValue(new Error("x"));
      await expect(svc.checkRemote()).resolves.toEqual({ status: "error", reason: "fetch" });
    });
  });

  describe("refreshIfStale (panel-load refresh)", () => {
    function make(cfg: Record<string, string | number | undefined> = CFG) {
      const svc = new UpdateService(configStub(cfg), settingsStub().service);
      let release: (r: { status: "unconfigured" }) => void = () => undefined;
      const pending = new Promise<{ status: "unconfigured" }>((res) => {
        release = res;
      });
      const check = jest.spyOn(svc, "checkRemote").mockReturnValue(pending);
      return { svc, check, release };
    }
    const FRESH = () => new Date(Date.now() - 5 * 60_000).toISOString();
    const STALE = () => new Date(Date.now() - 2 * 60 * 60_000).toISOString();

    it("never checked (null) -> exactly one checkRemote", () => {
      const { svc, check } = make();
      svc.refreshIfStale(null);
      expect(check).toHaveBeenCalledTimes(1);
    });

    it("an older-than-interval timestamp -> one checkRemote", () => {
      const { svc, check } = make();
      svc.refreshIfStale(STALE());
      expect(check).toHaveBeenCalledTimes(1);
    });

    it("an unparseable timestamp counts as stale (fail toward checking)", () => {
      const { svc, check } = make();
      svc.refreshIfStale("not-a-date");
      expect(check).toHaveBeenCalledTimes(1);
    });

    it("five synchronous calls (five open tabs) -> one checkRemote", () => {
      const { svc, check } = make();
      for (let i = 0; i < 5; i++) svc.refreshIfStale(null);
      expect(check).toHaveBeenCalledTimes(1);
    });

    it("a fresh timestamp -> zero calls", () => {
      const { svc, check } = make();
      svc.refreshIfStale(FRESH());
      expect(check).not.toHaveBeenCalled();
    });

    it("stale again within the 5-minute gap (after the first settled) -> still one call; after the gap -> a second", async () => {
      const t0 = 1_800_000_000_000;
      const now = jest.spyOn(Date, "now").mockReturnValue(t0);
      const svc = new UpdateService(configStub(CFG), settingsStub().service);
      const check = jest.spyOn(svc, "checkRemote").mockResolvedValue({ status: "unconfigured" });
      svc.refreshIfStale(null);
      await new Promise((r) => setImmediate(r)); // let the first attempt settle so only the gap can block
      now.mockReturnValue(t0 + 4 * 60_000);
      svc.refreshIfStale(null);
      expect(check).toHaveBeenCalledTimes(1);
      now.mockReturnValue(t0 + 5 * 60_000);
      svc.refreshIfStale(null);
      expect(check).toHaveBeenCalledTimes(2);
    });

    it("hard-off or unconfigured -> zero calls", () => {
      const off = make({ ...CFG, TUGRA_UPDATE_CHECKS: "0" });
      off.svc.refreshIfStale(null);
      expect(off.check).not.toHaveBeenCalled();
      const none = make({});
      none.svc.refreshIfStale(null);
      expect(none.check).not.toHaveBeenCalled();
    });

    it("returns before the fetch resolves (fire-and-forget) and swallows a rejection", async () => {
      const svc = new UpdateService(configStub(CFG), settingsStub().service);
      let settled = false;
      jest.spyOn(svc, "checkRemote").mockImplementation(
        () =>
          new Promise((_, reject) => {
            setTimeout(() => {
              settled = true;
              reject(new Error("late"));
            }, 5);
          }),
      );
      expect(svc.refreshIfStale(null)).toBeUndefined();
      expect(settled).toBe(false); // the method returned while the check is still pending
      await new Promise((r) => setTimeout(r, 15)); // no unhandled rejection
      expect(settled).toBe(true);
    });

    it("lets another refresh start once the in-flight one has settled (after the gap)", async () => {
      const t0 = 1_800_000_000_000;
      const now = jest.spyOn(Date, "now").mockReturnValue(t0);
      const { svc, check, release } = make();
      svc.refreshIfStale(null);
      now.mockReturnValue(t0 + 6 * 60_000);
      svc.refreshIfStale(null); // still in flight -> blocked
      expect(check).toHaveBeenCalledTimes(1);
      release({ status: "unconfigured" });
      await new Promise((r) => setImmediate(r));
      svc.refreshIfStale(null);
      expect(check).toHaveBeenCalledTimes(2);
    });
  });

  describe("streaming size-cap (real global.fetch)", () => {
    const savedFetch = global.fetch;
    afterEach(() => {
      global.fetch = savedFetch;
    });
    function streamResponse(body: string): Response {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(body));
          c.close();
        },
      });
      return new Response(stream, { status: 200 }); // no content-length → cap must bound the READ itself
    }

    it("aborts and errors when the MANIFEST streams past MAX_MANIFEST_BYTES", async () => {
      global.fetch = jest.fn(async () => streamResponse("x".repeat(MAX_MANIFEST_BYTES + 10))) as unknown as typeof fetch;
      const st = settingsStub();
      const svc = new UpdateService(configStub(CFG), st.service);
      const res = await svc.checkRemote();
      expect(res).toEqual({ status: "error", reason: "fetch" });
      expect(st.update).not.toHaveBeenCalledWith(expect.objectContaining({ cachedLatestVersion: expect.anything() }));
    });

    it("aborts and errors when the .sig streams past MAX_SIG_BYTES", async () => {
      const good = manifest({ stable: { version: "0.2.0" } });
      global.fetch = jest.fn(async (url: string | URL | Request) =>
        String(url).endsWith(".sig") ? streamResponse("A".repeat(MAX_SIG_BYTES + 10)) : streamResponse(good),
      ) as unknown as typeof fetch;
      const st = settingsStub();
      const svc = new UpdateService(configStub(CFG), st.service);
      const res = await svc.checkRemote();
      expect(res).toEqual({ status: "error", reason: "fetch" });
      expect(st.update).not.toHaveBeenCalledWith(expect.objectContaining({ cachedLatestVersion: expect.anything() }));
    });
  });
});
