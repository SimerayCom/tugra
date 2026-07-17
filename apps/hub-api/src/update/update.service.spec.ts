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
function manifest(entries: Record<string, { version: string }>): string {
  return JSON.stringify({ tugra: entries });
}

/** A mutable InstanceSettings stub with a jest-spied update(). */
function settingsStub(over: Partial<{ updateChannel: string; cachedLatestVersion: string | null; autoUpdate: boolean }> = {}) {
  const rec = { updateChannel: "stable", cachedLatestVersion: null as string | null, autoUpdate: false, ...over };
  const update = jest.fn(async (patch: Record<string, unknown>) => {
    Object.assign(rec, patch);
    return rec;
  });
  return { rec, service: { get: async () => rec, update } as unknown as import("../instance/instance-settings.service").InstanceSettingsService, update };
}

function configStub(vars: Record<string, string | undefined>): ConfigService {
  return { get: (k: string) => vars[k] } as unknown as ConfigService;
}

describe("UpdateService", () => {
  const { priv, pubB64 } = keypair();
  const CFG = { UPDATE_MANIFEST_URL: "https://get.tugra.io/versions.json", UPDATE_PUBLISHER_KEY: "" as string };
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
    expect(st.update).toHaveBeenCalledWith({ cachedLatestVersion: "0.2.0" });
    expect(st.rec.cachedLatestVersion).toBe("0.2.0");
  });

  it("DOWNGRADE GUARD: caches but reports updateAvailable=false when the manifest is OLDER than the running build", async () => {
    process.env.TUGRA_VERSION = "0.5.0";
    const raw = manifest({ stable: { version: "0.2.0" } });
    const { svc, st } = withManifest(raw, detachedSig(priv, raw));
    const res = await svc.checkRemote();
    expect(res).toMatchObject({ status: "ok", latest: "0.2.0", updateAvailable: false });
    expect(st.update).toHaveBeenCalledWith({ cachedLatestVersion: "0.2.0" }); // cache written, but no update offered
  });

  it("is non-destructive when the manifest lacks the tracked channel (keeps prior cache, no update)", async () => {
    const settings = settingsStub({ cachedLatestVersion: "0.1.0" });
    const raw = manifest({ beta: { version: "0.3.0-beta.1" } }); // no "stable" entry
    const { svc, st } = withManifest(raw, detachedSig(priv, raw), settings);
    const res = await svc.checkRemote();
    expect(res).toMatchObject({ status: "ok", channel: "stable", latest: "0.1.0" });
    expect(st.update).not.toHaveBeenCalled(); // prior cache preserved
    expect(st.rec.cachedLatestVersion).toBe("0.1.0");
  });

  it("does NOT cache an unparseable version (fail-safe, no update)", async () => {
    const raw = manifest({ stable: { version: "not-a-version" } });
    const { svc, st } = withManifest(raw, detachedSig(priv, raw));
    const res = await svc.checkRemote();
    expect(res).toMatchObject({ status: "ok", updateAvailable: false });
    expect(st.update).not.toHaveBeenCalled();
  });

  it("returns error and does not touch the cache on a bad signature", async () => {
    const other = keypair();
    const raw = manifest({ stable: { version: "9.9.9" } });
    const { svc, st } = withManifest(raw, detachedSig(other.priv, raw)); // signed by the WRONG key
    const res = await svc.checkRemote();
    expect(res).toEqual({ status: "error", reason: "bad signature" });
    expect(st.update).not.toHaveBeenCalled();
  });

  it("never throws when settings.get() fails — returns {status:error} (DB blip leaves cache untouched)", async () => {
    const st = settingsStub();
    (st.service.get as unknown) = jest.fn().mockRejectedValue(new Error("DB down"));
    const svc = new UpdateService(configStub(CFG), st.service);
    const res = await svc.checkRemote();
    expect(res).toEqual({ status: "error", reason: "settings" });
    expect(st.update).not.toHaveBeenCalled();
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
    expect(st.update).not.toHaveBeenCalled();
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
      updateAvailable: true,
      changelogUrl: "https://get.tugra.io/changelog",
      autoUpdate: false,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("getStatus with an empty cache reports latest=null, updateAvailable=false", async () => {
    const st = settingsStub();
    const svc = new UpdateService(configStub(CFG), st.service);
    const out = await svc.getStatus();
    expect(out).toMatchObject({ latest: null, updateAvailable: false, changelogUrl: null });
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
      expect(st.update).not.toHaveBeenCalled();
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
      expect(st.update).not.toHaveBeenCalled();
    });
  });
});
